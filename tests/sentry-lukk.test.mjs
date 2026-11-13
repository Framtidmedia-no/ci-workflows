// Selvtest for scripts/sentry-agent/lukk.mjs (FRA-1976): Sentry-saken markeres løst når fiksen merges.
// Kjøres med: node --test tests/sentry-lukk.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { linearIder, sentryIder, sentryIderITekst, vurderLukk, MAKS_SAKER } from '../scripts/sentry-agent/lukk.mjs'

const SKRIPT = new URL('../scripts/sentry-agent/lukk.mjs', import.meta.url).pathname
const ORG = 'framtid-tech-as'
const TEAM = ['FRA', 'GR', 'HEL']
const kart = {
  'framtid-crm': { repo: 'Framtidmedia-no/Framtid-CRM', agent: true, automerge: true, test: null },
  'gangerolv-drift': { repo: 'Gange-Rolv-AS/GangeRolv-Drift', agent: false, automerge: false, test: null },
}
const sak = (over = {}) => ({ id: '123', status: 'unresolved', project: { slug: 'framtid-crm' }, ...over })

// ---------- linearIder ----------

test('linearIder finner saks-ID først i et branch-segment, store bokstaver og uten duplikater', () => {
  assert.deepEqual(linearIder('fix/FRA-123-kort-navn', TEAM), ['FRA-123'])
  assert.deepEqual(linearIder('sentry/fra-45-framtid-crm-1a', TEAM), ['FRA-45'])
  assert.deepEqual(linearIder('FRA-7', TEAM), ['FRA-7'])
  assert.deepEqual(linearIder('hel-7/gr-8-x', TEAM), ['HEL-7', 'GR-8'])
  assert.deepEqual(linearIder('fix/FRA-9-a/FRA-9-b', TEAM), ['FRA-9'])
})

test('linearIder ignorerer ID-er som ikke står først i segmentet, datoer og versjoner', () => {
  assert.deepEqual(linearIder('renovate/node-20.x', TEAM), [])
  assert.deepEqual(linearIder('feat/hel-7-og-gr-8', TEAM), ['HEL-7'], 'bare starten av segmentet teller')
  assert.deepEqual(linearIder('fix/gr-2026-11-13-cache', TEAM), [], 'dato ser ut som en ID')
  assert.deepEqual(linearIder('fix/cache-FRA-12', TEAM), [])
  assert.deepEqual(linearIder('xfra-12/fra-12x', TEAM), [])
})

test('linearIder tåler manglende branch og teamliste', () => {
  assert.deepEqual(linearIder(undefined, TEAM), [])
  assert.deepEqual(linearIder('', TEAM), [])
  assert.deepEqual(linearIder('fix/FRA-1', []), [])
  assert.deepEqual(linearIder('fix/FRA-1', undefined), [])
})

test('linearIder tar maks MAKS_SAKER', () => {
  const mange = Array.from({ length: MAKS_SAKER + 5 }, (_, i) => `FRA-${i + 1}`).join('/')
  assert.equal(linearIder(mange, TEAM).length, MAKS_SAKER)
})

// ---------- sentryIder ----------

test('sentryIder leser numerisk ID fra permalink og organisasjons-URL i riktig org', () => {
  assert.deepEqual(
    sentryIder([
      `https://${ORG}.sentry.io/issues/111/`,
      `https://${ORG}.sentry.io/issues/111/?project=4`,
      `https://de.sentry.io/organizations/${ORG}/issues/222/`,
      `https://sentry.io/organizations/${ORG}/issues/333`,
      `https://${ORG}.sentry.io/issues/444/events/abc123/`,
    ], ORG),
    ['111', '222', '333', '444'],
  )
})

test('sentryIder godtar kort-ID (som saker skrevet for hånd bruker), normalisert til store bokstaver', () => {
  assert.deepEqual(
    sentryIder([`https://${ORG}.sentry.io/issues/MOBILE-DRIFT-3/`, `https://${ORG}.sentry.io/issues/framtid-crm-1a`, `https://${ORG}.sentry.io/issues/MOBILE-DRIFT-3`], ORG),
    ['MOBILE-DRIFT-3', 'FRAMTID-CRM-1A'],
  )
  assert.deepEqual(sentryIder([`https://${ORG}.sentry.io/issues/-X/`, `https://${ORG}.sentry.io/issues/A_B-1/`, `https://${ORG}.sentry.io/issues/ABC/`], ORG), [])
})

