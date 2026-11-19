// Selvtest for scripts/sentry-agent/koble.mjs (FRA-1976): Linear-saken kobles til Sentry-saken via Sentrys
// offisielle Linear-integrasjon, slik at «Linear completed» løser Sentry-saken automatisk.
// Kjøres med: node --test tests/sentry-koble.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { kobleSentryTilLinear, erGyldigInput } from '../scripts/sentry-agent/koble.mjs'

const INST = '380e6b0d-21fe-4b9a-ab64-ff1252e7e6e6'
const LINEAR_UUID = '3262fd44-1b95-485b-97b8-0abb5093f60d'
const base = { token: 'tok', installasjon: INST, gruppeId: '162133554', linearUuid: LINEAR_UUID, linearId: 'FRA-2042' }

const svar = (status, body) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) })

/** Mock-fetch: lagrer kallene og svarer fra en kø av (matcher → svar). */
function mock(ruter) {
  const kall = []
  const f = async (url, init = {}) => {
    kall.push({ url, metode: init.method ?? 'GET', headers: init.headers, body: init.body })
    for (const [monster, lag] of ruter) if (monster(url, init)) return lag(url, init)
    throw new Error(`Uventet kall: ${init.method ?? 'GET'} ${url}`)
  }
  return { f, kall }
}
const erGet = (del) => (url, init) => (init?.method ?? 'GET') === 'GET' && url.includes(del)
const erPost = (del) => (url, init) => init?.method === 'POST' && url.includes(del)

test('erGyldigInput avviser ugyldige ID-er og tomt token', () => {
  assert.equal(erGyldigInput(base), true)
  assert.equal(erGyldigInput({ ...base, gruppeId: '12ab' }), false)
  assert.equal(erGyldigInput({ ...base, installasjon: 'ikke-uuid' }), false)
  assert.equal(erGyldigInput({ ...base, linearUuid: '../x' }), false)
  assert.equal(erGyldigInput({ ...base, linearId: 'fra2042' }), false)
  assert.equal(erGyldigInput({ ...base, token: '' }), false)
})

