import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PDFDocument, PDFName, PDFDict } from 'pdf-lib'
import { dossierTemp, vellumPdf, fabriquerPdf } from './helpers.mjs'

test('compress : produit un PDF valide, même nombre de pages, images rastérisées', async () => {
  const dir = dossierTemp()
  const src = join(dir, 'src.pdf')
  writeFileSync(src, await fabriquerPdf(2))
  const out = join(dir, 'out.pdf')

  const res = vellumPdf(['compress', src, '-o', out, '--quality', '0.5'])
  assert.equal(res.code, 0, res.stderr)

  const doc = await PDFDocument.load(readFileSync(out))
  assert.equal(doc.getPageCount(), 2)
  // Chaque page rastérisée porte une seule image plein cadre, plus aucun
  // texte sélectionnable (c'est le compromis documenté par `compress --help`).
  const page = doc.getPage(0)
  const xobjects = page.node.Resources()?.lookupMaybe(PDFName.of('XObject'), PDFDict) ?? null
  assert.notEqual(xobjects, null)
  assert.ok(xobjects.keys().length >= 1)
})
