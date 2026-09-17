/**
 * Généré depuis vellum-pdf/src/lib/verifsig.ts — ne pas éditer ici.
 * Source de vérité : le dépôt privé vellum-pdf, via scripts/sync-engine.mjs.
 */

/**
 * Vérification des signatures cryptographiques d'un PDF — en lecture seule.
 *
 * Rien n'est modifié ni réenregistré : le document est lu tel quel, et chaque
 * signature est recalculée à partir des octets réellement scellés (son
 * /ByteRange), exactement comme le signataire les a calculés.
 *
 * Trois limites sont assumées, et dites telles quelles dans l'interface :
 *
 *  1. Un navigateur n'a pas de magasin d'autorités de confiance. On peut donc
 *     établir que la signature est mathématiquement correcte et que le
 *     document n'a pas bougé, jamais que l'autorité émettrice est reconnue.
 *     Le rapport dit « chaîne non vérifiable », jamais « certificat invalide ».
 *  2. Des octets après la dernière plage signée signifient une mise à jour
 *     incrémentale (deuxième signature, champ rempli, annotation ajoutée) —
 *     pas une falsification.
 *  3. La révocation (CRL, OCSP) n'est pas interrogée : cela supposerait
 *     d'appeler des serveurs tiers depuis la page.
 *
 * Module lourd (pkijs, asn1js) : chargé à la demande par la page de l'outil.
 */
import * as asn1js from 'asn1js'
import * as pkijs from 'pkijs'
import type { PDFRef } from 'pdf-lib'
import { chargerPdfLib } from './bibliotheques.ts'
import { looksEncrypted } from './qpdf.ts'
import {
  lireChaine,
  lireNom,
  octetsApres,
  octetsSignes,
  parserDatePdf,
  trouverSignatures,
} from './pdfsig.ts'

const OID_ATTR_MESSAGE_DIGEST = '1.2.840.113549.1.9.4'
const OID_ATTR_SIGNING_TIME = '1.2.840.113549.1.9.5'
const OID_ATTR_SIGNATURE_TIMESTAMP = '1.2.840.113549.1.9.16.2.14'
const OID_ATTR_SIGNING_CERTIFICATE_V2 = '1.2.840.113549.1.9.16.2.47'
const OID_ATTR_SIGNING_CERTIFICATE = '1.2.840.113549.1.9.16.2.12'

const NOMS_EMPREINTE: Record<string, string> = {
  '1.3.14.3.2.26': 'SHA-1',
  '2.16.840.1.101.3.4.2.1': 'SHA-256',
  '2.16.840.1.101.3.4.2.2': 'SHA-384',
  '2.16.840.1.101.3.4.2.3': 'SHA-512',
  '2.16.840.1.101.3.4.2.4': 'SHA-224',
}

const NOMS_SIGNATURE: Record<string, string> = {
  '1.2.840.113549.1.1.1': 'RSA',
  '1.2.840.113549.1.1.5': 'RSA SHA-1',
  '1.2.840.113549.1.1.10': 'RSASSA-PSS',
  '1.2.840.113549.1.1.11': 'RSA SHA-256',
  '1.2.840.113549.1.1.12': 'RSA SHA-384',
  '1.2.840.113549.1.1.13': 'RSA SHA-512',
  '1.2.840.10045.4.3.2': 'ECDSA SHA-256',
  '1.2.840.10045.4.3.3': 'ECDSA SHA-384',
  '1.2.840.10045.4.3.4': 'ECDSA SHA-512',
}

const ATTRIBUTS_NOM: Record<string, string> = {
  '2.5.4.3': 'CN',
  '2.5.4.6': 'C',
  '2.5.4.7': 'L',
  '2.5.4.8': 'ST',
  '2.5.4.10': 'O',
  '2.5.4.11': 'OU',
  '1.2.840.113549.1.9.1': 'E',
}

export interface InfoCertificat {
  nomCommun: string
  organisation: string
  unite: string
  pays: string
  courriel: string
  emetteur: string
  emetteurOrganisation: string
  valideDu: Date | null
  valideAu: Date | null
  numeroSerie: string
  autoSigne: boolean
}

export interface InfoHorodatage {
  date: Date | null
  /** Nom de l'autorité d'horodatage, tel que porté par son certificat. */
  autorite: string
  algorithme: string
  /** Le jeton scelle-t-il bien CETTE signature ? null si indéterminable. */
  lieALaSignature: boolean | null
}

