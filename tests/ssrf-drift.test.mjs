// Selvtest for drift-sjekken: trekker ut node-skriptet fra ssrf-drift.yml og kjører det mot fiktive filer.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const yml = readFileSync(new URL('../.github/workflows/ssrf-drift.yml', import.meta.url), 'utf8')
const skript = yml.match(/node <<'NODE'\n([\s\S]*?)\n\s*NODE\n?$/)[1].split('\n').map((l) => l.replace(/^ {10}/, '')).join('\n')
const MARKOR = '// ---- framtid-security:start ----'
const L2 = '// Endringer gjøres i Framtidmedia-no/framtid-security (src/ssrf.ts) og synkes med scripts/sync.mjs.'
const L2T = '// Endringer gjøres i Framtidmedia-no/framtid-security og synkes med scripts/sync.mjs.'
const L3 = '// Drift-sjekk: Framtidmedia-no/ci-workflows/.github/workflows/ssrf-drift.yml'
const sha = (t) => createHash('sha256').update(t).digest('hex')
const BODY = 'export const x = 1\n'

const ssrfFil = (kropp = BODY) => [`// GENERERT – ikke rediger. Kilde: framtid-security@abc (variant: plain, sha256: ${sha(kropp)})`, L2, L3, MARKOR].join('\n') + '\n' + kropp
const bildeFil = (kropp = BODY) => [`// GENERERT – ikke rediger. Kilde: framtid-security@abc (hent-bilde, import: ./ssrf, sha256: ${sha(kropp)})`, L2T, L3, MARKOR].join('\n') + '\n' + kropp

function kjor({ ssrf, bilde }) {
  const dir = mkdtempSync(join(tmpdir(), 'drift-'))
  mkdirSync(join(dir, 'src'))
  writeFileSync(join(dir, 'src/ssrf.ts'), ssrf)
  if (bilde !== undefined) writeFileSync(join(dir, 'src/hent-bilde.ts'), bilde)
  writeFileSync(join(dir, 'security-guard.json'), JSON.stringify({ sha256: { plain: sha(BODY) }, tillegg: { 'hent-bilde': sha(BODY) } }))
  writeFileSync(join(dir, 'drift.js'), skript)
  const env = { ...process.env, RUNNER_TEMP: dir, GUARD_PATH: 'src/ssrf.ts', HENT_BILDE_PATH: bilde === undefined ? '' : 'src/hent-bilde.ts', ESLINT_PATH: '' }
  return spawnSync('node', ['drift.js'], { cwd: dir, env, encoding: 'utf8' })
}
const feiler = (r, mønster) => { assert.notEqual(r.status, 0, r.stdout); assert.match(r.stderr, mønster) }

test('gyldig hovedfil og tilleggsfil godtas', () => {
  const r = kjor({ ssrf: ssrfFil(), bilde: bildeFil() })
  assert.equal(r.status, 0, r.stderr)
})
for (const [navn, lag] of [['ssrf', (m) => kjor({ ssrf: m })], ['hent-bilde', (m) => kjor({ ssrf: ssrfFil(), bilde: m })]]) {
  const gyldig = navn === 'ssrf' ? ssrfFil() : bildeFil()
  const i = gyldig.indexOf(MARKOR)
  test(`${navn}: kode mellom header og markør avvises`, () => feiler(lag(`${gyldig.slice(0, i)}process.exit(0)\n${gyldig.slice(i)}`), /generert fra framtid-security/))
  test(`${navn}: ekstra linje før headeren avvises`, () => feiler(lag(`import 'evil'\n${gyldig}`), /generert fra framtid-security/))
  test(`${navn}: endret kommentarlinje avvises`, () => feiler(lag(gyldig.replace('Endringer gjøres', 'Endringer kan gjøres')), /generert fra framtid-security/))
  test(`${navn}: CRLF avvises`, () => feiler(lag(gyldig.replace(/\n/g, '\r\n')), /generert fra framtid-security/))
  test(`${navn}: tekst etter header-linje 1 avvises`, () => feiler(lag(gyldig.replace(/\)\n/, ') ; evil()\n')), /generert fra framtid-security/))
  test(`${navn}: andre markør i kroppen gir hash-avvik`, () => feiler(lag(`${gyldig}\n${MARKOR}\nevil()\n`), /redigert for hånd/))
}
