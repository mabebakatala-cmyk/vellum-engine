#!/usr/bin/env node
/**
 * vellum-pdf — traitement de PDF en local, en ligne de commande.
 *
 * Même code que vellumpdf.ch (voir README.md) : aucune commande de ce
 * fichier ne fait de requête réseau. Tout est lu et écrit sur le disque
 * local via node:fs.
 */
import { parseArgs } from 'node:util'
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs'
import { dirname, join, basename } from 'node:path'

import { loadPdf, savePdf, baseName, parsePageRanges } from '../dist/pdf.js'
import { applyBatchOp, batchFilename } from '../dist/batch.js'
import { decryptPdf, encryptPdf } from '../dist/qpdf.js'
import { inspecterPdf } from '../dist/inspect.js'
import { controlerAccessibilite } from '../dist/accessibilite.js'
import { convertToPdfA } from '../dist/pdfa.js'
import { lireOutline, ecrireOutline } from '../dist/outline.js'
import { listAttachments, zipAttachments, appliquerPiecesJointes, devinerMimeType } from '../dist/attachments.js'
import { verifierSignatures } from '../dist/verifsig.js'
import { chargerPdfLib } from '../dist/bibliotheques.js'

const PROGRAMME = 'vellum-pdf'

class ErreurUtilisateur extends Error {}

function ecrireSortie(chemin, octets) {
  mkdirSync(dirname(chemin) === '' ? '.' : dirname(chemin), { recursive: true })
  writeFileSync(chemin, octets)
}

function lireEntree(chemin) {
  try {
    // pdfjs-dist refuse un Buffer Node (sous-classe stricte de Uint8Array) :
    // toujours une copie en Uint8Array « pur ».
    const buffer = readFileSync(chemin)
    return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  } catch (e) {
    throw new ErreurUtilisateur(`Impossible de lire « ${chemin} » : ${e.message}`)
  }
}

function afficherJsonOuTexte(donnees, json, versTexte) {
  if (json) {
    console.log(JSON.stringify(donnees, null, 2))
  } else {
    console.log(versTexte(donnees))
  }
}

function exigerSortie(o) {
  if (!o) throw new ErreurUtilisateur('Option --output/-o requise.')
  return o
}

// ---------------------------------------------------------------------------
// Aide générale
// ---------------------------------------------------------------------------

const COMMANDES = [
  ['merge', 'Fusionne plusieurs PDF en un seul, dans l\'ordre donné.'],
  ['split', 'Découpe un PDF en plusieurs fichiers, par plages ou une page par fichier.'],
  ['extract-pages', 'Extrait des pages dans un nouveau PDF.'],
  ['remove-pages', 'Retire des pages d\'un PDF.'],
  ['rotate', 'Fait pivoter toutes les pages d\'un PDF.'],
  ['page-numbers', 'Ajoute une pagination en bas de chaque page.'],
  ['watermark', 'Appose un filigrane texte sur chaque page.'],
  ['metadata', 'Lit ou écrit le titre, l\'auteur, le sujet, les mots-clés, la langue.'],
  ['flatten', 'Fige les champs de formulaire d\'un PDF.'],
  ['inspect', 'Rapport d\'inspection structurelle du PDF (JSON).'],
  ['accessibility', 'Rapport de contrôle d\'accessibilité (PDF/UA, partiel — voir README).'],
  ['pdfa', 'Convertit vers PDF/A-2B, mode « fidèle » (sans garantie de conformité).'],
  ['sanitize', 'Retire les mécanismes d\'automatisation (OpenAction, JavaScript, actions).'],
  ['bookmarks', 'Lit ou écrit les signets (table des matières) d\'un PDF.'],
  ['attachments', 'Liste, extrait ou ajoute des pièces jointes.'],
  ['protect', 'Chiffre un PDF avec un mot de passe (AES-256).'],
  ['unlock', 'Déchiffre un PDF protégé par mot de passe.'],
  ['compress', 'Réduit le poids d\'un PDF en rastérisant ses pages.'],
  ['verify-signature', 'Vérifie les signatures numériques d\'un PDF (rapport JSON).'],
]

