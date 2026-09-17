import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { dossierTemp, vellumPdf, fabriquerPdf } from './helpers.mjs'

test('bookmarks : lecture d\'un PDF sans signet', async () => {
  const dir = dossierTemp()
  const src = join(dir, 'src.pdf')
  writeFileSync(src, await fabriquerPdf(2))

  const res = vellumPdf(['bookmarks', src, '--json'])
  assert.equal(res.code, 0, res.stderr)
  assert.deepEqual(JSON.parse(res.stdout), [])
})

test('bookmarks : écriture (--set) puis relecture, mêmes titres et pages', async () => {
  const dir = dossierTemp()
  const src = join(dir, 'src.pdf')
  writeFileSync(src, await fabriquerPdf(4))
  const signets = join(dir, 'signets.json')
  const attendus = [
    { title: 'Introduction', pageIndex: 0, level: 0 },
    { title: 'Détail', pageIndex: 2, level: 1 },
  ]
  writeFileSync(signets, JSON.stringify(attendus))
  const out = join(dir, 'out.pdf')

  const ecriture = vellumPdf(['bookmarks', src, '--set', signets, '-o', out])
  assert.equal(ecriture.code, 0, ecriture.stderr)

  const lecture = vellumPdf(['bookmarks', out, '--json'])
  assert.equal(lecture.code, 0, lecture.stderr)
  const relus = JSON.parse(lecture.stdout)
  assert.equal(relus.length, 2)
  assert.equal(relus[0].title, 'Introduction')
  assert.equal(relus[0].pageIndex, 0)
  assert.equal(relus[1].title, 'Détail')
  assert.equal(relus[1].pageIndex, 2)
})
