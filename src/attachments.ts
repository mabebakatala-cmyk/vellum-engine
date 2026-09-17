/**
 * Généré depuis vellum-pdf/src/lib/attachments.ts — ne pas éditer ici.
 * Source de vérité : le dépôt privé vellum-pdf, via scripts/sync-engine.mjs.
 */

/**
 * Pièces jointes intégrées à un PDF (mécanisme /EmbeddedFiles du catalogue,
 * le même qu'utilise pdf-lib pour `PDFDocument.attach`).
 *
 * La lecture combine deux couches : pdf.js pour la liste et le contenu
 * (`getAttachments`, qui sait parcourir un arbre de noms conforme) et
 * pdf-lib en lecture bas niveau pour le seul champ que pdf.js n'expose pas,
 * le type MIME (`/Subtype` du flux). Cette seconde lecture suppose un arbre
 * plat — le cas de tout fichier produit par cet outil, et de l'immense
 * majorité des PDF rencontrés en pratique — d'où l'appariement par position
 * plutôt que par nom (un nom peut se répéter). Si les deux comptes ne
 * correspondent pas, le MIME est simplement laissé vide plutôt que mal
 * apparié.
 *
 * L'ajout et le retrait, eux, exigent une écriture : seul pdf-lib le permet.
 */
import type { PDFArray, PDFDocument } from 'pdf-lib'
// Chargement différé de pdf-lib et JSZip, au premier usage réel (voir bibliotheques.ts).
import { chargerJszip, chargerPdfLib } from './bibliotheques.ts'
import { closePdfJsDoc, loadPdf, openPdfJsDoc, savePdf } from './pdf.ts'

export interface AttachmentInfo {
  name: string
  size: number
  description: string
  /** Type MIME si l'information est présente dans le PDF, chaîne vide sinon. */
  mime: string
  bytes: Uint8Array
}

async function texteDe(obj: unknown): Promise<string> {
  const { PDFHexString, PDFString } = await chargerPdfLib()
  if (obj instanceof PDFHexString || obj instanceof PDFString) return obj.decodeText()
  return ''
}

/** Tableau plat `[nom, référence, nom, référence...]` des pièces jointes du catalogue. */
async function tableauPiecesJointes(doc: PDFDocument): Promise<PDFArray | undefined> {
  const { PDFArray, PDFDict, PDFName } = await chargerPdfLib()
  const noms = doc.catalog.lookupMaybe(PDFName.of('Names'), PDFDict)
  const embedded = noms?.lookupMaybe(PDFName.of('EmbeddedFiles'), PDFDict)
  return embedded?.lookupMaybe(PDFName.of('Names'), PDFArray)
}

/** MIME de chaque pièce jointe, dans l'ordre du tableau bas niveau — best-effort. */
async function mimesParPosition(doc: PDFDocument): Promise<string[]> {
  const { PDFDict, PDFName, PDFStream } = await chargerPdfLib()
  const tableau = await tableauPiecesJointes(doc)
  if (!tableau) return []
  const mimes: string[] = []
  for (let i = 1; i < tableau.size(); i += 2) {
    const filespec = tableau.lookupMaybe(i, PDFDict)
    const ef = filespec?.lookupMaybe(PDFName.of('EF'), PDFDict)
    const streamRef = ef?.get(PDFName.of('F'))
    const stream = streamRef ? doc.context.lookupMaybe(streamRef, PDFStream) : undefined
    const subtype = stream?.dict.lookupMaybe(PDFName.of('Subtype'), PDFName)
    mimes.push(subtype ? subtype.decodeText() : '')
  }
  return mimes
}

/** Devine un type MIME courant à partir de l'extension du nom de fichier. */
const MIME_PAR_EXTENSION: Record<string, string> = {
  pdf: 'application/pdf',
  txt: 'text/plain',
  csv: 'text/csv',
  xml: 'application/xml',
  json: 'application/json',
  html: 'text/html',
  htm: 'text/html',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  zip: 'application/zip',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  doc: 'application/msword',
  xls: 'application/vnd.ms-excel',
  ppt: 'application/vnd.ms-powerpoint',
}

export function devinerMimeType(nom: string): string {
  const ext = nom.split('.').pop()?.toLowerCase() ?? ''
  return MIME_PAR_EXTENSION[ext] ?? 'application/octet-stream'
}

