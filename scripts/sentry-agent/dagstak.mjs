// Dagstak for sentry-agent (FRA-1976): teller KJØRINGER av sentry-agent.yml startet i dag (UTC) på tvers av
// alle agent-repoene, ikke PR-er. En kjøring koster et modellkall selv når den ikke ender i en PR, og en falsk
// dispatch-flom skal stoppes før modellen kalles. Sjekken går fail closed: ugyldig tak eller antall stopper.
//
// CLI: node scripts/sentry-agent/dagstak.mjs <idag YYYY-MM-DD> <egen run-id> <tak> < runs.json  →  {stopp, antall, tak}
//      node scripts/sentry-agent/dagstak.mjs --repoer [kartfil]  →  {eier: [repo, …]}
//      node scripts/sentry-agent/dagstak.mjs --tolk <repoOk> <stderr-fil|->  →  {ok, grunn}
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export function agentRepoer(kart) {
  const ut = {}
  for (const rad of Object.values(kart ?? {})) {
    if (!rad || rad.agent !== true || typeof rad.repo !== 'string' || !rad.repo.includes('/')) continue
    const eier = rad.repo.split('/')[0]
    ut[eier] ??= []
    if (!ut[eier].includes(rad.repo)) ut[eier].push(rad.repo)
  }
  return ut
}

export function tellKjoringer(runs, { idag, egenId }) {
  if (!Array.isArray(runs)) return 0
  const sett = new Set()
  for (const r of runs) {
    if (!r || typeof r !== 'object') continue
    const tid = Date.parse(r.created_at)
    if (!Number.isFinite(tid)) continue
    if (new Date(tid).toISOString().slice(0, 10) !== idag) continue
    if (String(r.id) === String(egenId)) continue
    // Kalleren kjører også ved PR-merge (sentry-lukk). De kjøringene bruker ingen agent og skal ikke spise av taket.
    if (r.event === 'pull_request' || r.event === 'pull_request_target') continue
    sett.add(String(r.id))
  }
  return sett.size
}

// Tolker oppslaget av kjøringer for ett repo. 404 betyr «ingen sentry-agent.yml ennå» (0 kjøringer) BARE når
// repoet selv kan nås med samme token. Alle andre feil stopper (fail closed).
export function tolkTelling({ repoOk, runsFeil } = {}) {
  if (repoOk !== true) return { ok: false, grunn: 'kan ikke nå repoet med app-tokenet' }
  if (runsFeil === null || runsFeil === undefined) return { ok: true, grunn: '' }
  if (typeof runsFeil === 'string' && /HTTP 404/.test(runsFeil)) return { ok: true, grunn: '' }
  return { ok: false, grunn: 'kunne ikke telle kjøringer' }
}

export function vurderDagstak(antall, tak) {
  const t = Number(tak)
  if (!Number.isInteger(t) || t <= 0 || !Number.isFinite(antall)) return { stopp: true, antall, tak: t }
  return { stopp: antall >= t, antall, tak: t }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === '--tolk') {
    // node dagstak.mjs --tolk <repoOk true|false> <stderr-fil fra runs-oppslaget, eller - når det lyktes>
    const feilfil = process.argv[4]
    const runsFeil = !feilfil || feilfil === '-' ? null : readFileSync(feilfil, 'utf8')
    process.stdout.write(JSON.stringify(tolkTelling({ repoOk: process.argv[3] === 'true', runsFeil })) + '\n')
  } else if (process.argv[2] === '--repoer') {
    const kartfil = process.argv[3] ?? fileURLToPath(new URL('../../sentry-repoer.json', import.meta.url))
    process.stdout.write(JSON.stringify(agentRepoer(JSON.parse(readFileSync(kartfil, 'utf8')))) + '\n')
  } else {
    const [idag, egenId, tak] = process.argv.slice(2)
    const runs = JSON.parse(readFileSync(0, 'utf8'))
    process.stdout.write(JSON.stringify(vurderDagstak(tellKjoringer(runs, { idag, egenId }), tak)) + '\n')
  }
}
