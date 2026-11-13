// Porten for automerge til dev (FRA-1976). Deterministisk: modellen har ingen stemme her.
// Alle vilkår må holde. Ellers står PR-en åpen, og grunnene havner i Linear-saken.
//
// Stiene sjekkes mot en ALLOWLIST (kildefiler under kildemapper), i tillegg til en denylist for skjulte filer og
// mapper, config-, rc- og oppsettfiler, agent-instrukser, scripts, supabase, låsefiler og package.json. Stier med tegn git siterer eller rename-syntaks
// stoppes (fail closed), så en parser-forskjell aldri kan slippe en .github-fil gjennom.
//
// CLI: node scripts/sentry-agent/port.mjs < {filer, testbevis, ciGronn, reviewOk, automerge, harDev, kilde?}
//      → {merge, grunner}
//      node scripts/sentry-agent/port.mjs --numstat < "git diff --numstat -z --no-renames"-utdata → filer[]
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const MAKS_FILER = 5
export const MAKS_LINJER = 150

const TILLATTE_ENDELSER = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte', '.css']
// Bare filer under disse mappene kan endres. «*» er ett mappenavn. Overstyres per repo med «kilde» i sentry-repoer.json.
export const STANDARD_KILDE = ['src/', 'app/', 'lib/', 'components/', 'pages/', 'apps/*/src/', 'packages/*/src/']
const LASEFILER = new Set(['pnpm-lock.yaml', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'bun.lockb', 'bun.lock'])
const FORBUDTE_NAVN = new Set(['package.json', 'vercel.json', 'claude.md', 'agents.md', 'pnpm-workspace.yaml'])
const FORBUDTE_MAPPER = new Set(['scripts', 'supabase'])
// Navn som typisk lastes av verktøy (config, workspace, rc-filer, test-oppsett) og kan kjøre kode i CI.
const VERKTOYNAVN = [/\.config\./, /\.workspace\./, /rc\./, /\.setup\./, /^setuptests\./, /^global-setup\./, /^tsconfig/, /^eslint/, /^doppler\.ya?ml$/]
// Tegn git siterer (core.quotePath) eller som hører til rename-syntaks, samt kontrolltegn.
// eslint-disable-next-line no-control-regex
const UGYLDIG = /["\\{}\u0000-\u001f\u007f]|=>/

function underKilde(deler, kilde) {
  return kilde.some((k) => {
    const mal = k.split('/').filter(Boolean)
    if (deler.length <= mal.length) return false
    return mal.every((m, i) => m === '*' ? deler[i] !== '' : m.toLowerCase() === deler[i].toLowerCase())
  })
}

// Gir grunnen til at en sti er utenfor porten, eller null. Store/små bokstaver telles likt.
export function forbudtSti(sti, kilde = STANDARD_KILDE) {
  const s = String(sti)
  if (s === '' || UGYLDIG.test(s)) return `${JSON.stringify(s)}: ugyldig sti (sitert, rename-syntaks eller kontrolltegn)`
  const deler = s.split('/').filter(Boolean)
  const lav = deler.map((d) => d.toLowerCase())
  const navn = lav.at(-1) ?? ''
  if (lav.includes('..')) return `${s}: ugyldig sti (..)`
  // Alt som starter med punktum (.github, .husky, .claude, .storybook, .env, .npmrc, .pnpmfile.cjs, .eslintrc …).
  const punkt = deler.find((d) => d.startsWith('.'))
  if (punkt) return `${s}: ${punkt} er utenfor porten (skjult fil eller mappe)`
  for (const mappe of lav.slice(0, -1)) {
    if (FORBUDTE_MAPPER.has(mappe)) return `${s}: ${mappe}/** er utenfor porten`
  }
  if (LASEFILER.has(navn)) return `${s}: låsefil (${navn}) er utenfor porten`
  if (FORBUDTE_NAVN.has(navn)) return `${s}: ${navn} er utenfor porten`
  if (VERKTOYNAVN.some((r) => r.test(navn))) return `${s}: config-, rc- eller oppsettfil er utenfor porten`
  if (!TILLATTE_ENDELSER.some((e) => navn.endsWith(e))) return `${s}: filtypen er ikke tillatt (bare ${TILLATTE_ENDELSER.join(', ')})`
  if (!underKilde(deler, kilde)) return `${s}: ligger utenfor kildemappene (${kilde.join(', ')}), ikke tillatt`
  return null
}

// Leser `git diff --numstat -z --no-renames`: poster «lagt\tfjernet\tsti\0». Står sti tom (rename-form
// uten --no-renames), følger fra- og til-sti som egne NUL-felt; begge tas med.
export function lesNumstat(tekst) {
  const felt = String(tekst).split('\0')
  const filer = []
  for (let i = 0; i < felt.length; i++) {
    const post = felt[i]
    if (post === '') continue
    const [lagt, fjernet, ...rest] = post.split('\t')
    const binar = lagt === '-' || fjernet === '-'
    const linjer = binar ? null : Number(lagt) + Number(fjernet)
    const sti = rest.join('\t')
    if (sti === '') {
      const fra = felt[++i] ?? ''
      const til = felt[++i] ?? ''
      filer.push({ navn: fra, linjer }, { navn: til, linjer: binar ? null : 0 })
    } else {
      filer.push({ navn: sti, linjer })
    }
  }
  return filer
}

// Sjekker en patch fra fiks-jobben FØR den brukes (git apply). Patchen er laget i agentens arbeidstre og er
// ubetrodd. numstat er utdata fra `git apply --numstat -z <patch>` (samme parser som anvender den), så stiene
// som sjekkes, er stiene som skrives. I tillegg: ingen symlinker, modusendringer, binærdata eller renames.
const FORBUDT_I_PATCH = [
  [/^(new file mode|new mode|old mode|deleted file mode) 120000/m, 'symlink'],
  [/^(new file mode|new mode) 100755/m, 'kjørbar fil'],
  [/^(old mode|new mode) /m, 'modusendring'],
  [/^GIT binary patch/m, 'binærdata'],
  [/^(rename|copy) (from|to) /m, 'rename eller kopi'],
]
export function sjekkPatch({ numstat, patch, kilde }) {
  const grunner = []
  const kildemapper = Array.isArray(kilde) && kilde.length ? kilde : STANDARD_KILDE
  const filer = lesNumstat(numstat ?? '')
  if (filer.length === 0) grunner.push('Patchen endrer ingen filer')
  for (const f of filer) {
    const g = forbudtSti(f.navn, kildemapper)
    if (g) grunner.push(g)
    if (f.linjer === null) grunner.push(`${f.navn}: binærfil`)
  }
  for (const [re, hva] of FORBUDT_I_PATCH) {
    if (re.test(String(patch ?? ''))) grunner.push(`Patchen inneholder ${hva}`)
  }
  return { ok: grunner.length === 0, grunner }
}

// CI-status for ÉN fast head-SHA (check-runs og commit-statuser fra API-et). Ingen sjekker er ikke grønt.
const OK_KONKLUSJON = new Set(['success', 'skipped', 'neutral'])
export function vurderCi(checkRuns, statuser) {
  const runs = Array.isArray(checkRuns) ? checkRuns.filter(Boolean) : []
  const st = Array.isArray(statuser) ? statuser.filter(Boolean) : []
  if (runs.length + st.length === 0) return { ferdig: false, gronn: false }
  const ferdig = runs.every((r) => r.status === 'completed') && st.every((s) => s.state !== 'pending')
  if (!ferdig) return { ferdig: false, gronn: false }
  const gronn = runs.every((r) => OK_KONKLUSJON.has(r.conclusion)) && st.every((s) => s.state === 'success')
  return { ferdig: true, gronn }
}

// Testbeviset er aldri nok alene: agenten skrev testen selv. Grønn CI og vellykket claude-review uten
// blokkerende funn kreves alltid i tillegg.
export function vurderPort({ filer, testbevis, ciGronn, reviewOk, automerge, harDev, kilde }) {
  const grunner = []
  const kildemapper = Array.isArray(kilde) && kilde.length ? kilde : STANDARD_KILDE
  const liste = Array.isArray(filer) ? filer : []
  if (liste.length === 0) grunner.push('Ingen endrede filer')
  for (const f of liste) {
    const g = forbudtSti(f?.navn ?? '', kildemapper)
    if (g) grunner.push(g)
    if (f?.linjer === null || f?.linjer === undefined || !Number.isFinite(f.linjer)) grunner.push(`${f?.navn}: binærfil eller ukjent linjetall`)
  }
  const unike = new Set(liste.map((f) => f?.navn))
  if (unike.size > MAKS_FILER) grunner.push(`${unike.size} filer (maks ${MAKS_FILER})`)
  const linjer = liste.reduce((sum, f) => sum + (Number.isFinite(f?.linjer) ? f.linjer : 0), 0)
  if (linjer > MAKS_LINJER) grunner.push(`${linjer} linjer (maks ${MAKS_LINJER})`)
  if (testbevis !== true) grunner.push('Testbeviset er ikke bestått (ny test rød på base, grønn på fiks)')
  if (ciGronn !== true) grunner.push('CI er ikke grønn')
  if (reviewOk !== true) grunner.push('Claude-review mangler, feilet eller har blokkerende funn')
  if (automerge !== true) grunner.push('Repoet har ikke automerge i sentry-repoer.json')
  if (harDev !== true) grunner.push('Repoet har ingen dev-branch (aldri automerge mot main)')
  return { merge: grunner.length === 0, grunner }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const inn = readFileSync(0, 'utf8')
  if (process.argv[2] === '--ci') {
    // node port.mjs --ci < {checkRuns, statuser}
    const { checkRuns, statuser } = JSON.parse(inn)
    process.stdout.write(JSON.stringify(vurderCi(checkRuns, statuser)) + '\n')
  } else if (process.argv[2] === '--sjekk-patch') {
    // node port.mjs --sjekk-patch <patchfil> [kildeJSON] < "git apply --numstat -z <patchfil>"
    const kilde = process.argv[4] ? JSON.parse(process.argv[4]) : null
    process.stdout.write(JSON.stringify(sjekkPatch({ numstat: inn, patch: readFileSync(process.argv[3], 'utf8'), kilde })) + '\n')
  } else if (process.argv[2] === '--numstat') {
    process.stdout.write(JSON.stringify(lesNumstat(inn)) + '\n')
  } else {
    process.stdout.write(JSON.stringify(vurderPort(JSON.parse(inn))) + '\n')
  }
}
