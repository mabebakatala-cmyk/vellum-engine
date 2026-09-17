import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PDFDocument } from 'pdf-lib'
import { dossierTemp, vellumPdf, fabriquerPdf } from './helpers.mjs'

test('protect : le PDF produit refuse de charger sans mot de passe', async () => {
  const dir = dossierTemp()
  const src = join(dir, 'src.pdf')
  writeFileSync(src, await fabriquerPdf(2))
  const out = join(dir, 'protected.pdf')

  const res = vellumPdf(['protect', src, '-o', out, '--password', 'secret-123'])
  assert.equal(res.code, 0, res.stderr)

  await assert.rejects(() => PDFDocument.load(readFileSync(out)))
})

test('unlock : redonne un PDF qui charge normalement, mêmes pages', async () => {
  const dir = dossierTemp()
  const src = join(dir, 'src.pdf')
  writeFileSync(src, await fabriquerPdf(2))
  const protected_ = join(dir, 'protected.pdf')
  const unlocked = join(dir, 'unlocked.pdf')

  vellumPdf(['protect', src, '-o', protected_, '--password', 'secret-123'])
  const res = vellumPdf(['unlock', protected_, '-o', unlocked, '--password', 'secret-123'])
  assert.equal(res.code, 0, res.stderr)

  const doc = await PDFDocument.load(readFileSync(unlocked))
  assert.equal(doc.getPageCount(), 2)
})

test('protect : refuse un mot de passe commençant par "-"', async () => {
  const dir = dossierTemp()
  const src = join(dir, 'src.pdf')
  writeFileSync(src, await fabriquerPdf(1))
  const out = join(dir, 'out.pdf')
  const res = vellumPdf(['protect', src, '-o', out, '--password=-oops'])
  assert.notEqual(res.code, 0)
})
