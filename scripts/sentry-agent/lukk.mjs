// Markerer Sentry-saken løst når fiksen merges (FRA-1976), uansett om agenten eller et menneske merget.
// Kobling: merget PR → Linear-ID først i et segment av branchnavnet → Sentry-lenker (numerisk ID eller kort-ID) i
// vedleggene og beskrivelsen på Linear-saken → Sentry-sak. Bare saker fra et prosjekt som hører til nettopp dette repoet
// i sentry-repoer.json røres. PR-tittelen brukes ikke: den gir for mange falske treff.
//
// CLI:
//   node scripts/sentry-agent/lukk.mjs --linear <branch> <team.json>                      →  ["FRA-123", ...]
//   node scripts/sentry-agent/lukk.mjs --linear-saker <saker.json> <org>                  →  ["4567", ...]
//        saker.json: [{ vedlegg: [url, ...], beskrivelse: "..." }, ...]
//   node scripts/sentry-agent/lukk.mjs --vurder <sak.json> <owner/repo> [kart]           →  {lukk, grunn}
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { finnRepo } from './oppslag.mjs'

export const MAKS_SAKER = 10

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Linear-ID-er i branchnavnet, bare når ID-en står først i et /-segment og etterfølges av «-», «/» eller slutt
 * (fix/FRA-123-kort, sentry/fra-45-…). Datoer som gr-2026-11-13 avvises. Store bokstaver, unike, maks MAKS_SAKER.
 */
export function linearIder(branch, teamNokler) {
  if (typeof branch !== 'string' || !Array.isArray(teamNokler)) return []
  const nokler = teamNokler.filter((k) => typeof k === 'string' && /^[A-Za-z0-9]{1,10}$/.test(k))
  if (nokler.length === 0) return []
  const monster = new RegExp(`^(${nokler.map(escapeRegex).join('|')})-(\\d{1,7})(?:-(?!\\d)|$)`, 'i')
  const ut = []
  for (const segment of branch.split('/')) {
    const m = segment.match(monster)
    if (!m) continue
    const id = `${m[1].toUpperCase()}-${m[2]}`
    if (!ut.includes(id)) ut.push(id)
    if (ut.length >= MAKS_SAKER) break
  }
  return ut
}

/**
 * Sentry-saks-referanser fra URL-er i organisasjonen org: numerisk ID eller kort-ID (MOBILE-DRIFT-3, store bokstaver).
 * Begge godtas av issues/{ref}/ i Sentry-API-et. Unike, maks MAKS_SAKER.
 */
export function sentryIder(urler, org) {
  if (typeof org !== 'string' || !/^[a-z0-9-]{1,64}$/.test(org)) return []
  const o = escapeRegex(org)
  const ref = '(\\d{1,20}|[A-Za-z0-9][A-Za-z0-9-]{0,98}-[A-Za-z0-9]{1,10})'
  const hale = '(?:/[A-Za-z0-9_/-]*)?(?:[?#].*)?$'
  const monstre = [
    new RegExp(`^https://${o}\\.sentry\\.io/issues/${ref}${hale}`),
    new RegExp(`^https://(?:[a-z]{2}\\.)?sentry\\.io/organizations/${o}/issues/${ref}${hale}`),
  ]
  const ut = []
  for (const u of Array.isArray(urler) ? urler : []) {
    if (typeof u !== 'string') continue
    for (const m of monstre) {
      const treff = u.match(m)
      const id = treff?.[1].toUpperCase()
      if (id && !ut.includes(id)) ut.push(id)
    }
    if (ut.length >= MAKS_SAKER) break
  }
  return ut
}

/**
 * Sentry-referanser fra lenker i fritekst (Linear-beskrivelse i markdown). Flere saker godtas: en feil lukking er
 * selvkorrigerende, fordi «løst i neste release» gjenåpnes som regresjon hvis feilen kommer igjen.
 */
export function sentryIderITekst(tekst, org) {
  if (typeof tekst !== 'string') return []
  return sentryIder(tekst.match(/https:\/\/[^\s<>()[\]"'`]+/g) ?? [], org)
}

/** Sentry-referanser for Linear-sakene: vedlegg og lenker i beskrivelsen. Unike, maks MAKS_SAKER. */
export function sentryIderForSaker(saker, org) {
  const ut = []
  for (const s of Array.isArray(saker) ? saker : []) {
    for (const id of [...sentryIder(s?.vedlegg, org), ...sentryIderITekst(s?.beskrivelse, org)]) {
      if (!ut.includes(id)) ut.push(id)
    }
  }
  return ut.slice(0, MAKS_SAKER)
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
  if (modus === '--linear') ut = linearIder(a, lesJson(b))
  else if (modus === '--linear-saker') ut = sentryIderForSaker(lesJson(a), b)
  else if (modus === '--vurder') ut = vurderLukk(lesJson(a), b, lesJson(c))
  else {
    console.error('Bruk: lukk.mjs --linear <branch> <team.json> | --linear-saker <saker.json> <org> | --vurder <sak.json> <owner/repo> [kart]')
    process.exit(2)
  }
  process.stdout.write(JSON.stringify(ut) + '\n')
}
