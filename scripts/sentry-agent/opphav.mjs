// Sjekker at en dispatch faktisk hører til dette repoet før noe annet skjer (FRA-1976).
// n8n-webhooken har ingen signaturkontroll, så hvem som helst kan utløse en dispatch med en vilkårlig
// issue-id. Saken hentes fra Sentry med eget token, og denne funksjonen avgjør om den skal behandles.
// Ved nei: ingen Linear-sak og intet modellkall.
//
// CLI: node scripts/sentry-agent/opphav.mjs <sak.json> <project_slug> <owner/repo> [kartfil]  →  {ok, grunn}
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { finnRepo } from './oppslag.mjs'

export const MAKS_ALDER_DAGER = 7
const DAG_MS = 24 * 60 * 60 * 1000

export function sjekkOpphav(issue, inputs, kart, repo, naa = Date.now()) {
  const slug = inputs?.project_slug
  const issueSlug = issue?.project?.slug
  if (typeof slug !== 'string' || typeof issueSlug !== 'string' || issueSlug !== slug) {
    return { ok: false, grunn: `Sentry-saken hører til prosjekt «${issueSlug ?? 'ukjent'}», ikke ${slug}` }
  }
  const rad = finnRepo(slug, kart)
  if (!rad) return { ok: false, grunn: `${slug} har ingen agent i sentry-repoer.json` }
  if (typeof repo !== 'string' || rad.repo.toLowerCase() !== repo.toLowerCase()) {
    return { ok: false, grunn: `${slug} hører til repo ${rad.repo}, ikke ${repo}` }
  }
  const regresjon = issue.substatus === 'regressed'
  if (!regresjon) {
    const forst = Date.parse(issue.firstSeen)
    if (!Number.isFinite(forst)) return { ok: false, grunn: 'Sentry-saken mangler gyldig firstSeen' }
    if (naa - forst > MAKS_ALDER_DAGER * DAG_MS) {
      return { ok: false, grunn: `Sentry-saken er eldre enn ${MAKS_ALDER_DAGER} dager og ikke en regresjon` }
    }
  }
  return { ok: true, grunn: '' }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [sakfil, slug, repo, kartfil = fileURLToPath(new URL('../../sentry-repoer.json', import.meta.url))] = process.argv.slice(2)
  const issue = JSON.parse(readFileSync(sakfil, 'utf8'))
  const kart = JSON.parse(readFileSync(kartfil, 'utf8'))
  process.stdout.write(JSON.stringify(sjekkOpphav(issue, { project_slug: slug }, kart, repo)) + '\n')
}
