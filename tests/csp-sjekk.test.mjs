// Selvtest for csp-sjekk (FRA-2030): fiktive repoer med kjente CSP-mønstre, og CLI-en skal aldri gi exit ≠ 0.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { analyserFil, definisjon, sjekkRepo } from '../scripts/csp-sjekk.mjs'

const SKRIPT = fileURLToPath(new URL('../scripts/csp-sjekk.mjs', import.meta.url))
// Fixturene er kode i .txt-filer, så de ikke blandes med testkoden (eller skannes som kode).
const fixtur = (navn) => readFileSync(new URL(`./fixtures/csp/${navn}`, import.meta.url), 'utf8')

function repo(filer) {
  const rot = mkdtempSync(join(tmpdir(), 'csp-'))
  for (const [sti, innhold] of Object.entries(filer)) {
    mkdirSync(dirname(join(rot, sti)), { recursive: true })
    writeFileSync(join(rot, sti), innhold)
  }
  return rot
}
const meldinger = (rot) => sjekkRepo(rot).advarsler.map((a) => a.melding)

// Mønsteret fra Notar-Sol/Mobile-Drift, med rapportering og preview-vakt: skal gi 0 advarsler.
const REN_PROXY = fixtur('ren-proxy.ts.txt')

test('ren proxy med nonce, dev-vakt, preview-vakt og report-uri gir 0 advarsler', () => {
  assert.deepEqual(meldinger(repo({ 'src/proxy.ts': REN_PROXY })), [])
})

test('repo uten CSP gir én advarsel om manglende CSP', () => {
  const m = meldinger(repo({ 'src/app/page.tsx': 'export default function P() { return null }', 'vercel.json': '{"rewrites":[]}' }))
  assert.equal(m.length, 1)
  assert.match(m[0], /Fant ingen Content-Security-Policy/)
})

