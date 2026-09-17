import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PDFDocument, PDFName } from 'pdf-lib'
import { dossierTemp, vellumPdf, fabriquerPdfAvecAutomatisation } from './helpers.mjs'

test('sanitize : retire OpenAction, AA et le rapport le confirme', async () => {
  const dir = dossierTemp()
  const src = join(dir, 'src.pdf')
  writeFileSync(src, await fabriquerPdfAvecAutomatisation())
  const out = join(dir, 'out.pdf')

  const avant = await PDFDocument.load(readFileSync(src))
  assert.ok(avant.catalog.has(PDFName.of('OpenAction')))
  assert.ok(avant.catalog.has(PDFName.of('AA')))

  const res = vellumPdf(['sanitize', src, '-o', out, '--json'])
  assert.equal(res.code, 0, res.stderr)
  const rapport = JSON.parse(res.stdout)
  assert.equal(rapport.openActionRetiree, true)
  assert.ok(rapport.actionsRetirees >= 1)

  const apres = await PDFDocument.load(readFileSync(out))
  assert.equal(apres.catalog.has(PDFName.of('OpenAction')), false)
  assert.equal(apres.catalog.has(PDFName.of('AA')), false)
})
