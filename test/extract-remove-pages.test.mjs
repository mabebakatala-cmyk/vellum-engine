import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs'
import { dossierTemp, vellumPdf, optionsPdfjs } from './helpers.mjs'

/** Un PDF dont chaque page contient un texte distinctif, pour vérifier
 * qu'extract/remove gardent les BONNES pages, pas seulement le bon compte. */
async function pdfNumerote(n) {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  for (let i = 0; i < n; i++) {
    const page = doc.addPage([300, 300])
    page.drawText(`MARQUEUR-${i + 1}`, { x: 20, y: 150, size: 16, font })
  }
  return doc.save()
}

async function textesDesPages(bytes) {
  const task = pdfjsLib.getDocument({ data: bytes, ...optionsPdfjs() })
  const doc = await task.promise
  const out = []
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i)
    const contenu = await page.getTextContent()
    out.push(contenu.items.map((it) => it.str).join(''))
  }
  await task.destroy()
  return out
}

test('extract-pages : garde exactement les pages demandées, dans l\'ordre', async () => {
  const dir = dossierTemp()
  const src = join(dir, 'src.pdf')
  writeFileSync(src, await pdfNumerote(5))
  const out = join(dir, 'out.pdf')

  const res = vellumPdf(['extract-pages', src, '-o', out, '--ranges', '2,4'])
  assert.equal(res.code, 0, res.stderr)

  const textes = await textesDesPages(new Uint8Array(readFileSync(out)))
  assert.deepEqual(textes, ['MARQUEUR-2', 'MARQUEUR-4'])
})

test('remove-pages : retire les pages demandées, garde le reste dans l\'ordre', async () => {
  const dir = dossierTemp()
  const src = join(dir, 'src.pdf')
  writeFileSync(src, await pdfNumerote(4))
  const out = join(dir, 'out.pdf')

  const res = vellumPdf(['remove-pages', src, '-o', out, '--ranges', '2'])
  assert.equal(res.code, 0, res.stderr)

  const textes = await textesDesPages(new Uint8Array(readFileSync(out)))
  assert.deepEqual(textes, ['MARQUEUR-1', 'MARQUEUR-3', 'MARQUEUR-4'])
})
