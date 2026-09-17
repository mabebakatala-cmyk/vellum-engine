/**
 * Généré depuis vellum-pdf/src/lib/outline.ts — ne pas éditer ici.
 * Source de vérité : le dépôt privé vellum-pdf, via scripts/sync-engine.mjs.
 */

import type { PDFDict, PDFDocument, PDFRef } from 'pdf-lib'
import { closePdfJsDoc, openPdfJsDoc } from './pdf.ts'
// Chargement différé de pdf-lib, au premier usage réel (voir bibliotheques.ts).
import { chargerPdfLib } from './bibliotheques.ts'

/**
 * Signets (outline, ou « table des matières » d'un PDF).
 *
 * Le modèle manipulé par l'interface est volontairement PLAT : une liste
 * ordonnée d'entrées portant chacune un niveau d'indentation. C'est la forme
 * qu'un utilisateur voit et modifie (monter, descendre, indenter), alors que
 * le PDF stocke un arbre doublement chaîné. La conversion arbre → liste se
 * fait à la lecture, liste → arbre à l'écriture.
 */
export interface OutlineEntry {
  title: string
  /** Page cible, index 0-based. */
  pageIndex: number
  /** 0 = racine ; un enfant porte le niveau de son parent + 1. */
  level: number
}

/* ------------------------------------------------------------------ */
/* Lecture                                                             */
/* ------------------------------------------------------------------ */

/**
 * Résout une destination pdf.js en index de page.
 *
 * Trois formes coexistent dans la nature : une destination nommée (chaîne, à
 * résoudre dans la table /Dests), une destination explicite (tableau dont le
 * premier élément est une référence d'objet), et — sur des fichiers produits
 * par des outils approximatifs — un simple numéro de page. Une destination
 * cassée ou absente (signet purement décoratif, lien externe) ne doit pas
 * faire perdre le titre : on retombe alors sur la première page.
 */
async function resoudrePage(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pdfjsDoc: any,
  dest: unknown,
): Promise<number> {
  try {
    const explicite = typeof dest === 'string' ? await pdfjsDoc.getDestination(dest) : dest
    if (!Array.isArray(explicite) || explicite.length === 0) return 0

    const cible = explicite[0]
    if (typeof cible === 'number') return cible >= 0 ? cible : 0
    if (cible && typeof cible === 'object') {
      const index = await pdfjsDoc.getPageIndex(cible)
      return typeof index === 'number' && index >= 0 ? index : 0
    }
  } catch {
    // Destination illisible : le titre reste utile, la cible retombe sur 1.
  }
  return 0
}

/** Lit les signets d'un document pdf.js déjà ouvert. */
export async function lireOutlineDepuisDoc(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pdfjsDoc: any,
): Promise<OutlineEntry[]> {
  const arbre = await pdfjsDoc.getOutline()
  if (!Array.isArray(arbre) || arbre.length === 0) return []

  const plat: OutlineEntry[] = []
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const parcourir = async (items: any[], level: number): Promise<void> => {
    for (const item of items) {
      plat.push({
        title: typeof item?.title === 'string' ? item.title.trim() : '',
        pageIndex: await resoudrePage(pdfjsDoc, item?.dest),
        level,
      })
      if (Array.isArray(item?.items) && item.items.length > 0) {
        await parcourir(item.items, level + 1)
      }
    }
  }
  await parcourir(arbre, 0)
  return plat
}

/** Lit les signets d'un PDF à partir de ses octets (ouvre puis referme pdf.js). */
export async function lireOutline(bytes: Uint8Array): Promise<OutlineEntry[]> {
  const doc = await openPdfJsDoc(bytes)
  try {
    return await lireOutlineDepuisDoc(doc)
  } finally {
    await closePdfJsDoc(doc)
  }
}

/* ------------------------------------------------------------------ */
/* Normalisation de la liste plate                                     */
/* ------------------------------------------------------------------ */

/**
 * Niveau maximal admissible pour l'entrée d'indice `index` : on ne peut pas
 * sauter un cran, un signet n'est enfant que du signet qui le précède.
 */
export function niveauMax(entrees: OutlineEntry[], index: number): number {
  if (index <= 0) return 0
  return entrees[index - 1].level + 1
}

/**
 * Ramène chaque niveau dans les bornes après une suppression ou un
 * déplacement : jamais négatif, jamais plus d'un cran sous son prédécesseur.
 */