function aideGenerale() {
  const lignes = COMMANDES.map(([nom, desc]) => `  ${nom.padEnd(18)} ${desc}`).join('\n')
  return `${PROGRAMME} — traitement de PDF en local, sans réseau.

Usage : ${PROGRAMME} <commande> [options]

Commandes :
${lignes}

Aide d'une commande : ${PROGRAMME} <commande> --help
`
}

// ---------------------------------------------------------------------------
// merge
// ---------------------------------------------------------------------------

async function cmdMerge(args) {
  const { values, positionals } = parseArgs({
    args,
    options: { output: { type: 'string', short: 'o' }, help: { type: 'boolean' } },
    allowPositionals: true,
  })
  if (values.help || positionals.length === 0) {
    console.log(`${PROGRAMME} merge <fichier.pdf...> -o <sortie.pdf>\n\nFusionne les PDF donnés, dans l'ordre de la ligne de commande.`)
    return
  }
  const sortie = exigerSortie(values.output)
  const pdfLib = await chargerPdfLib()
  const out = await pdfLib.PDFDocument.create()
  for (const chemin of positionals) {
    const src = await pdfLib.PDFDocument.load(lireEntree(chemin))
    const pages = await out.copyPages(src, src.getPageIndices())
    pages.forEach((p) => out.addPage(p))
  }
  ecrireSortie(sortie, await out.save({ useObjectStreams: true }))
  console.log(`${positionals.length} fichier(s) fusionné(s) -> ${sortie}`)
}

// ---------------------------------------------------------------------------
// split
// ---------------------------------------------------------------------------

async function cmdSplit(args) {
  const { values, positionals } = parseArgs({
    args,
    options: {
      output: { type: 'string', short: 'o' },
      ranges: { type: 'string' },
      'one-page-per-file': { type: 'boolean' },
      help: { type: 'boolean' },
    },
    allowPositionals: true,
  })
  if (values.help || positionals.length !== 1) {
    console.log(`${PROGRAMME} split <fichier.pdf> -o <dossier> [--ranges "1-3;5;7-8"] [--one-page-per-file]\n\nDécoupe le PDF en plusieurs fichiers : soit un fichier par groupe de\n--ranges (groupes séparés par ";", chaque groupe accepte "1-3,5" comme les\nautres commandes), soit une page par fichier avec --one-page-per-file.`)
    return
  }
  const dossier = exigerSortie(values.output)
  const entree = positionals[0]
  const pdfLib = await chargerPdfLib()
  const src = await pdfLib.PDFDocument.load(lireEntree(entree))
  const pageCount = src.getPageCount()
  const nomBase = baseName(basename(entree))
  mkdirSync(dossier, { recursive: true })

  let groupes
  if (values['one-page-per-file']) {
    groupes = Array.from({ length: pageCount }, (_, i) => [i])
  } else if (values.ranges) {
    groupes = values.ranges.split(';').map((seg) => parsePageRanges(seg.trim(), pageCount))
  } else {
    throw new ErreurUtilisateur('Préciser --ranges ou --one-page-per-file.')
  }

  let n = 0
  for (const indices of groupes) {
    if (indices.length === 0) continue
    n++
    const out = await pdfLib.PDFDocument.create()
    const pages = await out.copyPages(src, indices)
    pages.forEach((p) => out.addPage(p))
    const chemin = join(dossier, `${nomBase}-${n}.pdf`)
    ecrireSortie(chemin, await out.save({ useObjectStreams: true }))
  }
  console.log(`${n} fichier(s) écrit(s) dans ${dossier}`)
}

// ---------------------------------------------------------------------------
// extract-pages / remove-pages
// ---------------------------------------------------------------------------

