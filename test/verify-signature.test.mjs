import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dossierTemp, vellumPdf, fabriquerPdf } from './helpers.mjs'

test('verify-signature : un PDF non signé renvoie une liste de signatures vide', async () => {
  const dir = dossierTemp()
  const src = join(dir, 'src.pdf')
  writeFileSync(src, await fabriquerPdf(1))

  const res = vellumPdf(['verify-signature', src, '--json'])
  assert.equal(res.code, 0, res.stderr)
  const rapport = JSON.parse(res.stdout)
  assert.deepEqual(rapport.signatures, [])
  assert.equal(rapport.chiffre, false)
  assert.ok(rapport.tailleFichier > 0)
})
