// Gjør en Sentry-hendelse om til det minste modellen trenger: melding, stacktrace og breadcrumbs (FRA-1976).
// Alt annet (user, request, headers, contexts, tags, vars, breadcrumb-data) kastes. Det som er igjen,
// er fortsatt UBETRODD tekst: DSN-en er offentlig, så hvem som helst kan sende inn hendelser.
//
// CLI: node scripts/sentry-agent/rens-hendelse.mjs < event.json  →  {melding, stacktrace, breadcrumbs}
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const MAKS_FRAMES = 40
const MAKS_BREADCRUMBS = 30
const MAKS_TOTALT = 8000
const MAKS_MELDING = 1500
const MAKS_STACKTRACE = 4000

const tekst = (v) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '')
const liste = (v) => (Array.isArray(v) ? v : [])
const kutt = (s, n) => (s.length <= n ? s : s.slice(0, Math.max(0, n - 1)) + '…')

// Persondata og nøkler kan stå i selve feilmeldingen. Masker de vanligste formene.
function masker(s) {
  return s
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[e-post]')
    .replace(/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g, '[jwt]')
    .replace(/\b(Bearer|Basic|token)\s+[A-Za-z0-9._~+/=-]{6,}/gi, '$1 [maskert]')
    .replace(/([?&](?:token|key|apikey|api_key|access_token|secret|password|passord)=)[^&\s"']+/gi, '$1[maskert]')
}

function oppforinger(event, type) {
  return liste(event.entries).filter((e) => e && e.type === type).map((e) => e.data ?? {})
}

function unntak(event) {
  const fraEntries = oppforinger(event, 'exception').flatMap((d) => liste(d.values))
  return [...fraEntries, ...liste(event.exception?.values)].filter((u) => u && typeof u === 'object')
}

function lagMelding(event, unntakene) {
  const linjer = unntakene.map((u) => [tekst(u.type), tekst(u.value)].filter(Boolean).join(': ')).filter(Boolean)
  if (linjer.length === 0) {
    const m = tekst(event.message) || tekst(event.logentry?.formatted) || tekst(event.logentry?.message) ||
      oppforinger(event, 'message').map((d) => tekst(d.formatted) || tekst(d.message)).find(Boolean) || tekst(event.title)
    if (m) linjer.push(m)
  }
  // Kutt før maskering: regexene skal aldri kjøre på ubegrenset ubetrodd tekst.
  return masker(kutt(linjer.join('\n'), MAKS_MELDING))
}

function lagStacktrace(unntakene) {
  const frames = unntakene.flatMap((u) => liste(u.stacktrace?.frames)).filter((f) => f && typeof f === 'object')
  return frames.slice(-MAKS_FRAMES).map((f) => {
    const fil = tekst(f.filename) || tekst(f.module) || tekst(f.absPath) || tekst(f.abs_path) || '?'
    const linje = tekst(f.lineNo) || tekst(f.lineno) || '?'
    return masker(kutt(`${fil}:${linje} ${tekst(f.function) || '?'}`, 300))
  }).join('\n')
}

function lagBreadcrumbs(event) {
  const crumbs = [
    ...oppforinger(event, 'breadcrumbs').flatMap((d) => liste(d.values)),
    ...liste(event.breadcrumbs?.values),
    ...liste(Array.isArray(event.breadcrumbs) ? event.breadcrumbs : []),
  ].filter((b) => b && typeof b === 'object')
  return crumbs.slice(-MAKS_BREADCRUMBS).map((b) => {
    const kategori = tekst(b.category) || tekst(b.type) || 'ukjent'
    return masker(kutt(`[${kategori}] ${tekst(b.message)}`.trim(), 200))
  }).join('\n')
}

export function rensHendelse(event) {
  if (!event || typeof event !== 'object') return { melding: '', stacktrace: '', breadcrumbs: '' }
  const unntakene = unntak(event)
  const melding = kutt(lagMelding(event, unntakene), MAKS_MELDING)
  const stacktrace = kutt(lagStacktrace(unntakene), MAKS_STACKTRACE)
  const breadcrumbs = kutt(lagBreadcrumbs(event), Math.max(0, MAKS_TOTALT - melding.length - stacktrace.length))
  return { melding, stacktrace, breadcrumbs }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const event = JSON.parse(readFileSync(0, 'utf8'))
  process.stdout.write(JSON.stringify(rensHendelse(event)) + '\n')
}