async function cmdExtractOuRemove(args, retirer) {
  const nomCmd = retirer ? 'remove-pages' : 'extract-pages'
  const { values, positionals } = parseArgs({
    args,
    options: { output: { type: 'string', short: 'o' }, ranges: { type: 'string' }, help: { type: 'boolean' } },
    allowPositionals: true,
  })
  if (values.help || positionals.length !== 1 || !values.ranges) {
    const verbe = retirer ? 'à retirer' : 'à garder'
    console.log(`${PROGRAMME} ${nomCmd} <fichier.pdf> -o <sortie.pdf> --ranges "1-3,5" (pages ${verbe})`)
    return
  }
  const sortie = exigerSortie(values.output)
  const pdfLib = await chargerPdfLib()
  const src = await pdfLib.PDFDocument.load(lireEntree(positionals[0]))
  const pageCount = src.getPageCount()
  const donnees = new Set(parsePageRanges(values.ranges, pageCount))
  const indices = retirer
    ? Array.from({ length: pageCount }, (_, i) => i).filter((i) => !donnees.has(i))
    : [...donnees].sort((a, b) => a - b)
  if (indices.length === 0) throw new ErreurUtilisateur('Aucune page sélectionnée : le PDF de sortie serait vide.')
  const out = await pdfLib.PDFDocument.create()
  const pages = await out.copyPages(src, indices)
  pages.forEach((p) => out.addPage(p))
  ecrireSortie(sortie, await out.save({ useObjectStreams: true }))
  console.log(`${indices.length}/${pageCount} page(s) dans ${sortie}`)
}

// ---------------------------------------------------------------------------
// rotate / page-numbers / watermark / flatten / compress — via batch.ts
// (même logique que l'outil « Traiter en lot » de vellumpdf.ch).
// ---------------------------------------------------------------------------

async function cmdBatchOp(op, args, { optionsSchema = {}, aide, construireOpts }) {
  const { values, positionals } = parseArgs({
    args,
    options: { output: { type: 'string', short: 'o' }, help: { type: 'boolean' }, ...optionsSchema },
    allowPositionals: true,
  })
  if (values.help || positionals.length !== 1) {
    console.log(aide)
    return
  }
  const sortie = exigerSortie(values.output)
  const entree = lireEntree(positionals[0])
  const resultat = await applyBatchOp(op, entree, construireOpts ? construireOpts(values) : {})
  ecrireSortie(sortie, resultat)
  console.log(`Écrit : ${sortie}`)
}

const cmdRotate = (args) =>
  cmdBatchOp('pivoter', args, {
    optionsSchema: { angle: { type: 'string' } },
    aide: `${PROGRAMME} rotate <fichier.pdf> -o <sortie.pdf> [--angle 90|180|270]\n\nFait pivoter TOUTES les pages du document (comme l'outil « Traiter en lot »\nde vellumpdf.ch). Angle ajouté à la rotation existante, 90 par défaut.`,
    construireOpts: (v) => ({ angle: v.angle ? Number(v.angle) : undefined }),
  })

const cmdPageNumbers = (args) =>
  cmdBatchOp('numeroter', args, {
    aide: `${PROGRAMME} page-numbers <fichier.pdf> -o <sortie.pdf>\n\nAjoute « n / total » en bas de chaque page.`,
  })

const cmdWatermark = (args) =>
  cmdBatchOp('filigrane', args, {
    optionsSchema: { text: { type: 'string' }, opacity: { type: 'string' } },
    aide: `${PROGRAMME} watermark <fichier.pdf> -o <sortie.pdf> [--text "CONFIDENTIEL"] [--opacity 0.18]`,
    construireOpts: (v) => ({ texte: v.text, opacite: v.opacity ? Number(v.opacity) : undefined }),
  })

const cmdFlatten = (args) =>
  cmdBatchOp('aplatir', args, {
    aide: `${PROGRAMME} flatten <fichier.pdf> -o <sortie.pdf>\n\nFige les champs de formulaire (AcroForm). Un document sans champ est copié tel quel.`,
  })

