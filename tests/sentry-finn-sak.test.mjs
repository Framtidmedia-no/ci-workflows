// Selvtest for scripts/sentry-agent/finn-sak.mjs (FRA-1976): oppslaget av eksisterende Linear-sak skal finne saken
// også når koble-jobben feilet og saken derfor mangler sentry-vedlegg. Ellers lager neste dispatch en duplikat.
// Kjøres med: node --test tests/sentry-finn-sak.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { finnEksisterendeSak, beskrivelseHarSentryLenke } from '../scripts/sentry-agent/finn-sak.mjs'

const URL_ = 'https://framtid-tech-as.sentry.io/issues/162362319/'
const base = { linearKey: 'lin_key', sentryUrl: URL_, gruppeId: '162362319', teamKey: 'FRA' }

const sak = (over = {}) => ({
  id: 'uuid-2047', identifier: 'FRA-2047', url: 'https://linear.app/x/issue/FRA-2047/y',
  title: 'Sentry: Feil (Framtidmedia-no/Framtid-CRM)', createdAt: '2026-11-19T10:00:00.000Z',
  state: { type: 'started' },
  description: `Ny Sentry-sak i Framtidmedia-no/Framtid-CRM.\n\nSentry: ${URL_}\n\nDiagnose\n\nSaken er laget av workflowen «Sentry-agent» (FRA-1976).`,
  ...over,
})

/** Mock-fetch mot Linear GraphQL: svarer på attachmentsForURL og issues-søket hver for seg. */
function linear({ vedlegg = [], sok = [], feil = null, status = 200 } = {}) {
  const kall = []
  const f = async (url, init) => {
    const body = JSON.parse(init.body)
    kall.push({ url, headers: init.headers, query: body.query, variables: body.variables })
    if (status !== 200) return { ok: false, status, text: async () => 'nede' }
    if (feil) return { ok: true, status: 200, text: async () => JSON.stringify({ errors: [{ message: feil }] }) }
    const data = body.query.includes('attachmentsForURL')
      ? { attachmentsForURL: { nodes: vedlegg.map((issue) => ({ issue })) } }
      : { issues: { nodes: sok } }
    return { ok: true, status: 200, text: async () => JSON.stringify({ data }) }
  }
  return { f, kall }
}

test('vedlegget finnes (koble lyktes): bruker attachmentsForURL og søker ikke i beskrivelser', async () => {
  const { f, kall } = linear({ vedlegg: [sak()] })
  const r = await finnEksisterendeSak({ ...base, fetch: f })
  assert.equal(r.sak.identifier, 'FRA-2047')
  assert.equal(r.kilde, 'vedlegg')
  assert.equal(kall.length, 1)
})

test('koble feilet (ingen vedlegg): finner saken likevel via Sentry-lenken i beskrivelsen, så dispatch nr. 2 gjenbruker den', async () => {
  const { f, kall } = linear({ vedlegg: [], sok: [sak()] })
  const r = await finnEksisterendeSak({ ...base, fetch: f })
  assert.equal(r.sak.identifier, 'FRA-2047')
  assert.equal(r.kilde, 'beskrivelse')
  const sok = kall[1]
  assert.equal(sok.variables.team, 'FRA')
  assert.equal(sok.variables.nal, '/issues/162362319/')
  assert.equal(sok.headers.Authorization, 'lin_key')
})

test('ingen treff noe sted: null (ny sak)', async () => {
  const { f } = linear()
  assert.equal(await finnEksisterendeSak({ ...base, fetch: f }), null)
})

test('treff som ikke er agentens sak forkastes (tittel, markør eller lenke på egen linje mangler)', async () => {
  const { f } = linear({ sok: [
    sak({ title: 'Noen andre skrev om dette' }),
    sak({ description: `Se ${URL_} i prosa. Saken er laget av workflowen «Sentry-agent»` }),
    sak({ description: `Sentry: ${URL_}\n\nmenneskeskrevet` }),
    sak({ description: `Sentry: https://x.sentry.io/issues/1162362319/\n\n«Sentry-agent»` }),
  ] })
  assert.equal(await finnEksisterendeSak({ ...base, fetch: f }), null)
})

test('flere treff: nyeste agent-sak velges', async () => {
  const { f } = linear({ sok: [sak({ identifier: 'FRA-2100', createdAt: '2026-11-19T12:00:00.000Z' }), sak()] })
  const r = await finnEksisterendeSak({ ...base, fetch: f })
  assert.equal(r.sak.identifier, 'FRA-2100')
})

test('GraphQL-feil og HTTP-feil kaster (aldri «ingen sak» ved feil, det ville gitt duplikat)', async () => {
  await assert.rejects(finnEksisterendeSak({ ...base, fetch: linear({ feil: 'rate limited' }).f }), /rate limited/)
  await assert.rejects(finnEksisterendeSak({ ...base, fetch: linear({ status: 502 }).f }), /502/)
})

test('ugyldig input kaster før nettverkskall', async () => {
  const { f, kall } = linear()
  await assert.rejects(finnEksisterendeSak({ ...base, gruppeId: '12/..', fetch: f }), /Ugyldig input/)
  await assert.rejects(finnEksisterendeSak({ ...base, teamKey: 'fra', fetch: f }), /Ugyldig input/)
  await assert.rejects(finnEksisterendeSak({ ...base, linearKey: '', fetch: f }), /Ugyldig input/)
  assert.equal(kall.length, 0)
})

test('beskrivelseHarSentryLenke krever egen linje «Sentry: <url med /issues/<id>/>»', () => {
  assert.equal(beskrivelseHarSentryLenke(sak().description, '162362319'), true)
  assert.equal(beskrivelseHarSentryLenke(`Sentry: ${URL_.slice(0, -1)}\n`, '162362319'), true)
  assert.equal(beskrivelseHarSentryLenke('Sentry: https://x.sentry.io/issues/1162362319/', '162362319'), false)
  assert.equal(beskrivelseHarSentryLenke(null, '162362319'), false)
  // Linear gjør lenken om til markdown ved lagring (sett på FRA-2047, 19.11.2026).
  const md = `Sentry: [${URL_}](<${URL_}>)\n`
  assert.equal(beskrivelseHarSentryLenke(md, '162362319'), true)
  assert.equal(beskrivelseHarSentryLenke(md, '62362319'), false)
  assert.equal(beskrivelseHarSentryLenke(`Sentry: [https://x.sentry.io/issues/1162362319/](<https://x.sentry.io/issues/1162362319/>)`, '162362319'), false)
})

// Workflowen skal bruke oppslaget og koble også når saken allerede finnes (selvreparasjon).
test('sentry-agent.yml bruker finn-sak.mjs og kobler eksisterende, ukoblede saker på nytt', () => {
  const yml = readFileSync(new URL('../.github/workflows/sentry-agent.yml', import.meta.url), 'utf8')
  assert.match(yml, /sentry-agent\/finn-sak\.mjs/)
  assert.ok(!/attachmentsForURL/.test(yml), 'oppslaget skal ligge i finn-sak.mjs, ikke inline')
  assert.match(yml, /koble_kun: \$\{\{ steps\.finn\.outputs\.koble_kun \}\}/)
  assert.match(yml, /needs\.triage\.outputs\.koble_kun == 'true'/)
  assert.ok(!/attachmentLinkURL/.test(yml))
})
