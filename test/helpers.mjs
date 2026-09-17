// Aides communes aux tests : fabrique de PDF réels (pdf-lib) et lancement du
// CLI en sous-processus, comme le ferait un utilisateur réel dans un
// terminal — jamais d'appel direct aux fonctions internes.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PDFDocument, StandardFonts, PDFName, PDFString, decodePDFRawStream } from 'pdf-lib'

const RACINE = new URL('..', import.meta.url).pathname
const CLI = join(RACINE, 'bin', 'vellum-pdf.mjs')

/**
 * Options pdf.js pour lire le texte d'un PDF depuis les tests, sans le
 * serveur de secours : mêmes ressources (cmaps/standard_fonts/wasm) que
 * src/pdf.ts en résout, prises directement dans pdfjs-dist installé.
 */
export function optionsPdfjs() {
  const base = new URL('.', import.meta.resolve('pdfjs-dist/package.json'))
  return {
    standardFontDataUrl: fileURLToPath(new URL('standard_fonts/', base)),
    cMapUrl: fileURLToPath(new URL('cmaps/', base)),
    cMapPacked: true,
    wasmUrl: fileURLToPath(new URL('wasm/', base)),
  }
}

export function dossierTemp() {
  return mkdtempSync(join(tmpdir(), 'vellum-engine-test-'))
}

/** Lance le CLI comme le ferait un utilisateur, capture stdout/stderr/code. */
export function vellumPdf(args, opts = {}) {
  try {
    const stdout = execFileSync('node', [CLI, ...args], { encoding: 'utf8', ...opts })
    return { code: 0, stdout, stderr: '' }
  } catch (e) {
    return { code: e.status ?? 1, stdout: e.stdout?.toString() ?? '', stderr: e.stderr?.toString() ?? '' }
  }
}

/** PDF simple à `n` pages, chacune portant le texte "page N". */
export async function fabriquerPdf(n = 5, opts = {}) {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  for (let i = 0; i < n; i++) {
    const page = doc.addPage([300, 300])
    page.drawText(`page ${i + 1}`, { x: 20, y: 150, size: 18, font })
  }
  if (opts.title) doc.setTitle(opts.title)
  if (opts.author) doc.setAuthor(opts.author)
  return doc.save()
}

/** PDF avec un champ de formulaire texte, pour tester `flatten`. */
export async function fabriquerPdfAvecFormulaire() {
  const doc = await PDFDocument.create()
  const page = doc.addPage([300, 300])
  const form = doc.getForm()
  const champ = form.createTextField('nom')
  champ.setText('valeur')
  champ.addToPage(page, { x: 20, y: 100, width: 150, height: 24 })
  return doc.save()
}

/**
 * PDF avec un /OpenAction JavaScript et une action /AA sur le catalogue —
 * exactement ce que `sanitize` doit retirer. Construit au niveau du
 * contexte pdf-lib (bas niveau), comme le ferait un PDF produit par un
 * outil d'automatisation.
 */
export async function fabriquerPdfAvecAutomatisation() {
  const doc = await PDFDocument.create()
  doc.addPage([300, 300])
  const ctx = doc.context

  const actionJs = ctx.obj({ S: PDFName.of('JavaScript'), JS: PDFString.of('app.alert("hello")') })
  const refAction = ctx.register(actionJs)
  doc.catalog.set(PDFName.of('OpenAction'), refAction)

  const aa = ctx.obj({ WC: refAction })
  doc.catalog.set(PDFName.of('AA'), aa)

  const namesDict = ctx.obj({})
  const jsNames = ctx.obj({ Names: ctx.obj([PDFString.of('script1'), refAction]) })
  namesDict.set(PDFName.of('JavaScript'), jsNames)
  doc.catalog.set(PDFName.of('Names'), namesDict)

  return doc.save()
}

/**
 * Contenu décodé (opérateurs PDF bruts, tous les flux de la page concaténés)
 * d'une page — pour vérifier qu'un texte a bien été dessiné sans dépendre de
 * l'extraction de texte de pdf.js, peu fiable sous Node avec des polices
 * standard non incorporées et des libellés de police générés (Helvetica-<id
 * aléatoire>) : elle a tronqué des chaînes pourtant intactes dans le flux
 * (vérifié à la main pendant l'écriture de ces tests).
 */
function contenuBrutPage(pdfDoc, index) {
  const page = pdfDoc.getPage(index)
  const contents = page.node.Contents()
  const flux = contents.array ? contents.array.map((ref) => pdfDoc.context.lookup(ref)) : [contents]
  return flux.map((s) => Buffer.from(decodePDFRawStream(s).decode()).toString('latin1')).join('\n')
}

/** Le texte apparaît-il, tel quel en littéral `(...)` ou en hexadécimal `<...>` ? */
export async function pageContientTexte(cheminPdf, index, texte) {
  const doc = await PDFDocument.load(readFileSync(cheminPdf))
  const brut = contenuBrutPage(doc, index)
  const hex = Buffer.from(texte, 'latin1').toString('hex').toUpperCase()
  return brut.includes(`(${texte})`) || brut.toUpperCase().includes(hex)
}