const cmdCompress = (args) =>
  cmdBatchOp('compresser', args, {
    optionsSchema: { quality: { type: 'string' } },
    aide: `${PROGRAMME} compress <fichier.pdf> -o <sortie.pdf> [--quality 0.72]\n\nRastérise chaque page en JPEG (pdf.js + @napi-rs/canvas) : réduit le poids,\nle texte n'est plus sélectionnable. Qualité JPEG 0–1, 0.72 par défaut.`,
    construireOpts: (v) => ({ qualite: v.quality ? Number(v.quality) : undefined }),
  })

// ---------------------------------------------------------------------------
// protect / unlock — qpdf (WebAssembly)
// ---------------------------------------------------------------------------

async function cmdProtect(args) {
  const { values, positionals } = parseArgs({
    args,
    options: {
      output: { type: 'string', short: 'o' },
      password: { type: 'string' },
      'owner-password': { type: 'string' },
      help: { type: 'boolean' },
    },
    allowPositionals: true,
  })
  if (values.help || positionals.length !== 1 || !values.password) {
    console.log(`${PROGRAMME} protect <fichier.pdf> -o <sortie.pdf> --password <mot de passe> [--owner-password <mot de passe>]\n\nChiffre en AES-256 (qpdf). Le mot de passe ne doit pas commencer par « - ».`)
    return
  }
  const sortie = exigerSortie(values.output)
  const res = await encryptPdf(lireEntree(positionals[0]), values.password, values['owner-password'])
  if (!res.ok || !res.output) throw new ErreurUtilisateur(`Échec du chiffrement (code ${res.code}) : ${res.stderr || 'raison inconnue'}`)
  ecrireSortie(sortie, res.output)
  console.log(`Écrit (chiffré) : ${sortie}`)
}

async function cmdUnlock(args) {
  const { values, positionals } = parseArgs({
    args,
    options: { output: { type: 'string', short: 'o' }, password: { type: 'string' }, help: { type: 'boolean' } },
    allowPositionals: true,
  })
  if (values.help || positionals.length !== 1) {
    console.log(`${PROGRAMME} unlock <fichier.pdf> -o <sortie.pdf> [--password <mot de passe>]\n\nDéchiffre (qpdf). Sans --password, ne fonctionne que sur un PDF restreint\nmais à ouverture libre.`)
    return
  }
  const sortie = exigerSortie(values.output)
  const res = await decryptPdf(lireEntree(positionals[0]), values.password ?? '')
  if (!res.ok || !res.output) throw new ErreurUtilisateur(`Échec du déchiffrement (code ${res.code}) : ${res.stderr || 'mot de passe manquant ou incorrect'}`)
  ecrireSortie(sortie, res.output)
  console.log(`Écrit (déchiffré) : ${sortie}`)
}

// ---------------------------------------------------------------------------
// metadata
// ---------------------------------------------------------------------------

function lireLangueCatalogue(doc, pdfLib) {
  try {
    const val = doc.catalog.lookup(pdfLib.PDFName.of('Lang'))
    return typeof val?.decodeText === 'function' ? val.decodeText() : null
  } catch {
    return null
  }
}

