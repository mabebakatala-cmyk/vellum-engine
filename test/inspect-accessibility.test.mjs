import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dossierTemp, vellumPdf, fabriquerPdf } from './helpers.mjs'

test('inspect : rapport JSON cohérent avec le PDF fabriqué', async () => {
  const dir = dossierTemp()
  const src = join(dir, 'src.pdf')
  writeFileSync(src, await fabriquerPdf(4, { title: 'Rapport' }))

  const res = vellumPdf(['inspect', src, '--json'])
  assert.equal(res.code, 0, res.stderr)
  const rapport = JSON.parse(res.stdout)
  assert.equal(rapport.pageCount, 4)
  assert.equal(rapport.encrypted, false)
  assert.equal(rapport.metadata.title, 'Rapport')
  assert.equal(rapport.pageSizes.length, 4)
})

test('accessibility : rapport JSON, un point par critère, compte de pages correct', async () => {
  const dir = dossierTemp()
  const src = join(dir, 'src.pdf')
  writeFileSync(src, await fabriquerPdf(2))

  const res = vellumPdf(['accessibility', src, '--json'])
  assert.equal(res.code, 0, res.stderr)
  const rapport = JSON.parse(res.stdout)
  assert.equal(rapport.pages, 2)
  assert.ok(Array.isArray(rapport.points) && rapport.points.length > 0)
  // Sans titre ni langue déclarés, ces deux points ne doivent pas être dits
  // "conforme" — le rapport ne doit jamais mentir par optimisme.
  const titre = rapport.points.find((p) => p.id === 'titre')
  assert.notEqual(titre.etat, 'conforme')
})
