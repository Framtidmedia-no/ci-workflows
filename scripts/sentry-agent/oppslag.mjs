// Slår opp Sentry-prosjekt-slug → repo i sentry-repoer.json (FRA-1976).
// Standard er «utenfor»: manglende rad eller agent !== true gir null, og da kjører ingen agent.
//
// CLI: node scripts/sentry-agent/oppslag.mjs <slug> [kartfil]
//      Skriver {repo, automerge, test} eller null som JSON.
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
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [slug, kartfil = fileURLToPath(new URL('../../sentry-repoer.json', import.meta.url))] = process.argv.slice(2)
  const kart = JSON.parse(readFileSync(kartfil, 'utf8'))
  process.stdout.write(JSON.stringify(finnRepo(slug, kart)) + '\n')
}