test('kobler når saken ikke er koblet fra før: POST external-issue-actions med link og Linear-UUID', async () => {
  const { f, kall } = mock([
    [erGet('/issues/162133554/external-issues/'), () => svar(200, [])],
    [erPost(`/sentry-app-installations/${INST}/external-issue-actions/`), () => svar(200, { id: '1', serviceType: 'linear', displayName: 'FRA#2042', webUrl: 'https://linear.app/x/issue/FRA-2042/y' })],
  ])
  const ut = await kobleSentryTilLinear({ ...base, fetch: f })
  assert.equal(ut.status, 'koblet')
  const post = kall.find((k) => k.metode === 'POST')
  assert.deepEqual(JSON.parse(post.body), { groupId: '162133554', action: 'link', uri: '/hooks/sentry/issues/link', issueId: LINEAR_UUID })
  assert.equal(post.headers.Authorization, 'Bearer tok')
  assert.match(post.url, /^https:\/\/sentry\.io\/api\/0\//)
})

test('hopper over når Sentry-saken allerede er koblet til samme Linear-sak (idempotent ved ny kjøring)', async () => {
  const { f, kall } = mock([
    [erGet('/external-issues/'), () => svar(200, [{ serviceType: 'linear', displayName: 'FRA#2042', webUrl: 'https://linear.app/framtid-tech-as/issue/FRA-2042/slug' }])],
  ])
  const ut = await kobleSentryTilLinear({ ...base, fetch: f })
  assert.equal(ut.status, 'allerede')
  assert.equal(kall.filter((k) => k.metode === 'POST').length, 0)
})

test('kobler også når saken er koblet til en ANNEN Linear-sak', async () => {
  const { f, kall } = mock([
    [erGet('/external-issues/'), () => svar(200, [{ serviceType: 'linear', displayName: 'FRA#1', webUrl: 'https://linear.app/x/issue/FRA-1/y' }])],
    [erPost('/external-issue-actions/'), () => svar(200, { id: '2' })],
  ])
  const ut = await kobleSentryTilLinear({ ...base, fetch: f })
  assert.equal(ut.status, 'koblet')
  assert.equal(kall.filter((k) => k.metode === 'POST').length, 1)
})

test('kaster ved HTTP-feil fra Sentry, uten å lekke tokenet i feilmeldingen', async () => {
  const { f } = mock([
    [erGet('/external-issues/'), () => svar(200, [])],
    [erPost('/external-issue-actions/'), () => svar(403, { detail: 'You do not have permission' })],
  ])
  await assert.rejects(
    kobleSentryTilLinear({ ...base, token: 'hemmelig-token-123', fetch: f }),
    (e) => /403/.test(e.message) && !e.message.includes('hemmelig-token-123'),
  )
})

test('kaster ved ugyldig input før noe nettverkskall', async () => {
  const { f, kall } = mock([])
  await assert.rejects(kobleSentryTilLinear({ ...base, gruppeId: '1/../2', fetch: f }), /Ugyldig input/)
  assert.equal(kall.length, 0)
})

// Linear dedupliserer på URL: et api-vedlegg (attachmentLinkURL) med Sentry-URL-en FØR link-kallet hindrer at Linear
// registrerer koblingen (ingen «sentry»-vedlegg, ingen auto-resolve). Linkingen skal derfor være eneste kobling.
import { readFileSync } from 'node:fs'
test('sentry-agent.yml lager ikke api-vedlegg med Sentry-URL-en (attachmentLinkURL)', () => {
  const yml = readFileSync(new URL('../.github/workflows/sentry-agent.yml', import.meta.url), 'utf8')
  assert.ok(!/attachmentLinkURL/.test(yml), 'attachmentLinkURL blokkerer koblingen via Sentrys Linear-integrasjon')
})

test('Linear-beskrivelsen har fortsatt Sentry-lenken (sentry-lukk leser den)', () => {
  const yml = readFileSync(new URL('../.github/workflows/sentry-agent.yml', import.meta.url), 'utf8')
  assert.match(yml, /Sentry: %s/)
})

// ---------- retry (FRA-1976): ett nytt forsøk ved 5xx/nettverksfeil, 4xx feiler høyt ----------
test('5xx på POST: ett nytt forsøk lykkes (kobler)', async () => {
  let posts = 0
  const { f, kall } = mock([
    [erGet('/external-issues/'), () => svar(200, [])],
    [erPost('/external-issue-actions/'), () => (++posts === 1 ? svar(503, { detail: 'nede' }) : svar(200, { id: '3' }))],
  ])
  const ut = await kobleSentryTilLinear({ ...base, fetch: f, ventMs: 0 })
  assert.equal(ut.status, 'koblet')
  assert.equal(kall.filter((k) => k.metode === 'POST').length, 2)
})

test('retry sjekker eksisterende kobling på nytt: 5xx der POST faktisk gikk igjennom gir «allerede», ikke dobbel kobling', async () => {
  let gets = 0
  const { f, kall } = mock([
    [erGet('/external-issues/'), () => svar(200, ++gets === 1 ? [] : [{ serviceType: 'linear', webUrl: 'https://linear.app/x/issue/FRA-2042/y' }])],
    [erPost('/external-issue-actions/'), () => svar(502, {})],
  ])
  const ut = await kobleSentryTilLinear({ ...base, fetch: f, ventMs: 0 })
  assert.equal(ut.status, 'allerede')
  assert.equal(kall.filter((k) => k.metode === 'POST').length, 1)
})

test('nettverksfeil (fetch kaster): ett nytt forsøk', async () => {
  let n = 0
  const f = async (url, init = {}) => {
    if (++n === 1) throw new TypeError('fetch failed')
    if ((init.method ?? 'GET') === 'GET') return svar(200, [])
    return svar(200, { id: '4' })
  }
  const ut = await kobleSentryTilLinear({ ...base, fetch: f, ventMs: 0 })
  assert.equal(ut.status, 'koblet')
})

test('vedvarende 5xx: feiler etter ett nytt forsøk (ikke flere)', async () => {
  const { f, kall } = mock([
    [erGet('/external-issues/'), () => svar(200, [])],
    [erPost('/external-issue-actions/'), () => svar(500, {})],
  ])
  await assert.rejects(kobleSentryTilLinear({ ...base, fetch: f, ventMs: 0 }), /500/)
  assert.equal(kall.filter((k) => k.metode === 'POST').length, 2)
})

test('4xx forsøkes ikke på nytt (403 feiler høyt med ett kall)', async () => {
  const { f, kall } = mock([
    [erGet('/external-issues/'), () => svar(200, [])],
    [erPost('/external-issue-actions/'), () => svar(403, { detail: 'nei' })],
  ])
  await assert.rejects(kobleSentryTilLinear({ ...base, fetch: f, ventMs: 0 }), /403/)
  assert.equal(kall.filter((k) => k.metode === 'POST').length, 1)
})

test('sentry-agent.yml: koble-jobben kjører også for eksisterende sak (koble_kun)', () => {
  const yml = readFileSync(new URL('../.github/workflows/sentry-agent.yml', import.meta.url), 'utf8')
  assert.match(yml, /koble_kun == 'true'/)
})
