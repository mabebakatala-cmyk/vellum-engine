import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PDFDocument } from 'pdf-lib'
import { dossierTemp, vellumPdf, fabriquerPdf } from './helpers.mjs'

test('rotate : ajoute l\'angle demandé à toutes les pages', async () => {
  const dir = dossierTemp()
  const src = join(dir, 'src.pdf')
  writeFileSync(src, await fabriquerPdf(3))
  const out = join(dir, 'out.pdf')

  const res = vellumPdf(['rotate', src, '-o', out, '--angle', '90'])
  assert.equal(res.code, 0, res.stderr)

  const doc = await PDFDocument.load(readFileSync(out))
  for (const page of doc.getPages()) {
    assert.equal(page.getRotation().angle, 90)
  }
})

test('rotate : angle par défaut (90) sans --angle', async () => {
  const dir = dossierTemp()
  const src = join(dir, 'src.pdf')
  writeFileSync(src, await fabriquerPdf(1))
  const out = join(dir, 'out.pdf')

  const res = vellumPdf(['rotate', src, '-o', out])
  assert.equal(res.code, 0, res.stderr)
  const doc = await PDFDocument.load(readFileSync(out))
  assert.equal(doc.getPage(0).getRotation().angle, 90)
})