export function normaliserNiveaux(entrees: OutlineEntry[]): OutlineEntry[] {
  const sortie: OutlineEntry[] = []
  for (const [i, e] of entrees.entries()) {
    const level = Math.min(Math.max(0, Math.trunc(e.level) || 0), niveauMax(sortie, i))
    sortie.push({ ...e, level })
  }
  return sortie
}

/* ------------------------------------------------------------------ */
/* Écriture                                                            */
/* ------------------------------------------------------------------ */

interface Noeud {
  titre: string
  page: number
  enfants: Noeud[]
}

/** Reconstruit l'arbre à partir des niveaux de la liste plate. */
function construireArbre(entrees: OutlineEntry[]): Noeud[] {
  const racines: Noeud[] = []
  // `pile[i]` = dernier nœud rencontré au niveau i ; sa longueur donne aussi
  // le niveau maximal autorisé pour l'entrée suivante.
  const pile: Noeud[] = []

  for (const e of entrees) {
    const niveau = Math.min(Math.max(0, Math.trunc(e.level) || 0), pile.length)
    const noeud: Noeud = { titre: e.title, page: e.pageIndex, enfants: [] }
    if (niveau === 0) racines.push(noeud)
    else pile[niveau - 1].enfants.push(noeud)
    pile.length = niveau
    pile.push(noeud)
  }

  return racines
}

interface Fratrie {
  premier: PDFRef
  dernier: PDFRef
  /** Nombre de descendants visibles (tous les items sont ouverts). */
  visibles: number
}

/**
 * Réécrit l'arbre /Outlines du document.
 *
 * Les visionneuses strictes (Acrobat en tête) refusent un sommaire dont le
 * chaînage est incomplet : chaque item doit connaître son parent, son
 * précédent et son suivant, chaque parent son premier et son dernier enfant,
 * et /Count doit valoir le nombre de descendants VISIBLES — positif ici, tous
 * les nœuds étant créés dépliés. Une seule de ces clés manquante et le volet
 * des signets reste vide sans le moindre message.
 *
 * Les références sont réservées avant d'écrire les dictionnaires
 * (`nextRef` puis `assign`) : un item cite son voisin de droite, qui n'existe
 * pas encore au moment où on le rédige.
 */
export async function ecrireOutline(doc: PDFDocument, entrees: OutlineEntry[]): Promise<void> {
  const { PDFHexString, PDFName, PDFNumber } = await chargerPdfLib()
  const context = doc.context
  const catalogue = doc.catalog

  // Purge de l'ancien sommaire : sans cela, les deux coexisteraient.
  catalogue.delete(PDFName.of('Outlines'))
  catalogue.delete(PDFName.of('PageMode'))

  const pages = doc.getPages()
  if (entrees.length === 0 || pages.length === 0) return

  const racineRef = context.nextRef()

  const enregistrer = (noeuds: Noeud[], parentRef: PDFRef): Fratrie => {
    const refs = noeuds.map(() => context.nextRef())
    let visibles = 0

    noeuds.forEach((noeud, i) => {
      const page = Math.min(Math.max(0, Math.trunc(noeud.page) || 0), pages.length - 1)
      const dict: PDFDict = context.obj({
        Title: PDFHexString.fromText(noeud.titre),
        Parent: parentRef,
        // /XYZ avec trois null : « va à cette page, garde la vue actuelle ».
        Dest: context.obj([pages[page].ref, 'XYZ', null, null, null]),
      })

      if (i > 0) dict.set(PDFName.of('Prev'), refs[i - 1])
      if (i < refs.length - 1) dict.set(PDFName.of('Next'), refs[i + 1])

      if (noeud.enfants.length > 0) {
        const sous = enregistrer(noeud.enfants, refs[i])
        dict.set(PDFName.of('First'), sous.premier)
        dict.set(PDFName.of('Last'), sous.dernier)
        dict.set(PDFName.of('Count'), PDFNumber.of(sous.visibles))
        visibles += sous.visibles
      }

      visibles += 1
      context.assign(refs[i], dict)
    })

    return { premier: refs[0], dernier: refs[refs.length - 1], visibles }
  }

  const sommet = enregistrer(construireArbre(entrees), racineRef)

  context.assign(
    racineRef,
    context.obj({
      Type: 'Outlines',
      First: sommet.premier,
      Last: sommet.dernier,
      Count: PDFNumber.of(sommet.visibles),
    }),
  )

  catalogue.set(PDFName.of('Outlines'), racineRef)
  // Ouvre le volet des signets à l'ouverture du document : sans cette clé,
  // un sommaire parfaitement valide passe inaperçu.
  catalogue.set(PDFName.of('PageMode'), PDFName.of('UseOutlines'))
}
