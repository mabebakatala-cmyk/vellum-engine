import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dossierTemp, vellumPdf, fabriquerPdf, pageContientTexte } from './helpers.mjs'

test('page-numbers : imprime "n / total" sur chaque page', async () => {
  const dir = dossierTemp()
  const src = join(dir, 'src.pdf')
  writeFileSync(src, await fabriquerPdf(3))
  const out = join(dir, 'out.pdf')

  const res = vellumPdf(['page-numbers', src, '-o', out])
  assert.equal(res.code, 0, res.stderr)

  assert.ok(await pageContientTexte(out, 0, '1 / 3'))
  assert.ok(await pageContientTexte(out, 2, '3 / 3'))
})

test('watermark : le texte demandé apparaît sur chaque page', async () => {
  const dir = dossierTemp()
  const src = join(dir, 'src.pdf')
  writeFileSync(src, await fabriquerPdf(2))
  const out = join(dir, 'out.pdf')

  const res = vellumPdf(['watermark', src, '-o', out, '--text', 'NE PAS DIFFUSER'])
  assert.equal(res.code, 0, res.stderr)

  assert.ok(await pageContientTexte(out, 0, 'NE PAS DIFFUSER'))
  assert.ok(await pageContientTexte(out, 1, 'NE PAS DIFFUSER'))
})

test('watermark : texte par défaut sans --text', async () => {
  const dir = dossierTemp()
  const src = join(dir, 'src.pdf')
  writeFileSync(src, await fabriquerPdf(1))
  const out = join(dir, 'out.pdf')

  const res = vellumPdf(['watermark', src, '-o', out])
  assert.equal(res.code, 0, res.stderr)
  assert.ok(await pageContientTexte(out, 0, 'CONFIDENTIEL'))
})
