import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PDFDocument } from 'pdf-lib'
import { dossierTemp, vellumPdf, fabriquerPdf } from './helpers.mjs'

test('pdfa : produit un PDF valide, avec le même nombre de pages, et un rapport JSON', async () => {
  const dir = dossierTemp()
  const src = join(dir, 'src.pdf')
  writeFileSync(src, await fabriquerPdf(3, { title: 'Vers PDF/A' }))
  const out = join(dir, 'out.pdf')

  const res = vellumPdf(['pdfa', src, '-o', out, '--json'])
  assert.equal(res.code, 0, res.stderr)
  const rapport = JSON.parse(res.stdout)
  assert.equal(typeof rapport.actionsRemoved, 'number')
  assert.ok(Array.isArray(rapport.nonEmbeddedFonts))

  const doc = await PDFDocument.load(readFileSync(out))
  assert.equal(doc.getPageCount(), 3)
  assert.equal(doc.getTitle(), 'Vers PDF/A')
})