test('CSP uten report-uri gir advarsel', () => {
  const m = meldinger(repo({ 'src/proxy.ts': REN_PROXY.replace(/\s+"report-uri[^\n]*\n/, '\n') }))
  assert.deepEqual(m.length, 1)
  assert.match(m[0], /report-uri/)
})

test("'unsafe-eval' uten dev-vakt gir advarsel, med vakt på samme linje ikke", () => {
  const uten = analyserFil('src/lib/csp.ts', "export const csp = \"script-src 'self' 'unsafe-eval'; report-uri /r\"")
  assert.deepEqual(uten.funn.map((f) => f.melding), ["'unsafe-eval' uten dev-vakt"])
  const med = analyserFil('src/lib/csp.ts', "const s = [\"script-src 'self'\", erDev && \"'unsafe-eval'\"]; const r = 'report-uri /r'")
  assert.deepEqual(med.funn, [])
})

test('wildcard, https: og delte verter i script-src gir advarsler', () => {
  const tekst = `export const csp = "default-src 'self'; script-src 'self' https: https://*.example.no https://min.vercel.app https://unpkg.com https://abc.supabase.co https://challenges.cloudflare.com; report-uri /r"`
  const m = analyserFil('src/lib/csp.ts', tekst).funn.map((f) => f.melding)
  assert.ok(m.some((x) => /https: slipper inn/.test(x)), m.join('\n'))
  assert.ok(m.some((x) => /wildcard-vert https:\/\/\*\.example\.no/.test(x)))
  assert.ok(m.some((x) => /min\.vercel\.app er en delt vert \(vercel\.app\)/.test(x)))
  assert.ok(m.some((x) => /unpkg\.com er en delt vert/.test(x)))
  assert.ok(m.some((x) => /abc\.supabase\.co er en delt vert/.test(x)))
  assert.ok(!m.some((x) => /cloudflare/.test(x)))
})

test('konstanter fra samme fil slås opp (script-src ${scriptSrc})', () => {
  const tekst = fixtur('konstanter.ts.txt')
  const m = analyserFil('src/lib/csp.ts', tekst).funn.map((f) => f.melding)
  assert.ok(m.some((x) => /cdn\.jsdelivr\.net er en delt vert/.test(x)), m.join('\n'))
})

test('wildcard-supabase i connect-src gir advarsel, eksakt opprinnelse ikke', () => {
  const vj = (connect) => JSON.stringify({ headers: [{ source: '/(.*)', headers: [{ key: 'Content-Security-Policy', value: `default-src 'self'; script-src 'self'; connect-src 'self' ${connect}; report-uri https://o1.ingest.de.sentry.io/api/1/security/?sentry_key=a` }] }] }, null, 2)
  const med = meldinger(repo({ 'vercel.json': vj('https://*.supabase.co wss://*.supabase.co') }))
  assert.equal(med.length, 2)
  assert.match(med[0], /connect-src: https:\/\/\*\.supabase\.co åpner for alle prosjekter/)
  assert.deepEqual(meldinger(repo({ 'vercel.json': vj('https://abc.supabase.co wss://abc.supabase.co') })), [])
})

test('vercel.json: linjen peker på CSP-headeren', () => {
  const tekst = JSON.stringify({ headers: [{ source: '/(.*)', headers: [{ key: 'X-Frame-Options', value: 'DENY' }, { key: 'Content-Security-Policy', value: "script-src 'self' https://*.x.no" }] }] }, null, 2)
  const r = analyserFil('vercel.json', tekst)
  const linje = tekst.split('\n').findIndex((l) => l.includes('Content-Security-Policy')) + 1
  assert.ok(r.funn.length > 0)
  for (const f of r.funn) assert.equal(f.linje, linje)
})

test('vercel.live: statisk header og kode uten preview-vakt gir advarsel, med VERCEL_ENV ikke', () => {
  const statisk = JSON.stringify({ headers: [{ source: '/(.*)', headers: [{ key: 'Content-Security-Policy', value: "script-src 'self' https://vercel.live; report-uri /r" }] }] })
  assert.match(analyserFil('vercel.json', statisk).funn[0].melding, /vercel\.live uten preview-vakt/)
  const kodeUten = fixtur('vercel-live-uten-vakt.ts.txt')
  const funn = analyserFil('src/lib/csp.ts', kodeUten).funn
  assert.equal(funn.length, 1)
  assert.match(funn[0].melding, /vercel\.live uten preview-vakt .* i script-src, frame-src/)
  const kodeMed = fixtur('vercel-live-med-vakt.ts.txt')
  assert.deepEqual(analyserFil('src/lib/csp.ts', kodeMed).funn, [])
})

test('kode som ikke er verter (u.origin, metodekall) leses ikke som kilder', () => {
  const tekst = fixtur('ikke-verter.ts.txt')
  assert.deepEqual(analyserFil('src/lib/csp.ts', tekst).funn, [])
})

test('testfiler og node_modules hoppes over', () => {
  const rot = repo({
    'src/lib/csp.test.ts': "const x = \"script-src *; report-uri /r\"",
    'node_modules/pakke/csp.js': "const x = \"script-src *\"",
  })
  assert.deepEqual(meldinger(rot), ['Fant ingen Content-Security-Policy (se framtid-security/docs/csp.md)'])
})

test('CLI: ::warning-linjer, oppsummering og alltid exit 0', () => {
  const rot = repo({ 'vercel.json': JSON.stringify({ headers: [{ source: '/(.*)', headers: [{ key: 'Content-Security-Policy', value: "script-src 'self' 'unsafe-eval' *" }] }] }) })
  const r = spawnSync(process.execPath, [SKRIPT, rot], { encoding: 'utf8' })
  assert.equal(r.status, 0)
  assert.match(r.stdout, /^::warning file=.*vercel\.json,title=CSP::CSP uten report-uri/m)
  assert.match(r.stdout, /::warning .*'unsafe-eval' uten dev-vakt/)
  assert.match(r.stdout, /::warning .*script-src: \* slipper inn/)
  assert.match(r.stdout, /^csp-sjekk: 3 advarsler/m)
  const tom = spawnSync(process.execPath, [SKRIPT, repo({})], { encoding: 'utf8' })
  assert.equal(tom.status, 0)
  assert.match(tom.stdout, /^::warning title=CSP::Fant ingen/m)
})

test('CLI: ugyldig vercel.json krasjer ikke', () => {
  const r = spawnSync(process.execPath, [SKRIPT, repo({ 'vercel.json': '{ ikke json' })], { encoding: 'utf8' })
  assert.equal(r.status, 0)
  assert.match(r.stdout, /Fant ingen Content-Security-Policy/)
})

test('definisjon tåler $ i identifikatorer og blander ikke sammen navn med felles prefiks', () => {
  const tekst = 'const $kilder = ["https://unpkg.com"]\nconst kilderX = 1\nconst kilder = 2\n'
  assert.equal(definisjon(tekst, '$kilder').trim(), '["https://unpkg.com"]')
  assert.equal(definisjon(tekst, 'kilder').trim(), '2')
})

const vjson = (...policyer) => JSON.stringify({ headers: policyer.map((value, i) => ({ source: `/r${i}`, headers: [{ key: 'Content-Security-Policy', value }] })) })

test('wildcard i en URL-streng leses ikke som starten på en blokk-kommentar', () => {
  const tekst = 'export const csp = "script-src \'self\' https://*.example.no; connect-src https://*.supabase.co; report-uri /r" // */'
  const m = analyserFil('src/lib/csp.ts', tekst).funn.map((f) => f.melding)
  assert.ok(m.some((x) => /wildcard-vert https:\/\/\*\.example\.no/.test(x)), m.join('\n'))
  assert.ok(m.some((x) => /connect-src: https:\/\/\*\.supabase\.co/.test(x)))
  assert.equal(analyserFil('src/lib/csp.ts', tekst).harReportUri, true)
})

test('https://* (skjema + bare stjerne) i script-src gir advarsel', () => {
  const m = analyserFil('vercel.json', vjson("script-src 'self' https://*; report-uri /r")).funn.map((f) => f.melding)
  assert.ok(m.some((x) => /script-src: wildcard-vert https:\/\/\*/.test(x)), m.join('\n'))
})

test('vercel.json med CSP uten script-src regnes som CSP; uten CSP-header ikke', () => {
  assert.equal(analyserFil('vercel.json', vjson("default-src 'self'; report-uri /r")).harCsp, true)
  assert.equal(analyserFil('vercel.json', JSON.stringify({ headers: [{ source: '/', headers: [{ key: 'X-Frame-Options', value: 'DENY' }] }] })).harCsp, false)
})

test('script-src-elem og script-src-attr sjekkes som script-src', () => {
  const m = analyserFil('vercel.json', vjson("script-src 'self'; script-src-elem 'self' https://unpkg.com; script-src-attr *; report-uri /r")).funn.map((f) => f.melding)
  assert.ok(m.some((x) => /script-src-elem: https:\/\/unpkg\.com er en delt vert/.test(x)), m.join('\n'))
  assert.ok(m.some((x) => /script-src-attr: \* slipper inn/.test(x)))
})

test('vercel.json: hver policy må ha report-uri', () => {
  assert.equal(analyserFil('vercel.json', vjson("default-src 'self'; report-uri /r", "default-src 'self'")).harReportUri, false)
  assert.equal(analyserFil('vercel.json', vjson("default-src 'self'; report-uri /r", "default-src 'none'; report-uri /r")).harReportUri, true)
})

test('S3 i alle regioner, CloudFront og R2 er delte verter i script-src', () => {
  const tekst = "export const csp = \"script-src 'self' https://b.s3.eu-west-1.amazonaws.com https://d1.cloudfront.net https://pub-a.r2.dev; report-uri /r\""
  const m = analyserFil('src/lib/csp.ts', tekst).funn.map((f) => f.melding)
  assert.ok(m.some((x) => /s3\.eu-west-1\.amazonaws\.com er en delt vert \(s3\.amazonaws\.com\)/.test(x)), m.join('\n'))
  assert.ok(m.some((x) => /cloudfront\.net er en delt vert/.test(x)))
  assert.ok(m.some((x) => /r2\.dev er en delt vert/.test(x)))
})

test('S3 Express (s3express-<sone>) er en delt vert, som i framtid-security src/csp.ts', () => {
  const tekst = "export const csp = \"script-src 'self' https://b--use1-az4--x-s3.s3express-use1-az4.us-east-1.amazonaws.com; report-uri /r\""
  const m = analyserFil('src/lib/csp.ts', tekst).funn.map((f) => f.melding)
  assert.ok(m.some((x) => /er en delt vert \(s3\.amazonaws\.com\)/.test(x)), m.join('\n'))
})

test('S3 gjenkjennes eksakt: dualstack, accelerate, website, api.aws og access points (FRA-2078)', () => {
  const verter = [
    'https://s3.dualstack.eu-west-1.amazonaws.com',
    'https://b.s3-accelerate.dualstack.amazonaws.com',
    'https://b.s3-website.eu-north-1.amazonaws.com',
    'https://b.s3-website-eu-west-1.amazonaws.com',
    'https://s3.us-east-1.api.aws',
    'https://ap-1.s3-accesspoint.eu-west-1.amazonaws.com',
    'https://b.s3.cn-north-1.amazonaws.com.cn',
  ]
  for (const v of verter) {
    const m = analyserFil('src/lib/csp.ts', `export const csp = "script-src 'self' ${v}; report-uri /r"`).funn.map((f) => f.melding)
    assert.ok(m.some((x) => x.includes(`${v} er en delt vert (s3.amazonaws.com)`)), `${v}\n${m.join('\n')}`)
  }
})

test('lastbalanserer med s3-navn er elb, ikke S3; lookalikes og andre AWS-tjenester er ikke delte (FRA-2078)', () => {
  const elb = ['https://s3-website-1234567890.eu-west-1.elb.amazonaws.com', 'https://s3-nlb-0123abcd.elb.eu-west-1.amazonaws.com']
  for (const v of elb) {
    const m = analyserFil('src/lib/csp.ts', `export const csp = "script-src 'self' ${v}; report-uri /r"`).funn.map((f) => f.melding)
    assert.ok(m.some((x) => x.includes(`${v} er en delt vert (elb.amazonaws.com)`)), `${v}\n${m.join('\n')}`)
    assert.ok(!m.some((x) => /s3\.amazonaws\.com/.test(x)), m.join('\n'))
  }
  const ikke = [
    'https://s3.amazonaws.com.evil.com',
    'https://s3.amazonaws.example.com',
    'https://s3-assets.eu-west-1.es.amazonaws.com',
    'https://s3-logger.execute-api.eu-west-1.amazonaws.com',
    'https://cognito-idp.eu-west-1.amazonaws.com',
  ]
  for (const v of ikke) {
    const m = analyserFil('src/lib/csp.ts', `export const csp = "script-src 'self' ${v}; report-uri /r"`).funn.map((f) => f.melding)
    assert.ok(!m.some((x) => /delt vert/.test(x)), `${v}\n${m.join('\n')}`)
  }
})