async function cmdMetadata(args) {
  const { values, positionals } = parseArgs({
    args,
    options: {
      output: { type: 'string', short: 'o' },
      json: { type: 'boolean' },
      'set-title': { type: 'string' },
      'set-author': { type: 'string' },
      'set-subject': { type: 'string' },
      'set-keywords': { type: 'string' },
      'set-language': { type: 'string' },
      help: { type: 'boolean' },
    },
    allowPositionals: true,
  })
  if (values.help || positionals.length !== 1) {
    console.log(`${PROGRAMME} metadata <fichier.pdf> [--json]\n${PROGRAMME} metadata <fichier.pdf> -o <sortie.pdf> [--set-title T] [--set-author A] [--set-subject S] [--set-keywords "a,b,c"] [--set-language fr]\n\nSans --set-*, affiche les métadonnées actuelles. Avec au moins un --set-*, écrit un nouveau fichier (-o requis).`)
    return
  }
  const pdfLib = await chargerPdfLib()
  const doc = await pdfLib.PDFDocument.load(lireEntree(positionals[0]))

  const veutEcrire = ['set-title', 'set-author', 'set-subject', 'set-keywords', 'set-language'].some((k) => values[k] !== undefined)
  if (veutEcrire) {
    const sortie = exigerSortie(values.output)
    if (values['set-title'] !== undefined) doc.setTitle(values['set-title'])
    if (values['set-author'] !== undefined) doc.setAuthor(values['set-author'])
    if (values['set-subject'] !== undefined) doc.setSubject(values['set-subject'])
    if (values['set-keywords'] !== undefined) doc.setKeywords(values['set-keywords'].split(',').map((s) => s.trim()).filter(Boolean))
    if (values['set-language'] !== undefined) doc.setLanguage(values['set-language'])
    ecrireSortie(sortie, await doc.save({ useObjectStreams: true }))
    console.log(`Écrit : ${sortie}`)
    return
  }

  const meta = {
    title: doc.getTitle() ?? null,
    author: doc.getAuthor() ?? null,
    subject: doc.getSubject() ?? null,
    keywords: doc.getKeywords() ?? null,
    language: await lireLangueCatalogue(doc, pdfLib),
    pageCount: doc.getPageCount(),
    creator: doc.getCreator() ?? null,
    producer: doc.getProducer() ?? null,
  }
  afficherJsonOuTexte(meta, values.json, (m) =>
    Object.entries(m).map(([k, v]) => `${k.padEnd(11)} : ${v === null ? '(non défini)' : v}`).join('\n'),
  )
}

// ---------------------------------------------------------------------------
// inspect / accessibility / verify-signature — rapports en lecture seule
// ---------------------------------------------------------------------------

async function cmdInspect(args) {
  const { values, positionals } = parseArgs({ args, options: { json: { type: 'boolean' }, help: { type: 'boolean' } }, allowPositionals: true })
  if (values.help || positionals.length !== 1) {
    console.log(`${PROGRAMME} inspect <fichier.pdf> [--json]\n\nRapport d'inspection structurelle (pages, polices, formulaire, pièces jointes, signatures détectées...).`)
    return
  }
  const rapport = await inspecterPdf(lireEntree(positionals[0]))
  afficherJsonOuTexte(rapport, values.json, () => JSON.stringify(rapport, null, 2))
}

async function cmdAccessibility(args) {
  const { values, positionals } = parseArgs({ args, options: { json: { type: 'boolean' }, help: { type: 'boolean' } }, allowPositionals: true })
  if (values.help || positionals.length !== 1) {
    console.log(`${PROGRAMME} accessibility <fichier.pdf> [--json]\n\nRapport de contrôle d'accessibilité (titre, langue, contraste, structure...).\nCe n'est PAS un validateur PDF/UA complet — voir README § accessibility.`)
    return
  }
  const rapport = await controlerAccessibilite(lireEntree(positionals[0]))
  afficherJsonOuTexte(rapport, values.json, () => JSON.stringify(rapport, null, 2))
}

async function cmdVerifySignature(args) {
  const { values, positionals } = parseArgs({ args, options: { json: { type: 'boolean' }, help: { type: 'boolean' } }, allowPositionals: true })
  if (values.help || positionals.length !== 1) {
    console.log(`${PROGRAMME} verify-signature <fichier.pdf> [--json]\n\nVérifie les signatures numériques (intégrité, certificat, horodatage).`)
    return
  }
  const rapport = await verifierSignatures(lireEntree(positionals[0]))
  afficherJsonOuTexte(rapport, values.json, () => JSON.stringify(rapport, null, 2))
}

// ---------------------------------------------------------------------------
// pdfa
// ---------------------------------------------------------------------------

