/**
 * Généré depuis vellum-pdf/src/lib/pdfsig.ts — ne pas éditer ici.
 * Source de vérité : le dépôt privé vellum-pdf, via scripts/sync-engine.mjs.
 */

/**
 * Repérage bas niveau des signatures cryptographiques dans les octets bruts
 * d'un PDF.
 *
 * Volontairement sans dépendance lourde : ce module ne fait que lire les
 * octets du fichier (jamais les réécrire) pour retrouver les dictionnaires
 * /Sig, leur /ByteRange et le CMS détaché rangé dans /Contents. Les modules
 * `pades.ts` (signature) et `verifsig.ts` (vérification) s'appuient dessus et
 * chargent seuls, en import différé, les bibliothèques cryptographiques.
 *
 * On travaille sur les octets bruts plutôt que sur l'arbre objet de pdf-lib
 * pour une raison précise : un PDF signé plusieurs fois est une succession de
 * mises à jour incrémentales, et seuls les décalages réels dans le fichier
 * permettent de recalculer l'empreinte exactement comme le signataire l'a
 * calculée.
 */

/**
 * Décode les octets en chaîne latin-1 (un octet = un caractère). Indispensable
 * ici : toute recherche de motif doit rendre un décalage identique à celui du
 * tableau d'octets, ce qu'un décodage UTF-8 ne garantit pas.
 */
export function enLatin1(bytes: Uint8Array): string {
  let sortie = ''
  const pas = 0x8000
  for (let i = 0; i < bytes.length; i += pas) {
    sortie += String.fromCharCode(...bytes.subarray(i, Math.min(i + pas, bytes.length)))
  }
  return sortie
}

export interface SignatureBrute {
  /** /ByteRange tel qu'écrit dans le fichier : [a, b, c, d]. */
  byteRange: [number, number, number, number]
  /** Octets DER du CMS détaché, bourrage de zéros retiré. */
  cms: Uint8Array
  /** Numéro de l'objet PDF portant le dictionnaire de signature, -1 si introuvable. */
  numeroObjet: number
  /** Tranche brute de l'objet, d'où sont relus /SubFilter, /M, /Reason… */
  objet: string
  /** Décalage du `<` ouvrant /Contents. */
  debutContenu: number
  /** Décalage juste après le `>` fermant. */
  finContenu: number
}

/**
 * Longueur totale (en-tête compris) de la première structure ASN.1 d'un
 * tampon. Le contenu de /Contents est complété par des zéros jusqu'à la
 * taille réservée à la signature : sans ce calcul, on transmettrait ce
 * bourrage aux analyseurs ASN.1.
 */
export function longueurDer(bytes: Uint8Array): number {
  if (bytes.length < 2) return bytes.length
  const premierOctetLongueur = bytes[1]
  if (premierOctetLongueur < 0x80) return 2 + premierOctetLongueur
  const octets = premierOctetLongueur & 0x7f
  if (octets === 0 || bytes.length < 2 + octets) return bytes.length
  let longueur = 0
  for (let i = 0; i < octets; i++) longueur = longueur * 256 + bytes[2 + i]
  return Math.min(2 + octets + longueur, bytes.length)
}

function hexEnOctets(hex: string): Uint8Array {
  const propre = hex.replace(/[^0-9a-fA-F]/g, '')
  const paire = propre.length - (propre.length % 2)
  const out = new Uint8Array(paire / 2)
  for (let i = 0; i < paire; i += 2) out[i / 2] = parseInt(propre.substring(i, i + 2), 16)
  return out
}

/**
 * Tranche de l'objet PDF (`N G obj … endobj`) qui contient le décalage donné.
 * Sert à relire les entrées textuelles du dictionnaire de signature sans
 * réanalyser tout le fichier.
 */
function objetContenant(texte: string, position: number): { objet: string; numero: number } {
  const debutRecherche = Math.max(0, position - 8192)
  const avant = texte.slice(debutRecherche, position)
  const marque = /(\d+)\s+(\d+)\s+obj\b/g
  let dernier: RegExpExecArray | null = null
  let m: RegExpExecArray | null
  while ((m = marque.exec(avant)) !== null) dernier = m
  const debut = dernier ? debutRecherche + dernier.index : Math.max(0, position - 2048)
  const finRelative = texte.indexOf('endobj', position)
  const fin = finRelative === -1 ? Math.min(texte.length, position + 4096) : finRelative
  return { objet: texte.slice(debut, fin), numero: dernier ? Number(dernier[1]) : -1 }
}

/**
 * Toutes les signatures du fichier, dans l'ordre des octets. Une entrée dont
 * le /ByteRange ne désigne pas une chaîne hexadécimale valide est ignorée :
 * c'est le cas d'un gabarit de signature jamais rempli.
 */
