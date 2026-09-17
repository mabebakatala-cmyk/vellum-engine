import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { PDFDocument } from 'pdf-lib'
import { dossierTemp, vellumPdf, fabriquerPdf } from './helpers.mjs'

test('merge : concatène les pages de plusieurs PDF, dans l\'ordre', async () => {
  const dir = dossierTemp()
  const a = join(dir, 'a.pdf')
  const b = join(dir, 'b.pdf')
  writeFileSync(a, await fabriquerPdf(2))
  writeFileSync(b, await fabriquerPdf(3))
  const out = join(dir, 'out.pdf')

  const res = vellumPdf(['merge', a, b, '-o', out])
  assert.equal(res.code, 0, res.stderr)

  const doc = await PDFDocument.load(readFileSync(out))
  assert.equal(doc.getPageCount(), 5)
})

test('split : --ranges produit un fichier par groupe', async () => {
  const dir = dossierTemp()
  const src = join(dir, 'src.pdf')
  writeFileSync(src, await fabriquerPdf(5))
  const outDir = join(dir, 'out')

  const res = vellumPdf(['split', src, '-o', outDir, '--ranges', '1-2;3;4-5'])
  assert.equal(res.code, 0, res.stderr)

  const fichiers = readdirSync(outDir).sort()
  assert.equal(fichiers.length, 3)

  const comptes = []
  for (const f of fichiers) {
    const doc = await PDFDocument.load(readFileSync(join(outDir, f)))
    comptes.push(doc.getPageCount())
  }
  assert.deepEqual(comptes.sort(), [1, 2, 2])
})

test('split : --one-page-per-file produit une page par fichier', async () => {
  const dir = dossierTemp()
  const src = join(dir, 'src.pdf')
  writeFileSync(src, await fabriquerPdf(3))
  const outDir = join(dir, 'out')

  const res = vellumPdf(['split', src, '-o', outDir, '--one-page-per-file'])
  assert.equal(res.code, 0, res.stderr)
  assert.equal(readdirSync(outDir).length, 3)
})