async function cmdPdfa(args) {
  const { values, positionals } = parseArgs({
    args,
    options: { output: { type: 'string', short: 'o' }, json: { type: 'boolean' }, help: { type: 'boolean' } },
    allowPositionals: true,
  })
  if (values.help || positionals.length !== 1) {
    console.log(`${PROGRAMME} pdfa <fichier.pdf> -o <sortie.pdf> [--json]\n\nMode « fidèle » (convertToPdfA) : conserve le texte sélectionnable, sans\ngarantie de conformité ISO 19005-2 — voir README § pdfa. Le mode\n« conforme » (rastérisation, conformité vérifiée par veraPDF) n'est pas\nexposé par ce CLI : voir le rapport de sync-engine dans le dépôt privé.`)
    return
  }
  const sortie = exigerSortie(values.output)
  const { bytes, report } = await convertToPdfA(lireEntree(positionals[0]))
  ecrireSortie(sortie, bytes)
  // En --json, stdout ne porte QUE le JSON (sortie machine) : le message de
  // confirmation part sur stderr pour ne jamais casser un `| jq`.
  if (values.json) {
    console.log(JSON.stringify(report, null, 2))
    console.error(`Écrit : ${sortie}`)
  } else {
    console.log(`Actions retirées : ${report.actionsRemoved}\nPolices non incorporées : ${report.nonEmbeddedFonts.length ? report.nonEmbeddedFonts.join(', ') : '(aucune)'}`)
    console.log(`Écrit : ${sortie}`)
  }
}

// ---------------------------------------------------------------------------
// sanitize — réécrit ici (la logique d'origine vit dans une page React du
// dépôt privé, hors périmètre de la liste blanche de sync-engine.mjs) sur
// les mêmes principes : retire /OpenAction, /AA (catalogue et pages), les
// scripts /Names/JavaScript, et les actions JS posées sur une annotation.
// ---------------------------------------------------------------------------

async function estActionJavaScript(pdfLib, action) {
  const { PDFName } = pdfLib
  const subtype = action.lookupMaybe(PDFName.of('S'), PDFName)
  return subtype?.asString?.() === '/JavaScript'
}

async function assainirAnnotation(pdfLib, annot) {
  const { PDFName, PDFDict } = pdfLib
  const N_A = PDFName.of('A')
  const N_AA = PDFName.of('AA')
  let retirees = 0
  const action = annot.lookupMaybe(N_A, PDFDict)
  if (action && (await estActionJavaScript(pdfLib, action))) {
    annot.delete(N_A)
    retirees++
  }
  if (annot.has(N_AA)) {
    annot.delete(N_AA)
    retirees++
  }
  return retirees
}

async function sanitizePdf(bytes) {
  const pdfLib = await chargerPdfLib()
  const { PDFName, PDFDict } = pdfLib
  const N_OPEN_ACTION = PDFName.of('OpenAction')
  const N_AA = PDFName.of('AA')
  const N_NAMES = PDFName.of('Names')
  const N_JAVASCRIPT = PDFName.of('JavaScript')

  const doc = await loadPdf(bytes)
  const catalog = doc.catalog
  const rapport = { openActionRetiree: false, actionsRetirees: 0, scriptsRetires: 0 }

  if (catalog.has(N_OPEN_ACTION)) {
    catalog.delete(N_OPEN_ACTION)
    rapport.openActionRetiree = true
  }
  if (catalog.has(N_AA)) {
    catalog.delete(N_AA)
    rapport.actionsRetirees++
  }
  const names = catalog.lookupMaybe(N_NAMES, PDFDict)
  if (names?.has(N_JAVASCRIPT)) {
    names.delete(N_JAVASCRIPT)
    rapport.scriptsRetires++
  }
  for (const page of doc.getPages()) {
    const node = page.node
    if (node.has(N_AA)) {
      node.delete(N_AA)
      rapport.actionsRetirees++
    }
    const annots = node.Annots?.()
    if (!annots) continue
    for (let i = 0; i < annots.size(); i++) {
      const annot = annots.lookupMaybe(i, PDFDict)
      if (annot) rapport.actionsRetirees += await assainirAnnotation(pdfLib, annot)
    }
  }

  return { bytes: await savePdf(doc), rapport }
}