/** Verdict d'ensemble d'une signature, sans jamais crier au faux sans preuve. */
export type Verdict = 'intacte' | 'modifie-apres' | 'inconnu' | 'echec'

export interface SignatureVerifiee {
  /** Numéro d'affichage, dans l'ordre du fichier. */
  numero: number
  /** Nom du champ de formulaire, quand il a pu être relu. */
  nomChamp: string
  /** Nom déclaré dans le dictionnaire de signature (/Name). */
  nomDeclare: string
  motif: string
  lieu: string
  contact: string
  dateDeclaree: Date | null
  /** Heure de signature scellée dans les attributs signés (signing-time). */
  dateAttribut: Date | null
  subFilter: string
  profil: 'pades' | 'pkcs7' | 'inconnu'
  algorithmeEmpreinte: string
  algorithmeSignature: string
  certificat: InfoCertificat | null
  chaine: InfoCertificat[]
  /** Le certificat du signataire est-il scellé dans les attributs signés (ESS) ? */
  certificatScelle: boolean
  /** L'empreinte scellée correspond-elle au contenu signé ? */
  documentIntact: boolean
  /** La signature se vérifie-t-elle avec la clé publique du certificat ? */
  signatureValide: boolean
  /** Octets ajoutés après la dernière plage signée : mise à jour incrémentale. */
  octetsApres: number
  /** L'émetteur du certificat figure-t-il dans le fichier ? (jamais une preuve de confiance) */
  emetteurPresent: boolean
  horodatage: InfoHorodatage | null
  erreur: string
  verdict: Verdict
}

export interface RapportSignatures {
  signatures: SignatureVerifiee[]
  /** Champs de signature présents dans le formulaire mais jamais remplis. */
  champsVides: number
  chiffre: boolean
  tailleFichier: number
}

/* ------------------------------------------------------------------ */
/* Lecture des noms X.501                                               */
/* ------------------------------------------------------------------ */

function valeursDuNom(nom: pkijs.RelativeDistinguishedNames): Record<string, string> {
  const out: Record<string, string> = {}
  for (const paire of nom.typesAndValues) {
    const cle = ATTRIBUTS_NOM[paire.type]
    if (!cle) continue
    const valeur = paire.value.valueBlock.value
    if (typeof valeur === 'string' && !out[cle]) out[cle] = valeur
  }
  return out
}

function hexadecimal(vue: Uint8Array): string {
  let out = ''
  for (const octet of vue) out += octet.toString(16).padStart(2, '0')
  return out.replace(/^0+(?=..)/, '').toUpperCase()
}

function decrireCertificat(cert: pkijs.Certificate): InfoCertificat {
  const sujet = valeursDuNom(cert.subject)
  const emetteur = valeursDuNom(cert.issuer)
  return {
    nomCommun: sujet.CN ?? '',
    organisation: sujet.O ?? '',
    unite: sujet.OU ?? '',
    pays: sujet.C ?? '',
    courriel: sujet.E ?? '',
    emetteur: emetteur.CN ?? emetteur.O ?? '',
    emetteurOrganisation: emetteur.O ?? '',
    valideDu: cert.notBefore.value ?? null,
    valideAu: cert.notAfter.value ?? null,
    numeroSerie: hexadecimal(cert.serialNumber.valueBlock.valueHexView),
    autoSigne: cert.issuer.isEqual(cert.subject),
  }
}

/* ------------------------------------------------------------------ */
/* Utilitaires                                                          */
/* ------------------------------------------------------------------ */

/** Copie exacte en ArrayBuffer : asn1js et WebCrypto veulent un tampon dédié. */
function enArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copie = new ArrayBuffer(bytes.length)
  new Uint8Array(copie).set(bytes)
  return copie
}

function memesOctets(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let difference = 0
  for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i]
  return difference === 0
}

function preparerMoteur(): void {
  const sousJacent = globalThis.crypto
  if (!sousJacent?.subtle) throw new Error('WebCrypto indisponible dans cet environnement.')
  // Même cast que dans pades.ts : divergence de typage lib.dom / ICryptoEngine.
  const moteur = new pkijs.CryptoEngine({
    name: 'vellum',
    crypto: sousJacent,
    subtle: sousJacent.subtle,
  }) as unknown as pkijs.ICryptoEngine
  pkijs.setEngine('vellum', moteur)
}

function attribut(
  attributs: pkijs.SignedAndUnsignedAttributes | undefined,
  type: string,
): pkijs.Attribute | undefined {
  return attributs?.attributes.find((a) => a.type === type)
}

