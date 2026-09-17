import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PDFDocument } from 'pdf-lib'
import { dossierTemp, vellumPdf, fabriquerPdf } from './helpers.mjs'

test('metadata : lecture en JSON', async () => {
  const dir = dossierTemp()
  const src = join(dir, 'src.pdf')
  writeFileSync(src, await fabriquerPdf(1, { title: 'Mon titre', author: 'Edem' }))

  const res = vellumPdf(['metadata', src, '--json'])
  assert.equal(res.code, 0, res.stderr)
  const meta = JSON.parse(res.stdout)
  assert.equal(meta.title, 'Mon titre')
  assert.equal(meta.author, 'Edem')
  assert.equal(meta.pageCount, 1)
})

test('metadata : écriture puis relecture avec pdf-lib', async () => {
  const dir = dossierTemp()
  const src = join(dir, 'src.pdf')
  writeFileSync(src, await fabriquerPdf(1))
  const out = join(dir, 'out.pdf')

  const res = vellumPdf([
    'metadata',
    src,
    '-o',
    out,
    '--set-title',
    'Titre écrit par le CLI',
    '--set-author',
    'CLI',
    '--set-keywords',
    'pdf, cli, test',
    '--set-language',
    'fr',
  ])
  assert.equal(res.code, 0, res.stderr)

  const doc = await PDFDocument.load(readFileSync(out))
  assert.equal(doc.getTitle(), 'Titre écrit par le CLI')
  assert.equal(doc.getAuthor(), 'CLI')
  assert.match(doc.getKeywords() ?? '', /pdf/)

  const relu = vellumPdf(['metadata', out, '--json'])
  const meta = JSON.parse(relu.stdout)
  assert.equal(meta.language, 'fr')
})
