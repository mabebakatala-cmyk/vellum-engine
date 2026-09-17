import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PDFDocument } from 'pdf-lib'
import { dossierTemp, vellumPdf, fabriquerPdfAvecFormulaire } from './helpers.mjs'

test('flatten : fige le champ de formulaire (plus aucun champ ensuite)', async () => {
  const dir = dossierTemp()
  const src = join(dir, 'src.pdf')
  writeFileSync(src, await fabriquerPdfAvecFormulaire())
  const out = join(dir, 'out.pdf')

  const avant = await PDFDocument.load(readFileSync(src))
  assert.equal(avant.getForm().getFields().length, 1)

  const res = vellumPdf(['flatten', src, '-o', out])
  assert.equal(res.code, 0, res.stderr)

  const apres = await PDFDocument.load(readFileSync(out))
  assert.equal(apres.getForm().getFields().length, 0)
})