/**
 * Noms des champs de signature, indexés par le numéro d'objet du
 * dictionnaire /V qu'ils désignent. Le rapprochement se fait par référence,
 * jamais par ordre d'apparition, qui n'est pas garanti. Compte au passage
 * les champs de signature restés vides.
 */
async function lireChampsFormulaire(
  bytes: Uint8Array,
): Promise<{ noms: Map<number, string>; vides: number }> {
  const noms = new Map<number, string>()
  let vides = 0
  try {
    const { PDFDocument, PDFName, PDFSignature } = await chargerPdfLib()
    const doc = await PDFDocument.load(bytes.slice(), {
      ignoreEncryption: true,
      throwOnInvalidObject: false,
      updateMetadata: false,
    })
    for (const champ of doc.getForm().getFields()) {
      if (!(champ instanceof PDFSignature)) continue
      const valeur = champ.acroField.dict.get(PDFName.of('V')) as PDFRef | undefined
      const numero = (valeur as { objectNumber?: number } | undefined)?.objectNumber
      if (typeof numero === 'number') noms.set(numero, champ.getName())
      else vides++
    }
  } catch {
    /* Formulaire illisible : on se rabat sur une numérotation simple. */
  }
  return { noms, vides }
}

/* ------------------------------------------------------------------ */
/* Horodatage                                                           */
/* ------------------------------------------------------------------ */

