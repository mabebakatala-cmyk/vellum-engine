import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { dossierTemp, vellumPdf, fabriquerPdf } from './helpers.mjs'

test('attachments : add puis list puis extract, contenu identique', async () => {
  const dir = dossierTemp()
  const src = join(dir, 'src.pdf')
  writeFileSync(src, await fabriquerPdf(1))
  const piece = join(dir, 'notes.txt')
  const contenu = 'Ceci est une pièce jointe de test.\n'
  writeFileSync(piece, contenu)
  const withAttach = join(dir, 'with-attach.pdf')

  const add = vellumPdf(['attachments', 'add', src, '--file', piece, '-o', withAttach])
  assert.equal(add.code, 0, add.stderr)

  const list = vellumPdf(['attachments', 'list', withAttach, '--json'])
  assert.equal(list.code, 0, list.stderr)
  const pieces = JSON.parse(list.stdout)
  assert.equal(pieces.length, 1)
  assert.equal(pieces[0].name, 'notes.txt')
  assert.equal(pieces[0].mime, 'text/plain')

  const outDir = join(dir, 'extraites')
  const extract = vellumPdf(['attachments', 'extract', withAttach, '-o', outDir])
  assert.equal(extract.code, 0, extract.stderr)
  assert.deepEqual(readdirSync(outDir), ['notes.txt'])
  assert.equal(readFileSync(join(outDir, 'notes.txt'), 'utf8'), contenu)
})

test('attachments : list sur un PDF sans pièce jointe renvoie []', async () => {
  const dir = dossierTemp()
  const src = join(dir, 'src.pdf')
  writeFileSync(src, await fabriquerPdf(1))
  const res = vellumPdf(['attachments', 'list', src, '--json'])
  assert.equal(res.code, 0, res.stderr)
  assert.deepEqual(JSON.parse(res.stdout), [])
})
