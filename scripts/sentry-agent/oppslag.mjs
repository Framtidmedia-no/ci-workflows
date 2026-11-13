// Slår opp Sentry-prosjekt-slug → repo i sentry-repoer.json (FRA-1976).
// Standard er «utenfor»: manglende rad eller agent !== true gir null, og da kjører ingen agent.
//
// CLI: node scripts/sentry-agent/oppslag.mjs <slug> [kartfil]
//      Skriver {repo, automerge, test, kilde, ci_trygg} eller null som JSON.
//      node scripts/sentry-agent/oppslag.mjs --publiser <slug> [kartfil]  →  {push, grunn}
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export function finnRepo(slug, kart) {
  if (typeof slug !== 'string' || !kart || typeof kart !== 'object') return null
  if (!Object.hasOwn(kart, slug)) return null
  const rad = kart[slug]
  if (!rad || rad.agent !== true || typeof rad.repo !== 'string' || rad.repo === '') return null
  return {
    repo: rad.repo,
    automerge: rad.automerge === true,
    test: typeof rad.test === 'string' && rad.test !== '' ? rad.test : null,
    // Overstyrer kildemappene porten tillater (standard i port.mjs).
    kilde: Array.isArray(rad.kilde) && rad.kilde.every((k) => typeof k === 'string' && k !== '') ? [...rad.kilde] : null,
    ci_trygg: rad.ci_trygg === true,
  }
}

// ci_trygg: ingen workflow i repoet som trigges av pull_request eller push på sentry/** gir hemmeligheter til jobber
// som kjører repoets kode (claude-review er unntatt, den kjører ikke repoets kode). Agentens test kjører i den CI-en,
// så uten ci_trygg kunne den lekke hemmelighetene. Da pushes ingenting, og Linear-saken får patchen i stedet.
export const CI_UTRYGG = 'Ingen PR: repoets CI eksponerer hemmeligheter for agent-brancher (ci_trygg er ikke satt i sentry-repoer.json). Patchen ligger under.'

export function skalPublisere(rad) {
  return rad?.ci_trygg === true ? { push: true, grunn: '' } : { push: false, grunn: CI_UTRYGG }
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === '--publiser') {
  const [slug, kartfil = fileURLToPath(new URL('../../sentry-repoer.json', import.meta.url))] = process.argv.slice(3)
  const kart = JSON.parse(readFileSync(kartfil, 'utf8'))
  process.stdout.write(JSON.stringify(skalPublisere(finnRepo(slug, kart))) + '\n')
} else if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [slug, kartfil = fileURLToPath(new URL('../../sentry-repoer.json', import.meta.url))] = process.argv.slice(2)
  const kart = JSON.parse(readFileSync(kartfil, 'utf8'))
  process.stdout.write(JSON.stringify(finnRepo(slug, kart)) + '\n')
}
