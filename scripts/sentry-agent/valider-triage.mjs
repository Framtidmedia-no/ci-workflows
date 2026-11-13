// Validerer triage-svaret fra modellen før noe annet får se det (FRA-1976).
// Modellen har lest ubetrodd hendelsestekst, så svaret behandles som ubetrodd: fast skjema, ingen ekstra
// felt, korte strenger og bare filer som faktisk finnes inne i repoet (ingen ../, absolutte stier eller
// symlinker ut). Jobb 2 ser bare det denne funksjonen slipper gjennom.
//
// CLI: node scripts/sentry-agent/valider-triage.mjs <repoRot> < svar  →  normalisert JSON (exit 0) eller feil (exit 1)
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const KLASSER = ['bug', 'støy', 'infrastruktur', 'uklar']
const FELT = ['klasse', 'sikkerhet', 'filer', 'rotårsak', 'reproduksjon']
const MAKS_TEKST = 500
const MAKS_FILER = 10
const MAKS_STI = 300
// Modellen kan lese miljøet (Read). Tekst som ligner nøkler stoppes, så den aldri havner i Linear.
const NOKKEL = /sk-ant-|\bgh[pousr]_[A-Za-z0-9]{16,}|\bgithub_pat_|\bsntry[su]_|\blin_api_|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}|\b[A-Z][A-Z0-9_]*(KEY|TOKEN|SECRET|PASSWORD)\s*=/
const STI = /^[A-Za-z0-9._@()[\]+-]+(\/[A-Za-z0-9._@()[\]+-]+)*$/

function trekkUtJson(tekst) {
  const s = tekst.trim()
  const blokk = s.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/)
  return blokk ? blokk[1] : s
}

function sjekkSti(sti, rot, ekteRot) {
  if (typeof sti !== 'string' || sti === '' || sti.length > MAKS_STI) return 'ugyldig sti'
  if (isAbsolute(sti) || !STI.test(sti)) return `ugyldig sti: ${sti}`
  if (sti.split('/').some((del) => del === '..' || del === '.')) return `sti med . eller ..: ${sti}`
  const full = join(rot, sti)
  let stat
  try {
    stat = lstatSync(full)
  } catch {
    return `filen finnes ikke: ${sti}`
  }
  if (stat.isSymbolicLink()) return `symlink: ${sti}`
  if (!stat.isFile()) return `ikke en fil: ${sti}`
  let ekte
  try {
    ekte = realpathSync(full)
  } catch {
    return `kan ikke løse sti: ${sti}`
  }
  const rel = relative(ekteRot, ekte)
  if (rel === '' || rel.startsWith('..' + sep) || rel === '..' || isAbsolute(rel)) return `utenfor repoet: ${sti}`
  return null
}

export function validerTriage(tekst, repoRot) {
  if (typeof tekst !== 'string') return { ok: false, feil: 'svaret er ikke tekst' }
  let data
  try {
    data = JSON.parse(trekkUtJson(tekst))
  } catch {
    return { ok: false, feil: 'svaret er ikke gyldig JSON' }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { ok: false, feil: 'svaret er ikke et JSON-objekt' }

  const ekstra = Object.keys(data).filter((k) => !FELT.includes(k))
  if (ekstra.length) return { ok: false, feil: `ukjente felt: ${ekstra.join(', ')}` }
  const mangler = FELT.filter((k) => !Object.hasOwn(data, k))
  if (mangler.length) return { ok: false, feil: `mangler felt: ${mangler.join(', ')}` }

  if (!KLASSER.includes(data.klasse)) return { ok: false, feil: 'ugyldig klasse' }
  if (typeof data.sikkerhet !== 'number' || !Number.isFinite(data.sikkerhet) || data.sikkerhet < 0 || data.sikkerhet > 1) {
    return { ok: false, feil: 'sikkerhet må være et tall mellom 0 og 1' }
  }
  for (const k of ['rotårsak', 'reproduksjon']) {
    if (typeof data[k] !== 'string') return { ok: false, feil: `${k} må være tekst` }
    if (data[k].length > MAKS_TEKST) return { ok: false, feil: `${k} er lengre enn ${MAKS_TEKST} tegn` }
    if (NOKKEL.test(data[k])) return { ok: false, feil: `${k} inneholder noe som ligner en nøkkel` }
  }
  if (!Array.isArray(data.filer)) return { ok: false, feil: 'filer må være en liste' }
  if (data.filer.length > MAKS_FILER) return { ok: false, feil: `mer enn ${MAKS_FILER} filer` }

  let ekteRot
  try {
    ekteRot = realpathSync(repoRot)
  } catch {
    return { ok: false, feil: 'repoRot finnes ikke' }
  }
  for (const sti of data.filer) {
    const feil = sjekkSti(sti, repoRot, ekteRot)
    if (feil) return { ok: false, feil }
  }

  return {
    ok: true,
    data: { klasse: data.klasse, sikkerhet: data.sikkerhet, filer: [...data.filer], rotårsak: data.rotårsak, reproduksjon: data.reproduksjon },
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const repoRot = process.argv[2] ?? process.cwd()
  const r = validerTriage(readFileSync(0, 'utf8'), repoRot)
  if (!r.ok) {
    process.stderr.write(`Ugyldig triage: ${r.feil}\n`)
    process.exit(1)
  }
  process.stdout.write(JSON.stringify(r.data) + '\n')
}