async function lireHorodatage(
  signerInfo: pkijs.SignerInfo,
): Promise<InfoHorodatage | null> {
  const jeton = attribut(signerInfo.unsignedAttrs, OID_ATTR_SIGNATURE_TIMESTAMP)
  if (!jeton?.values.length) return null
  try {
    const enveloppe = new pkijs.ContentInfo({ schema: jeton.values[0] })
    const contenu = new pkijs.SignedData({ schema: enveloppe.content })
    const eContent = contenu.encapContentInfo.eContent
    if (!eContent) return null
    const tstInfo = pkijs.TSTInfo.fromBER(enArrayBuffer(eContent.valueBlock.valueHexView))

    const certificatTsa = contenu.certificates?.find((c) => c instanceof pkijs.Certificate) as
      | pkijs.Certificate
      | undefined
    const nomsTsa = certificatTsa ? valeursDuNom(certificatTsa.subject) : {}

    const algorithme =
      NOMS_EMPREINTE[tstInfo.messageImprint.hashAlgorithm.algorithmId] ??
      tstInfo.messageImprint.hashAlgorithm.algorithmId

    let lieALaSignature: boolean | null = null
    const nomAlgorithme = NOMS_EMPREINTE[tstInfo.messageImprint.hashAlgorithm.algorithmId]
    if (nomAlgorithme && nomAlgorithme !== 'SHA-224') {
      const attendu = new Uint8Array(
        await globalThis.crypto.subtle.digest(
          nomAlgorithme,
          enArrayBuffer(new Uint8Array(signerInfo.signature.valueBlock.valueHexView)),
        ),
      )
      lieALaSignature = memesOctets(
        attendu,
        tstInfo.messageImprint.hashedMessage.valueBlock.valueHexView,
      )
    }

    return {
      date: tstInfo.genTime ?? null,
      autorite: nomsTsa.CN ?? nomsTsa.O ?? '',
      algorithme,
      lieALaSignature,
    }
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------ */
/* Vérification                                                         */
/* ------------------------------------------------------------------ */

function profilDe(subFilter: string): 'pades' | 'pkcs7' | 'inconnu' {
  if (subFilter.startsWith('ETSI.')) return 'pades'
  if (subFilter.startsWith('adbe.')) return 'pkcs7'
  return 'inconnu'
}

export async function verifierSignatures(bytes: Uint8Array): Promise<RapportSignatures> {
  preparerMoteur()
  const brutes = trouverSignatures(bytes)
  const { noms, vides } = await lireChampsFormulaire(bytes)
  const signatures: SignatureVerifiee[] = []

  for (let index = 0; index < brutes.length; index++) {
    const brute = brutes[index]
    const subFilter = lireNom(brute.objet, 'SubFilter')
    const base: SignatureVerifiee = {
      numero: index + 1,
      nomChamp: noms.get(brute.numeroObjet) ?? '',
      nomDeclare: lireChaine(brute.objet, 'Name'),
      motif: lireChaine(brute.objet, 'Reason'),
      lieu: lireChaine(brute.objet, 'Location'),
      contact: lireChaine(brute.objet, 'ContactInfo'),
      dateDeclaree: parserDatePdf(lireChaine(brute.objet, 'M')),
      dateAttribut: null,
      subFilter,
      profil: profilDe(subFilter),
      algorithmeEmpreinte: '',
      algorithmeSignature: '',
      certificat: null,
      chaine: [],
      certificatScelle: false,
      documentIntact: false,
      signatureValide: false,
      octetsApres: octetsApres(bytes, brute.byteRange),
      emetteurPresent: false,
      horodatage: null,
      erreur: '',
      verdict: 'inconnu',
    }

    try {
      const enveloppe = pkijs.ContentInfo.fromBER(enArrayBuffer(brute.cms))
      const signedData = new pkijs.SignedData({ schema: enveloppe.content })
      const signerInfo = signedData.signerInfos[0]
      if (!signerInfo) throw new Error('CMS sans signataire.')

      const oidEmpreinte = signerInfo.digestAlgorithm.algorithmId
      base.algorithmeEmpreinte = NOMS_EMPREINTE[oidEmpreinte] ?? oidEmpreinte
      base.algorithmeSignature =
        NOMS_SIGNATURE[signerInfo.signatureAlgorithm.algorithmId] ??
        signerInfo.signatureAlgorithm.algorithmId

      const certificats = (signedData.certificates ?? []).filter(
        (c): c is pkijs.Certificate => c instanceof pkijs.Certificate,
      )
      base.chaine = certificats.map(decrireCertificat)

      let signataire: pkijs.Certificate | undefined
      if (signerInfo.sid instanceof pkijs.IssuerAndSerialNumber) {
        const sid = signerInfo.sid
        signataire = certificats.find(
          (c) => c.issuer.isEqual(sid.issuer) && c.serialNumber.isEqual(sid.serialNumber),
        )
      }
      signataire ??= certificats[0]
      if (signataire) {
        base.certificat = decrireCertificat(signataire)
        base.emetteurPresent = certificats.some(
          (c) => c !== signataire && c.subject.isEqual(signataire.issuer),
        )
      }

      base.certificatScelle =
        !!attribut(signerInfo.signedAttrs, OID_ATTR_SIGNING_CERTIFICATE_V2) ||
        !!attribut(signerInfo.signedAttrs, OID_ATTR_SIGNING_CERTIFICATE)

      const heure = attribut(signerInfo.signedAttrs, OID_ATTR_SIGNING_TIME)
      const valeurHeure = heure?.values[0] as { toDate?: () => Date } | undefined
      if (valeurHeure?.toDate) base.dateAttribut = valeurHeure.toDate()

      /* Intégrité : l'empreinte scellée contre le contenu réellement signé. */
      const signe = octetsSignes(bytes, brute.byteRange)
      const attributEmpreinte = attribut(signerInfo.signedAttrs, OID_ATTR_MESSAGE_DIGEST)
      const nomAlgorithme = NOMS_EMPREINTE[oidEmpreinte]
      if (attributEmpreinte && nomAlgorithme && nomAlgorithme !== 'SHA-224') {
        const scellee = (attributEmpreinte.values[0] as asn1js.OctetString).valueBlock.valueHexView
        const calculee = new Uint8Array(
          await globalThis.crypto.subtle.digest(nomAlgorithme, enArrayBuffer(signe)),
        )
        base.documentIntact = memesOctets(scellee, calculee)
      }

      /* Signature : seulement quand l'empreinte concorde, sinon pkijs refuse
         d'aller plus loin — et le verdict est de toute façon acquis. */
      if (base.documentIntact) {
        const resultat = await signedData.verify({
          signer: 0,
          data: enArrayBuffer(signe),
          extendedMode: true,
        })
        base.signatureValide = resultat.signatureVerified === true
      }

      base.horodatage = await lireHorodatage(signerInfo)
    } catch (e) {
      base.erreur = e instanceof Error ? e.message : String(e)
    }

    if (base.erreur) base.verdict = 'inconnu'
    else if (!base.documentIntact || !base.signatureValide) base.verdict = 'echec'
    else if (base.octetsApres > 0) base.verdict = 'modifie-apres'
    else base.verdict = 'intacte'

    signatures.push(base)
  }

  return {
    signatures,
    champsVides: vides,
    chiffre: looksEncrypted(bytes),
    tailleFichier: bytes.length,
  }
}