test('sentryIder avviser annen org, andre domener og ikke-numeriske ID-er', () => {
  assert.deepEqual(
    sentryIder([
      'https://annen-org.sentry.io/issues/1/',
      `https://${ORG}.sentry.io.ond.no/issues/2/`,
      `https://ond.no/${ORG}.sentry.io/issues/3/`,
      'https://github.com/Framtidmedia-no/Framtid-CRM/pull/4',
      null,
      42,
    ], ORG),
    [],
  )
})

test('sentryIderITekst finner Sentry-lenker i markdown-beskrivelse, også flere saker', () => {
  const tekst = `Se [PUBLIFY-37](https://${ORG}.sentry.io/issues/777/?project=9) og <https://de.sentry.io/organizations/${ORG}/issues/888/>.\nOgså https://${ORG}.sentry.io/issues/MOBILE-DRIFT-4\nIkke: https://annen.sentry.io/issues/999/`
  assert.deepEqual(sentryIderITekst(tekst, ORG), ['777', '888', 'MOBILE-DRIFT-4'])
  assert.deepEqual(sentryIderITekst(null, ORG), [])
})

// ---------- vurderLukk ----------

test('vurderLukk lukker en uløst sak fra et prosjekt som hører til dette repoet', () => {
  assert.deepEqual(vurderLukk(sak(), 'Framtidmedia-no/Framtid-CRM', kart), { lukk: true, grunn: '' })
  assert.equal(vurderLukk(sak(), 'framtidmedia-no/framtid-crm', kart).lukk, true, 'repo sammenlignes uten store/små bokstaver')
})

test('vurderLukk rører ikke saker fra andre repoer eller prosjekter uten agent', () => {
  const r = vurderLukk(sak(), 'Framtidmedia-no/Somify', kart)
  assert.equal(r.lukk, false)
  assert.match(r.grunn, /hører til Framtidmedia-no\/Framtid-CRM/)
  assert.equal(vurderLukk(sak({ project: { slug: 'gangerolv-drift' } }), 'Gange-Rolv-AS/GangeRolv-Drift', kart).lukk, false)
  assert.equal(vurderLukk(sak({ project: undefined }), 'Framtidmedia-no/Framtid-CRM', kart).lukk, false)
})

test('vurderLukk hopper over saker som allerede er løst eller ignorert', () => {
  assert.match(vurderLukk(sak({ status: 'resolved' }), 'Framtidmedia-no/Framtid-CRM', kart).grunn, /allerede løst/)
  assert.match(vurderLukk(sak({ status: 'ignored' }), 'Framtidmedia-no/Framtid-CRM', kart).grunn, /ignored/)
  assert.equal(vurderLukk(null, 'Framtidmedia-no/Framtid-CRM', kart).lukk, false)
})

// ---------- CLI ----------

test('CLI --linear leser branch og team-fil', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lukk-'))
  writeFileSync(join(dir, 'team.json'), JSON.stringify(TEAM))
  const r = spawnSync('node', [SKRIPT, '--linear', 'fix/FRA-9-x', join(dir, 'team.json')], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(JSON.parse(r.stdout), ['FRA-9'])
})

test('CLI --linear-saker samler vedlegg og beskrivelse per Linear-sak', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lukk-'))
  writeFileSync(join(dir, 'saker.json'), JSON.stringify([
    { vedlegg: [`https://${ORG}.sentry.io/issues/41/`, 'https://github.com/x/y/pull/1'], beskrivelse: `https://${ORG}.sentry.io/issues/41/` },
    { vedlegg: [], beskrivelse: `se https://${ORG}.sentry.io/issues/42/` },
    { vedlegg: [], beskrivelse: `https://${ORG}.sentry.io/issues/43/ og https://${ORG}.sentry.io/issues/MOBILE-DRIFT-3` },
  ]))
  const r = spawnSync('node', [SKRIPT, '--linear-saker', join(dir, 'saker.json'), ORG], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(JSON.parse(r.stdout), ['41', '42', '43', 'MOBILE-DRIFT-3'])
})

test('CLI --vurder leser sak og kart fra filer og skriver {lukk, grunn}', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lukk-'))
  writeFileSync(join(dir, 'sak.json'), JSON.stringify(sak()))
  writeFileSync(join(dir, 'kart.json'), JSON.stringify(kart))
  const r = spawnSync('node', [SKRIPT, '--vurder', join(dir, 'sak.json'), 'Framtidmedia-no/Framtid-CRM', join(dir, 'kart.json')], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(JSON.parse(r.stdout), { lukk: true, grunn: '' })
})
