// Markerer Sentry-saken løst når fiksen merges (FRA-1976), uansett om agenten eller et menneske merget.
// Kobling: merget PR → Linear-ID i branch eller tittel → Sentry-vedlegg eller lenke i beskrivelsen på Linear-saken → Sentry-sak.
// Bare saker fra et prosjekt som hører til nettopp dette repoet i sentry-repoer.json røres.
//
// CLI (alle filer er JSON):
//   node scripts/sentry-agent/lukk.mjs --linear <tekster.json> <team.json>       →  ["FRA-123", ...]
//   node scripts/sentry-agent/lukk.mjs --sentry <urler.json> <org>               →  ["4567", ...]
//   node scripts/sentry-agent/lukk.mjs --sentry-tekst <tekster.json> <org>       →  ["4567", ...] (lenker i fritekst)
//   node scripts/sentry-agent/lukk.mjs --vurder <sak.json> <owner/repo> [kart]   →  {lukk, grunn}
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { finnRepo } from './oppslag.mjs'

export const MAKS_SAKER = 10

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Linear-ID-er (f.eks. FRA-123) i tekstene, bare for kjente team-nøkler. Store bokstaver, unike, maks MAKS_SAKER. */
export function linearIder(tekster, teamNokler) {
  if (!Array.isArray(teamNokler) || teamNokler.length === 0) return []
  const nokler = teamNokler.filter((k) => typeof k === 'string' && /^[A-Za-z0-9]{1,10}$/.test(k))
  if (nokler.length === 0) return []
  const monster = new RegExp(`(?<![A-Za-z0-9])(${nokler.map(escapeRegex).join('|')})-(\\d{1,7})(?![A-Za-z0-9])`, 'gi')
  const ut = []
  for (const t of Array.isArray(tekster) ? tekster : []) {
    if (typeof t !== 'string') continue
    for (const m of t.matchAll(monster)) {
      const id = `${m[1].toUpperCase()}-${m[2]}`
      if (!ut.includes(id)) ut.push(id)
      if (ut.length >= MAKS_SAKER) return ut
    }
  }
  return ut
}

/** Numeriske Sentry-saks-ID-er fra vedleggs-URL-er i organisasjonen org. Unike, maks MAKS_SAKER. */
export function sentryIder(urler, org) {
  if (typeof org !== 'string' || !/^[a-z0-9-]{1,64}$/.test(org)) return []
  const o = escapeRegex(org)
  const monstre = [
    new RegExp(`^https://${o}\\.sentry\\.io/issues/(\\d{1,20})/?(?:[?#].*)?$`),
    new RegExp(`^https://(?:[a-z]{2}\\.)?sentry\\.io/organizations/${o}/issues/(\\d{1,20})/?(?:[?#].*)?$`),
  ]
  const ut = []
  for (const u of Array.isArray(urler) ? urler : []) {
    if (typeof u !== 'string') continue
    for (const m of monstre) {
      const treff = u.match(m)
      if (treff && !ut.includes(treff[1])) ut.push(treff[1])
    }
    if (ut.length >= MAKS_SAKER) break
  }
  return ut
}

/** Sentry-ID-er fra lenker i fritekst (f.eks. Linear-beskrivelse i markdown). Samme regler som sentryIder. */
export function sentryIderITekst(tekst, org) {
  if (typeof tekst !== 'string') return []
  return sentryIder(tekst.match(/https:\/\/[^\s<>()[\]"'`]+/g) ?? [], org)
}

/** Skal saken markeres løst fra dette repoet? Bare uløste saker fra et agent-prosjekt som peker på repoet. */
export function vurderLukk(issue, repo, kart) {
  if (!issue || typeof issue !== 'object') return { lukk: false, grunn: 'Fant ikke Sentry-saken' }
  const slug = issue.project?.slug
  const rad = finnRepo(slug, kart)
  if (!rad) return { lukk: false, grunn: `Prosjektet «${slug ?? 'ukjent'}» har ingen agent i sentry-repoer.json` }
  if (typeof repo !== 'string' || rad.repo.toLowerCase() !== repo.toLowerCase()) {
    return { lukk: false, grunn: `${slug} hører til ${rad.repo}, ikke ${repo}` }
  }
  if (issue.status === 'resolved') return { lukk: false, grunn: 'Saken er allerede løst' }
  if (issue.status !== 'unresolved') return { lukk: false, grunn: `Saken har status ${issue.status ?? 'ukjent'} og røres ikke` }
  return { lukk: true, grunn: '' }
}

const lesJson = (fil) => JSON.parse(readFileSync(fil, 'utf8'))
const KART = fileURLToPath(new URL('../../sentry-repoer.json', import.meta.url))

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [modus, a, b, c = KART] = process.argv.slice(2)
  let ut
  if (modus === '--linear') ut = linearIder(lesJson(a), lesJson(b))
  else if (modus === '--sentry') ut = sentryIder(lesJson(a), b)
  else if (modus === '--sentry-tekst') {
    const tekster = lesJson(a)
    ut = [...new Set((Array.isArray(tekster) ? tekster : []).flatMap((t) => sentryIderITekst(t, b)))].slice(0, MAKS_SAKER)
  } else if (modus === '--vurder') ut = vurderLukk(lesJson(a), b, lesJson(c))
  else {
    console.error('Bruk: lukk.mjs --linear <tekster.json> <team.json> | --sentry <urler.json> <org> | --vurder <sak.json> <owner/repo> [kart]')
    process.exit(2)
  }
  process.stdout.write(JSON.stringify(ut) + '\n')
}
