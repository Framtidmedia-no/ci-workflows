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

test('linearIder finner saks-ID i fix-branch, agent-branch og tittel, store bokstaver og uten duplikater', () => {
  assert.deepEqual(linearIder(['fix/FRA-123-kort-navn', 'fix: noe (FRA-123)'], TEAM), ['FRA-123'])
  assert.deepEqual(linearIder(['sentry/fra-45-framtid-crm-1a'], TEAM), ['FRA-45'])
  assert.deepEqual(linearIder(['feat/hel-7-og-gr-8'], TEAM), ['HEL-7', 'GR-8'])
})

test('linearIder ignorerer ord som ligner men ikke er et kjent team (renovate, node-20)', () => {
  assert.deepEqual(linearIder(['renovate/node-20.x', 'chore(deps): update node to v20'], TEAM), [])
  assert.deepEqual(linearIder(['xfra-12', 'fra-12x'], TEAM), [])
})

test('linearIder tåler manglende tekster og teamliste', () => {
  assert.deepEqual(linearIder([undefined, null, ''], TEAM), [])
  assert.deepEqual(linearIder(['fix/FRA-1'], []), [])
  assert.deepEqual(linearIder(['fix/FRA-1'], undefined), [])
})

test('linearIder tar maks MAKS_SAKER', () => {
  const mange = Array.from({ length: MAKS_SAKER + 5 }, (_, i) => `FRA-${i + 1}`).join(' ')
  assert.equal(linearIder([mange], TEAM).length, MAKS_SAKER)
})

// ---------- sentryIder ----------

test('sentryIder leser numerisk ID fra permalink og organisasjons-URL i riktig org', () => {
  assert.deepEqual(
    sentryIder([
      `https://${ORG}.sentry.io/issues/111/`,
      `https://${ORG}.sentry.io/issues/111/?project=4`,
      `https://de.sentry.io/organizations/${ORG}/issues/222/`,
      `https://sentry.io/organizations/${ORG}/issues/333`,
    ], ORG),
    ['111', '222', '333'],
  )
})

test('sentryIder avviser annen org, andre domener og ikke-numeriske ID-er', () => {
  assert.deepEqual(
    sentryIder([
      'https://annen-org.sentry.io/issues/1/',
      `https://${ORG}.sentry.io.ond.no/issues/2/`,
      `https://ond.no/${ORG}.sentry.io/issues/3/`,
      `https://${ORG}.sentry.io/issues/FRAMTID-CRM-1A/`,
      'https://github.com/Framtidmedia-no/Framtid-CRM/pull/4',
      null,
      42,
    ], ORG),
    [],
  )
})

test('sentryIderITekst finner Sentry-lenker i markdown-beskrivelse', () => {
  const tekst = `Feil i prod. Se [PUBLIFY-37](https://${ORG}.sentry.io/issues/777/?project=9) og <https://de.sentry.io/organizations/${ORG}/issues/888/>.\nIkke: https://annen.sentry.io/issues/999/`
  assert.deepEqual(sentryIderITekst(tekst, ORG), ['777', '888'])
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

test('CLI --linear leser tekster og team fra JSON-filer', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lukk-'))
  writeFileSync(join(dir, 'tekster.json'), JSON.stringify(['fix/FRA-9-x', 'renovate/node-20']))
  writeFileSync(join(dir, 'team.json'), JSON.stringify(TEAM))
  const r = spawnSync('node', [SKRIPT, '--linear', join(dir, 'tekster.json'), join(dir, 'team.json')], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(JSON.parse(r.stdout), ['FRA-9'])
})

test('CLI --sentry leser URL-er og org', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lukk-'))
  writeFileSync(join(dir, 'urler.json'), JSON.stringify([`https://${ORG}.sentry.io/issues/5/`, 'https://annen.sentry.io/issues/6/']))
  const r = spawnSync('node', [SKRIPT, '--sentry', join(dir, 'urler.json'), ORG], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(JSON.parse(r.stdout), ['5'])
})

test('CLI --sentry-tekst leser beskrivelser fra JSON-liste', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lukk-'))
  writeFileSync(join(dir, 'tekster.json'), JSON.stringify([`se https://${ORG}.sentry.io/issues/41/`, null, 'ingenting']))
  const r = spawnSync('node', [SKRIPT, '--sentry-tekst', join(dir, 'tekster.json'), ORG], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(JSON.parse(r.stdout), ['41'])
})

test('CLI --vurder leser sak og kart fra filer og skriver {lukk, grunn}', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lukk-'))
  writeFileSync(join(dir, 'sak.json'), JSON.stringify(sak()))
  writeFileSync(join(dir, 'kart.json'), JSON.stringify(kart))
  const r = spawnSync('node', [SKRIPT, '--vurder', join(dir, 'sak.json'), 'Framtidmedia-no/Framtid-CRM', join(dir, 'kart.json')], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(JSON.parse(r.stdout), { lukk: true, grunn: '' })
})