export function trouverSignatures(bytes: Uint8Array): SignatureBrute[] {
  const texte = enLatin1(bytes)
  const motif = /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/g
  const trouvees: SignatureBrute[] = []
  let m: RegExpExecArray | null

  while ((m = motif.exec(texte)) !== null) {
    const byteRange: [number, number, number, number] = [
      Number(m[1]),
      Number(m[2]),
      Number(m[3]),
      Number(m[4]),
    ]
    const [, b, c] = byteRange
    if (b <= 0 || c <= b || c > bytes.length) continue
    if (texte[b] !== '<' || texte[c - 1] !== '>') continue

    const brut = hexEnOctets(texte.slice(b + 1, c - 1))
    if (brut.length < 8) continue
    const cms = brut.subarray(0, longueurDer(brut))
    const { objet, numero } = objetContenant(texte, m.index)
    trouvees.push({ byteRange, cms, numeroObjet: numero, objet, debutContenu: b, finContenu: c })
  }

  return trouvees
}

/** Concatène les deux plages couvertes par un /ByteRange : ce sont ces octets, et eux seuls, qui sont signés. */
export function octetsSignes(bytes: Uint8Array, byteRange: [number, number, number, number]): Uint8Array {
  const [a, b, c, d] = byteRange
  const fin = Math.min(c + d, bytes.length)
  const premiere = bytes.subarray(a, Math.min(a + b, bytes.length))
  const seconde = bytes.subarray(Math.min(c, bytes.length), fin)
  const out = new Uint8Array(premiere.length + seconde.length)
  out.set(premiere, 0)
  out.set(seconde, premiere.length)
  return out
}

/** Vrai quand des octets subsistent après la dernière plage signée : mise à jour incrémentale. */
export function octetsApres(bytes: Uint8Array, byteRange: [number, number, number, number]): number {
  return Math.max(0, bytes.length - (byteRange[2] + byteRange[3]))
}

/** Lit une entrée nom (`/SubFilter /ETSI.CAdES.detached`) dans une tranche d'objet. */
export function lireNom(objet: string, cle: string): string {
  const m = new RegExp(`/${cle}\\s*/([^\\s/<>\\[\\]()]+)`).exec(objet)
  return m ? m[1] : ''
}

/**
 * Lit une entrée chaîne (`/Reason (Approbation)` ou `/Reason <FEFF…>`).
 * Gère l'échappement par barre oblique inverse et le BOM UTF-16 des chaînes
 * hexadécimales, les deux formes qu'un producteur de PDF peut choisir.
 */
export function lireChaine(objet: string, cle: string): string {
  const litterale = new RegExp(`/${cle}\\s*\\(((?:\\\\.|[^\\\\)])*)\\)`).exec(objet)
  if (litterale) {
    return litterale[1]
      .replace(/\\([nrtbf()\\])/g, (_, c: string) => {
        const table: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' }
        return table[c] ?? c
      })
      .replace(/\\(\d{1,3})/g, (_, o: string) => String.fromCharCode(parseInt(o, 8)))
  }
  const hexadecimale = new RegExp(`/${cle}\\s*<([0-9a-fA-F\\s]*)>`).exec(objet)
  if (!hexadecimale) return ''
  const octets = hexEnOctets(hexadecimale[1])
  if (octets.length >= 2 && octets[0] === 0xfe && octets[1] === 0xff) {
    let out = ''
    for (let i = 2; i + 1 < octets.length; i += 2) out += String.fromCharCode((octets[i] << 8) | octets[i + 1])
    return out
  }
  return enLatin1(octets)
}

/** Convertit une date PDF (`D:20260910143000+02'00'`) en Date, ou null. */
export function parserDatePdf(valeur: string): Date | null {
  const m = /^D?:?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?(?:([+-Z])(\d{2})'?(\d{2})?)?/.exec(
    valeur.trim(),
  )
  if (!m) return null
  const [, annee, mois, jour, heure, minute, seconde, signe, decalageH, decalageM] = m
  let iso = `${annee}-${mois ?? '01'}-${jour ?? '01'}T${heure ?? '00'}:${minute ?? '00'}:${seconde ?? '00'}`
  if (signe && signe !== 'Z') iso += `${signe}${decalageH}:${decalageM ?? '00'}`
  else iso += 'Z'
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? null : date
}

/** Formate une date au format chaîne PDF, avec le décalage horaire local. */
export function formaterDatePdf(date: Date): string {
  const deuxChiffres = (n: number) => String(n).padStart(2, '0')
  const decalage = -date.getTimezoneOffset()
  const signe = decalage < 0 ? '-' : '+'
  const absolu = Math.abs(decalage)
  return (
    `D:${date.getFullYear()}${deuxChiffres(date.getMonth() + 1)}${deuxChiffres(date.getDate())}` +
    `${deuxChiffres(date.getHours())}${deuxChiffres(date.getMinutes())}${deuxChiffres(date.getSeconds())}` +
    `${signe}${deuxChiffres(Math.floor(absolu / 60))}'${deuxChiffres(absolu % 60)}'`
  )
}

/**
 * Vrai si le document porte déjà au moins une signature cryptographique.
 *
 * Ajouter une deuxième signature suppose une mise à jour incrémentale du
 * fichier : réenregistrer le document, comme le fait cette version, casse
 * l'empreinte de la première signature. On préfère refuser.
 */
export function pdfDejaSigne(bytes: Uint8Array): boolean {
  if (trouverSignatures(bytes).length > 0) return true
  const texte = enLatin1(bytes)
  return /\/Type\s*\/Sig\b/.test(texte) || /\/FT\s*\/Sig\b/.test(texte)
}