async function cmdSanitize(args) {
  const { values, positionals } = parseArgs({
    args,
    options: { output: { type: 'string', short: 'o' }, json: { type: 'boolean' }, help: { type: 'boolean' } },
    allowPositionals: true,
  })
  if (values.help || positionals.length !== 1) {
    console.log(`${PROGRAMME} sanitize <fichier.pdf> -o <sortie.pdf> [--json]\n\nRetire /OpenAction, /AA (catalogue, pages, annotations) et les scripts\n/Names/JavaScript. N'analyse ni les images, ni les polices, ni les flux\nbinaires embarqués : ce n'est pas un antivirus.`)
    return
  }
  const sortie = exigerSortie(values.output)
  const { bytes, rapport } = await sanitizePdf(lireEntree(positionals[0]))
  ecrireSortie(sortie, bytes)
  if (values.json) {
    console.log(JSON.stringify(rapport, null, 2))
    console.error(`Écrit : ${sortie}`)
  } else {
    console.log(`OpenAction retirée : ${rapport.openActionRetiree}\nActions /AA retirées : ${rapport.actionsRetirees}\nScripts retirés : ${rapport.scriptsRetires}`)
    console.log(`Écrit : ${sortie}`)
  }
}

// ---------------------------------------------------------------------------
// bookmarks
// ---------------------------------------------------------------------------

async function cmdBookmarks(args) {
  const { values, positionals } = parseArgs({
    args,
    options: { output: { type: 'string', short: 'o' }, set: { type: 'string' }, json: { type: 'boolean' }, help: { type: 'boolean' } },
    allowPositionals: true,
  })
  if (values.help || positionals.length !== 1) {
    console.log(`${PROGRAMME} bookmarks <fichier.pdf> [--json]\n${PROGRAMME} bookmarks <fichier.pdf> --set <signets.json> -o <sortie.pdf>\n\nLecture : liste les signets. Écriture : --set prend un fichier JSON\n[{ "title": "...", "pageIndex": 0, "level": 0 }, ...] (page 0-based, level 0 = racine).`)
    return
  }
  const entree = lireEntree(positionals[0])
  if (values.set) {
    const sortie = exigerSortie(values.output)
    const entrees = JSON.parse(readFileSync(values.set, 'utf8'))
    const pdfLib = await chargerPdfLib()
    const doc = await pdfLib.PDFDocument.load(entree)
    await ecrireOutline(doc, entrees)
    ecrireSortie(sortie, await doc.save({ useObjectStreams: true }))
    console.log(`${entrees.length} signet(s) écrit(s) -> ${sortie}`)
    return
  }
  const entrees = await lireOutline(entree)
  afficherJsonOuTexte(entrees, values.json, (liste) =>
    liste.length === 0
      ? '(aucun signet)'
      : liste.map((e) => `${'  '.repeat(e.level)}- ${e.title} (page ${e.pageIndex + 1})`).join('\n'),
  )
}

// ---------------------------------------------------------------------------
// attachments
// ---------------------------------------------------------------------------