/**
 * Liste les pièces jointes d'un PDF, contenu inclus (utile pour l'extraction
 * immédiate sans rouvrir le fichier).
 */
export async function listAttachments(bytes: Uint8Array): Promise<AttachmentInfo[]> {
  const pdfjsDoc = await openPdfJsDoc(bytes)
  try {
    const carte = await pdfjsDoc.getAttachments()
    if (!carte || carte.size === 0) return []

    let mimes: string[] = []
    try {
      mimes = await mimesParPosition(await loadPdf(bytes))
    } catch {
      mimes = []
    }
    const mimesFiables = mimes.length === carte.size

    const sortie: AttachmentInfo[] = []
    let i = 0
    for (const [id, piece] of carte) {
      // Depuis pdfjs-dist 6, `getAttachments()` ne renvoie plus le contenu :
      // seul `getAttachmentContent(id)` le charge, à la demande.
      // eslint-disable-next-line no-await-in-loop
      const contenu = (await pdfjsDoc.getAttachmentContent(id).catch(() => null)) ?? piece.content
      sortie.push({
        name: piece.filename,
        size: contenu?.length ?? 0,
        description: piece.description ?? '',
        mime: mimesFiables ? mimes[i] : '',
        bytes: contenu ?? new Uint8Array(0),
      })
      i++
    }
    return sortie
  } finally {
    await closePdfJsDoc(pdfjsDoc)
  }
}

/** Nom rendu unique dans une archive : « rapport.pdf » -> « rapport (2).pdf ». */
function nomUnique(nom: string, pris: Set<string>): string {
  if (!pris.has(nom)) {
    pris.add(nom)
    return nom
  }
  const point = nom.lastIndexOf('.')
  const base = point > 0 ? nom.slice(0, point) : nom
  const ext = point > 0 ? nom.slice(point) : ''
  let n = 2
  let essai = `${base} (${n})${ext}`
  while (pris.has(essai)) {
    n++
    essai = `${base} (${n})${ext}`
  }
  pris.add(essai)
  return essai
}

/** Archive ZIP de toutes les pièces jointes fournies. */
export async function zipAttachments(pieces: AttachmentInfo[]): Promise<Blob> {
  const JSZip = await chargerJszip()
  const zip = new JSZip()
  const pris = new Set<string>()
  for (const piece of pieces) {
    zip.file(nomUnique(piece.name || 'fichier', pris), piece.bytes)
  }
  return zip.generateAsync({ type: 'blob' })
}

/** Retire de l'array AF (Associated Files) toute référence égale à `ref`. */
async function retirerDeAF(doc: PDFDocument, ref: unknown): Promise<void> {
  const { PDFArray, PDFName } = await chargerPdfLib()
  const af = doc.catalog.lookupMaybe(PDFName.of('AF'), PDFArray)
  if (!af || !ref) return
  for (let i = af.size() - 1; i >= 0; i--) {
    if (af.get(i)?.toString() === (ref as { toString(): string }).toString()) af.remove(i)
  }
}

/**
 * Applique en une fois les retraits (par nom) et les ajouts de pièces
 * jointes, puis renvoie le PDF modifié.
 */
export async function appliquerPiecesJointes(
  bytes: Uint8Array,
  aRetirer: Set<string>,
  aAjouter: { name: string; data: Uint8Array; mimeType: string }[],
): Promise<Uint8Array> {
  const doc = await loadPdf(bytes)

  if (aRetirer.size > 0) {
    const tableau = await tableauPiecesJointes(doc)
    if (tableau) {
      // Parcours à l'envers : chaque suppression décale les index suivants,
      // jamais les précédents.
      for (let i = tableau.size() - 2; i >= 0; i -= 2) {
        // eslint-disable-next-line no-await-in-loop
        const nom = await texteDe(tableau.get(i))
        if (!aRetirer.has(nom)) continue
        const filespecRef = tableau.get(i + 1)
        tableau.remove(i + 1)
        tableau.remove(i)
        // eslint-disable-next-line no-await-in-loop
        await retirerDeAF(doc, filespecRef)
      }
    }
  }

  for (const fichier of aAjouter) {
    // eslint-disable-next-line no-await-in-loop
    await doc.attach(fichier.data, fichier.name, { mimeType: fichier.mimeType })
  }

  return savePdf(doc)
}