async function cmdAttachments(args) {
  const [sousCommande, ...reste] = args
  if (!sousCommande || sousCommande === '--help' || sousCommande === '-h') {
    console.log(`${PROGRAMME} attachments list <fichier.pdf> [--json]\n${PROGRAMME} attachments extract <fichier.pdf> -o <dossier>\n${PROGRAMME} attachments add <fichier.pdf> --file <pièce...> -o <sortie.pdf>`)
    return
  }

  if (sousCommande === 'list') {
    const { values, positionals } = parseArgs({ args: reste, options: { json: { type: 'boolean' } }, allowPositionals: true })
    if (positionals.length !== 1) throw new ErreurUtilisateur('attachments list <fichier.pdf>')
    const pieces = await listAttachments(lireEntree(positionals[0]))
    // La liste ne montre pas `bytes` (contenu brut, déjà lourd en JSON) :
    // c'est `attachments extract` qui donne accès au contenu.
    const allegees = pieces.map(({ name, size, description, mime }) => ({ name, size, description, mime }))
    afficherJsonOuTexte(allegees, values.json, (liste) =>
      liste.length === 0 ? '(aucune pièce jointe)' : liste.map((p) => `${p.name}  (${p.size} o, ${p.mime})`).join('\n'),
    )
    return
  }

  if (sousCommande === 'extract') {
    const { values, positionals } = parseArgs({ args: reste, options: { output: { type: 'string', short: 'o' } }, allowPositionals: true })
    if (positionals.length !== 1) throw new ErreurUtilisateur('attachments extract <fichier.pdf> -o <dossier>')
    const dossier = exigerSortie(values.output)
    const octets = lireEntree(positionals[0])
    const pieces = await listAttachments(octets)
    if (pieces.length === 0) {
      console.log('(aucune pièce jointe)')
      return
    }
    mkdirSync(dossier, { recursive: true })
    const zip = await zipAttachments(pieces)
    const JSZipCtor = (await import('jszip')).default
    const archive = await JSZipCtor.loadAsync(Buffer.from(await zip.arrayBuffer()))
    for (const [nom, entree] of Object.entries(archive.files)) {
      if (entree.dir) continue
      ecrireSortie(join(dossier, nom), Buffer.from(await entree.async('nodebuffer')))
    }
    console.log(`${pieces.length} pièce(s) extraite(s) dans ${dossier}`)
    return
  }

  if (sousCommande === 'add') {
    const { values, positionals } = parseArgs({
      args: reste,
      options: { output: { type: 'string', short: 'o' }, file: { type: 'string', multiple: true } },
      allowPositionals: true,
    })
    if (positionals.length !== 1 || !values.file?.length) {
      throw new ErreurUtilisateur('attachments add <fichier.pdf> --file <pièce...> -o <sortie.pdf>')
    }
    const sortie = exigerSortie(values.output)
    const aAjouter = values.file.map((chemin) => ({
      name: basename(chemin),
      data: new Uint8Array(readFileSync(chemin)),
      mimeType: devinerMimeType(basename(chemin)),
    }))
    const resultat = await appliquerPiecesJointes(lireEntree(positionals[0]), new Set(), aAjouter)
    ecrireSortie(sortie, resultat)
    console.log(`${aAjouter.length} pièce(s) ajoutée(s) -> ${sortie}`)
    return
  }

  throw new ErreurUtilisateur(`Sous-commande inconnue : attachments ${sousCommande}`)
}

// ---------------------------------------------------------------------------
// Répartition
// ---------------------------------------------------------------------------

const DISPATCH = {
  merge: cmdMerge,
  split: cmdSplit,
  'extract-pages': (a) => cmdExtractOuRemove(a, false),
  'remove-pages': (a) => cmdExtractOuRemove(a, true),
  rotate: cmdRotate,
  'page-numbers': cmdPageNumbers,
  watermark: cmdWatermark,
  metadata: cmdMetadata,
  flatten: cmdFlatten,
  inspect: cmdInspect,
  accessibility: cmdAccessibility,
  pdfa: cmdPdfa,
  sanitize: cmdSanitize,
  bookmarks: cmdBookmarks,
  attachments: cmdAttachments,
  protect: cmdProtect,
  unlock: cmdUnlock,
  compress: cmdCompress,
  'verify-signature': cmdVerifySignature,
}

async function main() {
  const [commande, ...reste] = process.argv.slice(2)
  if (!commande || commande === '--help' || commande === '-h') {
    console.log(aideGenerale())
    process.exit(commande ? 0 : 1)
  }
  const fn = DISPATCH[commande]
  if (!fn) {
    console.error(`Commande inconnue : ${commande}\n`)
    console.log(aideGenerale())
    process.exit(1)
  }
  try {
    await fn(reste)
  } catch (e) {
    if (e instanceof ErreurUtilisateur) {
      console.error(`Erreur : ${e.message}`)
      process.exit(1)
    }
    console.error(`Erreur inattendue (${commande}) : ${e.stack || e.message}`)
    process.exit(1)
  }
}

main()
