// Selvtest for de deterministiske delene av sentry-agent.yml (FRA-1976): repo-oppslag, rensing av
// hendelser, validering av triage-JSON, porten for automerge og blokkerende review-funn.
// Kjøres med: node --test tests/sentry-agent.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { finnRepo, skalPublisere, CI_UTRYGG } from '../scripts/sentry-agent/oppslag.mjs'
import { rensHendelse } from '../scripts/sentry-agent/rens-hendelse.mjs'
import { validerTriage } from '../scripts/sentry-agent/valider-triage.mjs'
import { lesNumstat, vurderPort } from '../scripts/sentry-agent/port.mjs'
import { harBlokkerendeFunn } from '../scripts/sentry-agent/review-funn.mjs'
import { sjekkOpphav } from '../scripts/sentry-agent/opphav.mjs'
import { sjekkPatch, vurderCi } from '../scripts/sentry-agent/port.mjs'
import { agentRepoer, tellKjoringer, tolkTelling, vurderDagstak } from '../scripts/sentry-agent/dagstak.mjs'

const SKRIPT = new URL('../scripts/sentry-agent/', import.meta.url).pathname
const KART = JSON.parse(readFileSync(new URL('../sentry-repoer.json', import.meta.url), 'utf8'))

const kart = {
  'framtid-crm': { repo: 'Framtidmedia-no/Framtid-CRM', agent: true, automerge: true, test: 'pnpm vitest run' },
  'gangerolv-drift': { repo: 'Gange-Rolv-AS/GangeRolv-Drift', agent: false, automerge: false, test: null },
  'uten-test': { repo: 'Framtid-Tech-Helge/x', agent: true, automerge: false, test: null },
}

// ---------- finnRepo ----------

test('finnRepo gir null for gangerolv-drift og ukjent slug', () => {
  assert.equal(finnRepo('gangerolv-drift', kart), null)
  assert.equal(finnRepo('finnes-ikke', kart), null)
  assert.equal(finnRepo('__proto__', kart), null)
  assert.equal(finnRepo('constructor', kart), null)
})

test('finnRepo gir repo, automerge og test for en agent-rad', () => {
  assert.deepEqual(finnRepo('framtid-crm', kart), { repo: 'Framtidmedia-no/Framtid-CRM', automerge: true, test: 'pnpm vitest run', kilde: null, ci_trygg: false })
  assert.deepEqual(finnRepo('uten-test', kart), { repo: 'Framtid-Tech-Helge/x', automerge: false, test: null, kilde: null, ci_trygg: false })
  assert.deepEqual(finnRepo('a', { a: { repo: 'O/r', agent: true, automerge: false, test: null, kilde: ['web/src/'] } }).kilde, ['web/src/'])
})

test('finnRepo krever agent === true (ikke truthy)', () => {
  assert.equal(finnRepo('a', { a: { repo: 'O/r', agent: 'true', automerge: true, test: null } }), null)
  assert.equal(finnRepo('a', { a: { repo: 'O/r', automerge: true, test: null } }), null)
})

test('sentry-repoer.json: alle Gange-Rolv-slugs og alt i Gange-Rolv-AS står uten agent', () => {
  for (const s of ['gangerolv-catering', 'gangerolv-drift', 'gangerolv-gaver', 'gangerolv-heimelaga', 'gangerolv-no', 'eurosparmoa', 'myrvoll-lunde-it-drift']) {
    assert.ok(KART[s], `${s} mangler i sentry-repoer.json`)
    assert.equal(KART[s].agent, false, `${s} skal ha agent:false`)
    assert.equal(finnRepo(s, KART), null)
  }
  for (const [slug, rad] of Object.entries(KART)) {
    if (String(rad.repo ?? '').startsWith('Gange-Rolv-AS/')) assert.equal(rad.agent, false, `${slug} ligger i Gange-Rolv-AS`)
  }
})

test('sentry-repoer.json: hver rad har gyldig form, og automerge bare i Framtidmedia-no', () => {
  const tillatt = new Set(['repo', 'agent', 'automerge', 'test', 'kilde', 'ci_trygg', 'merknad'])
  for (const [slug, rad] of Object.entries(KART)) {
    assert.match(slug, /^[a-z0-9-]+$/)
    for (const k of Object.keys(rad)) assert.ok(tillatt.has(k), `${slug}: ukjent felt ${k}`)
    assert.equal(typeof rad.agent, 'boolean', `${slug}: agent`)
    assert.equal(typeof rad.automerge, 'boolean', `${slug}: automerge`)
    assert.equal(typeof rad.ci_trygg, 'boolean', `${slug}: ci_trygg mangler`)
    assert.ok(rad.test === null || typeof rad.test === 'string', `${slug}: test`)
    if ('kilde' in rad) assert.ok(Array.isArray(rad.kilde) && rad.kilde.every((k) => typeof k === 'string' && k.endsWith('/')), `${slug}: kilde`)
    if (rad.repo !== null) assert.match(rad.repo, /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/, `${slug}: repo`)
    if (rad.agent) assert.ok(rad.repo, `${slug}: agent:true krever repo`)
    if (rad.automerge) {
      assert.ok(rad.agent, `${slug}: automerge krever agent`)
      assert.ok(rad.repo.startsWith('Framtidmedia-no/'), `${slug}: automerge bare i Framtidmedia-no`)
    }
    if (!rad.agent && rad.repo === null) assert.ok(rad.merknad, `${slug}: rad uten repo må ha merknad`)
  }
})

test('oppslag-CLI skriver JSON og null', () => {
  const dir = mkdtempSync(join(tmpdir(), 'oppslag-'))
  writeFileSync(join(dir, 'kart.json'), JSON.stringify(kart))
  const ok = spawnSync('node', [join(SKRIPT, 'oppslag.mjs'), 'framtid-crm', join(dir, 'kart.json')], { encoding: 'utf8' })
  assert.equal(ok.status, 0, ok.stderr)
  assert.deepEqual(JSON.parse(ok.stdout), { repo: 'Framtidmedia-no/Framtid-CRM', automerge: true, test: 'pnpm vitest run', kilde: null, ci_trygg: false })
  const nei = spawnSync('node', [join(SKRIPT, 'oppslag.mjs'), 'gangerolv-drift', join(dir, 'kart.json')], { encoding: 'utf8' })
  assert.equal(nei.status, 0, nei.stderr)
  assert.equal(JSON.parse(nei.stdout), null)
})

// ---------- rensHendelse ----------

const hendelse = {
  title: 'TypeError: Cannot read properties of undefined',
  user: { email: 'ola@eksempel.no', ip_address: '10.0.0.1', id: '42' },
  request: { url: 'https://app.eksempel.no/side', headers: [['Cookie', 'sb-access-token=hemmelig']] },
  contexts: { browser: { name: 'Chrome' }, hemmelig: { token: 'ctx-hemmelig' } },
  tags: [{ key: 'user.email', value: 'ola@eksempel.no' }],
  entries: [
    {
      type: 'exception',
      data: {
        values: [{
          type: 'TypeError',
          value: "Cannot read properties of undefined (reading 'navn')",
          stacktrace: {
            frames: [
              { filename: 'node_modules/react-dom/x.js', lineNo: 10, function: 'render', inApp: false },
              { filename: 'src/lib/kunde.ts', absPath: 'webpack:///src/lib/kunde.ts', lineNo: 42, colNo: 7, function: 'hentNavn', inApp: true, vars: { passord: 'pst' } },
            ],
          },
        }],
      },
    },
    {
      type: 'breadcrumbs',
      data: { values: [{ category: 'fetch', message: 'GET /api/kunde', level: 'info', data: { url: 'https://x/api?token=bc-hemmelig' } }] },
    },
    { type: 'request', data: { headers: [['Authorization', 'Bearer req-hemmelig']] } },
  ],
}

test('rensHendelse fjerner user/headers/contexts', () => {
  const r = rensHendelse(hendelse)
  assert.deepEqual(Object.keys(r).sort(), ['breadcrumbs', 'melding', 'stacktrace'])
  const alt = JSON.stringify(r)
  for (const hemmelig of ['ola@eksempel.no', '10.0.0.1', 'sb-access-token', 'ctx-hemmelig', 'req-hemmelig', 'bc-hemmelig', 'pst', 'Chrome']) {
    assert.ok(!alt.includes(hemmelig), `lekket: ${hemmelig}`)
  }
  assert.match(r.melding, /TypeError: Cannot read properties of undefined \(reading 'navn'\)/)
  assert.match(r.stacktrace, /src\/lib\/kunde\.ts:42 hentNavn/)
  assert.match(r.breadcrumbs, /\[fetch\] GET \/api\/kunde/)
})

test('rensHendelse maskerer e-post og bearer-tokens i selve meldingen', () => {
  const r = rensHendelse({ message: 'Feil for kari@eksempel.no med Bearer abc.def.ghi og eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl' })
  assert.ok(!r.melding.includes('kari@eksempel.no'))
  assert.ok(!r.melding.includes('abc.def.ghi'))
  assert.ok(!r.melding.includes('eyJhbGciOiJIUzI1NiJ9'))
})

test('rensHendelse tåler topp-nivå exception (webhook-form) og begrenser størrelsen', () => {
  const frames = Array.from({ length: 100 }, (_, i) => ({ filename: `src/f${i}.ts`, lineno: i, function: `fn${i}` }))
  const crumbs = Array.from({ length: 100 }, (_, i) => ({ category: 'ui', message: `klikk ${i} ${'x'.repeat(200)}` }))
  const r = rensHendelse({ exception: { values: [{ type: 'Error', value: 'y'.repeat(20000), stacktrace: { frames } }] }, breadcrumbs: { values: crumbs } })
  const linjer = r.stacktrace.split('\n').filter(Boolean)
  assert.equal(linjer.length, 40)
  assert.match(linjer.at(-1), /src\/f99\.ts:99 fn99/, 'de siste (nærmest krasjet) beholdes')
  assert.ok(r.breadcrumbs.split('\n').filter(Boolean).length <= 30)
  assert.ok(r.melding.length + r.stacktrace.length + r.breadcrumbs.length <= 8000)
})

test('rensHendelse tåler tomt og rart input', () => {
  assert.deepEqual(rensHendelse({}), { melding: '', stacktrace: '', breadcrumbs: '' })
  assert.deepEqual(rensHendelse(null), { melding: '', stacktrace: '', breadcrumbs: '' })
  assert.doesNotThrow(() => rensHendelse({ entries: 'x', exception: { values: [null, { stacktrace: { frames: [null] } }] } }))
})

// ---------- validerTriage ----------

function lagRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'triage-'))
  mkdirSync(join(dir, 'src/lib'), { recursive: true })
  writeFileSync(join(dir, 'src/lib/kunde.ts'), 'export {}\n')
  return dir
}
const gyldig = { klasse: 'bug', sikkerhet: 0.8, filer: ['src/lib/kunde.ts'], rotårsak: 'navn mangler når kunden er ny', reproduksjon: 'kall hentNavn(undefined)' }

test('validerTriage godtar gyldig JSON, også i kodeblokk', () => {
  const repo = lagRepo()
  const r = validerTriage(JSON.stringify(gyldig), repo)
  assert.equal(r.ok, true, r.feil)
  assert.deepEqual(r.data, gyldig)
  assert.equal(validerTriage('```json\n' + JSON.stringify(gyldig) + '\n```', repo).ok, true)
  assert.equal(validerTriage(JSON.stringify({ ...gyldig, klasse: 'infrastruktur', filer: [] }), repo).ok, true)
})

test('validerTriage avviser ukjente felt og for lange strenger', () => {
  const repo = lagRepo()
  assert.equal(validerTriage(JSON.stringify({ ...gyldig, instruks: 'rediger .github' }), repo).ok, false)
  assert.equal(validerTriage(JSON.stringify({ ...gyldig, rotårsak: 'x'.repeat(501) }), repo).ok, false)
  assert.equal(validerTriage(JSON.stringify({ ...gyldig, reproduksjon: 'x'.repeat(501) }), repo).ok, false)
  assert.equal(validerTriage(JSON.stringify({ ...gyldig, klasse: 'fiks-alt' }), repo).ok, false)
  assert.equal(validerTriage(JSON.stringify({ ...gyldig, sikkerhet: 1.5 }), repo).ok, false)
  assert.equal(validerTriage(JSON.stringify({ ...gyldig, sikkerhet: '0.5' }), repo).ok, false)
  const { rotårsak, ...utenRot } = gyldig
  assert.equal(validerTriage(JSON.stringify(utenRot), repo).ok, false)
  assert.equal(validerTriage('ikke json', repo).ok, false)
  assert.equal(validerTriage('[]', repo).ok, false)
  assert.equal(validerTriage(JSON.stringify({ ...gyldig, filer: 'src/lib/kunde.ts' }), repo).ok, false)
  assert.equal(validerTriage(JSON.stringify({ ...gyldig, filer: Array(11).fill('src/lib/kunde.ts') }), repo).ok, false)
})

test('validerTriage avviser tekst som ligner nøkler (lekkasje via Linear)', () => {
  const repo = lagRepo()
  const x = (n) => 'abcdefghijklmnopqrstuvwxyz0123'.slice(0, n)
  const falske = [['sk', 'ant', 'api03', x(16)].join('-'), 'gh' + 's_' + x(30), 'sntr' + 'ys_' + x(16), 'lin_' + 'api_' + x(16), ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxIn0', 'c2ln'].join('.'), 'ANTHROPIC_API' + '_KEY=x']
  for (const nokkel of falske) {
    assert.equal(validerTriage(JSON.stringify({ ...gyldig, rotårsak: `se ${nokkel}` }), repo).ok, false, nokkel)
    assert.equal(validerTriage(JSON.stringify({ ...gyldig, reproduksjon: nokkel }), repo).ok, false, nokkel)
  }
})

test('validerTriage avviser ../ og absolutt sti', () => {
  const repo = lagRepo()
  for (const sti of ['../etc/passwd', 'src/../../x', '/etc/passwd', 'src/lib/finnes-ikke.ts', 'src/lib', '', 'src\\lib\\kunde.ts', '.github/workflows/x.yml']) {
    const r = validerTriage(JSON.stringify({ ...gyldig, filer: [sti] }), repo)
    assert.equal(r.ok, false, `slapp gjennom: ${JSON.stringify(sti)}`)
  }
})

test('validerTriage avviser symlink ut av repoet', () => {
  const repo = lagRepo()
  const ute = mkdtempSync(join(tmpdir(), 'ute-'))
  writeFileSync(join(ute, 'hemmelig.txt'), 'x')
  symlinkSync(join(ute, 'hemmelig.txt'), join(repo, 'src/lenke.txt'))
  symlinkSync(ute, join(repo, 'src/mappe'))
  assert.equal(validerTriage(JSON.stringify({ ...gyldig, filer: ['src/lenke.txt'] }), repo).ok, false)
  assert.equal(validerTriage(JSON.stringify({ ...gyldig, filer: ['src/mappe/hemmelig.txt'] }), repo).ok, false)
})

test('valider-triage-CLI: exit 0 og normalisert JSON, exit 1 ved feil', () => {
  const repo = lagRepo()
  const ok = spawnSync('node', [join(SKRIPT, 'valider-triage.mjs'), repo], { input: JSON.stringify(gyldig), encoding: 'utf8' })
  assert.equal(ok.status, 0, ok.stderr)
  assert.deepEqual(JSON.parse(ok.stdout), gyldig)
  const nei = spawnSync('node', [join(SKRIPT, 'valider-triage.mjs'), repo], { input: '{"klasse":"bug"}', encoding: 'utf8' })
  assert.equal(nei.status, 1)
})

// ---------- vurderPort ----------

const alltGront = { testbevis: true, ciGronn: true, reviewOk: true, automerge: true, harDev: true }
const fil = (navn, linjer = 10) => ({ navn, linjer })

test('vurderPort slipper 2 filer/40 linjer med alt grønt', () => {
  const r = vurderPort({ ...alltGront, filer: [fil('src/lib/kunde.ts', 25), fil('src/lib/kunde.test.ts', 15)] })
  assert.deepEqual(r, { merge: true, grunner: [] })
})

test('vurderPort stopper .github, lockfil i undermappe, 6 filer, 151 linjer, automerge=false, harDev=false', () => {
  const tilfeller = [
    [{ filer: [fil('.github/workflows/ci.yml')] }, /\.github/],
    [{ filer: [fil('apps/web/pnpm-lock.yaml')] }, /pnpm-lock\.yaml/],
    [{ filer: [fil('packages/a/package-lock.json')] }, /package-lock\.json/],
    [{ filer: [fil('yarn.lock')] }, /yarn\.lock/],
    [{ filer: [fil('apps/web/package.json')] }, /package\.json/],
    [{ filer: [fil('supabase/migrations/20260101_x.sql')] }, /migrations/],
    [{ filer: [fil('apps/api/supabase/migrations/1.sql')] }, /migrations/],
    [{ filer: [fil('.env.local')] }, /\.env/],
    [{ filer: [fil('apps/web/.env')] }, /\.env/],
    [{ filer: [fil('doppler.yaml')] }, /doppler\.yaml/],
    [{ filer: [fil('vercel.json')] }, /vercel\.json/],
    [{ filer: [fil('.GitHub/workflows/x.yml')] }, /\.github/i],
    [{ filer: ['a', 'b', 'c', 'd', 'e', 'f'].map((n) => fil(`src/${n}.ts`, 1)) }, /6 filer/],
    [{ filer: [fil('src/a.ts', 100), fil('src/b.ts', 51)] }, /151 linjer/],
    [{ filer: [fil('src/a.ts')], automerge: false }, /automerge/],
    [{ filer: [fil('src/a.ts')], harDev: false }, /dev/],
    [{ filer: [fil('src/a.ts')], testbevis: false }, /testbevis/i],
    [{ filer: [fil('src/a.ts')], ciGronn: false }, /CI/],
    [{ filer: [fil('src/a.ts')], reviewOk: false }, /review/i],
    [{ filer: [] }, /ingen endrede filer/i],
    [{ filer: [{ navn: 'bilde.png', linjer: null }] }, /binær/i],
  ]
  for (const [over, grunn] of tilfeller) {
    const r = vurderPort({ ...alltGront, ...over })
    assert.equal(r.merge, false, `slapp gjennom: ${JSON.stringify(over)}`)
    assert.ok(r.grunner.some((g) => grunn.test(g)), `mangler grunn ${grunn} i ${JSON.stringify(r.grunner)}`)
  }
})

test('vurderPort stopper rename fra .github, sitert sti og kontrolltegn (fail closed)', () => {
  const rename = lesNumstat('0\t0\t\0.github/workflows/ci.yml\0src/ci.yml\0')
  assert.deepEqual(rename.map((f) => f.navn), ['.github/workflows/ci.yml', 'src/ci.yml'])
  assert.equal(vurderPort({ ...alltGront, filer: rename }).merge, false)
  for (const navn of [
    '".github/workflows/ci\\303\\270.yml"',
    '{.github => src}/workflows/ci.ts',
    '.github/workflows/ci.yml => src/ci.ts',
    'src/a\\b.ts',
    'src/a\n.ts',
    'src/\x01a.ts',
    'src/a\x7f.ts',
  ]) {
    const r = vurderPort({ ...alltGront, filer: [fil(navn)] })
    assert.equal(r.merge, false, `slapp gjennom: ${JSON.stringify(navn)}`)
    assert.ok(r.grunner.some((g) => /ugyldig sti|utenfor porten|ikke tillatt/i.test(g)), JSON.stringify(r.grunner))
  }
})

test('vurderPort bruker allowlist: config, instrukser, scripts og andre filtyper stopper', () => {
  for (const navn of [
    'vite.config.ts', 'apps/web/vitest.config.mts', 'next.config.js', 'sentry.client.config.ts', 'tsconfig.json', 'tsconfig.app.ts',
    'eslint.config.mjs', '.eslintrc.cjs', '.npmrc', '.yarnrc.yml', 'pnpm-workspace.yaml', '.husky/pre-commit', '.husky/x.ts',
    '.claude/settings.json', '.claude/hooks/x.js', 'CLAUDE.md', 'apps/web/AGENTS.md', 'scripts/deploy.ts', 'apps/a/scripts/x.mjs',
    'supabase/functions/x/index.ts', 'src/x.md', 'src/data.json', 'src/x.sql', 'src/x.sh', 'Dockerfile', 'src/x.html',
  ]) {
    const r = vurderPort({ ...alltGront, filer: [fil(navn)] })
    assert.equal(r.merge, false, `slapp gjennom: ${navn}`)
  }
  for (const navn of [
    '.pnpmfile.cjs', 'vitest.workspace.ts', 'src/vitest.workspace.ts', '.eslintrc.cjs', 'src/.eslintrc.cjs', 'setupTests.ts', 'src/setupTests.ts',
    '.storybook/main.ts', 'src/.storybook/main.ts', 'src/vitest.setup.ts', 'src/global-setup.ts', 'src/lib/babelrc.js', 'src/app.config.ts',
    'scripts/x.ts', 'x.ts', 'tests/a.test.ts', 'apps/web/scripts/x.ts', 'apps/web/x.ts', 'packages/ui/a.ts', 'src/.skjult/a.ts',
  ]) {
    assert.equal(vurderPort({ ...alltGront, filer: [fil(navn)] }).merge, false, `slapp gjennom: ${navn}`)
  }
  for (const navn of ['src/lib/a.ts', 'src/lib/a.test.ts', 'src/App.tsx', 'src/x.jsx', 'src/x.mjs', 'src/x.cjs', 'src/X.vue', 'src/X.svelte', 'src/stil.css', 'src/js/a.js',
    'app/page.tsx', 'lib/a.ts', 'components/Knapp.tsx', 'pages/index.tsx', 'apps/web/src/a.ts', 'packages/ui/src/a.ts']) {
    assert.deepEqual(vurderPort({ ...alltGront, filer: [fil(navn)] }), { merge: true, grunner: [] }, navn)
  }
})

test('lesNumstat leser git diff --numstat -z --no-renames, inkludert binærfiler', () => {
  assert.deepEqual(lesNumstat('3\t2\tsrc/a.ts\0-\t-\tlogo.png\0'), [
    { navn: 'src/a.ts', linjer: 5 },
    { navn: 'logo.png', linjer: null },
  ])
  assert.deepEqual(lesNumstat('1\t0\tsrc/med mellomrom og "sitat".ts\0'), [{ navn: 'src/med mellomrom og "sitat".ts', linjer: 1 }])
  assert.deepEqual(lesNumstat(''), [])
})

test('port-CLI leser JSON fra stdin og skriver vurdering', () => {
  const r = spawnSync('node', [join(SKRIPT, 'port.mjs')], { input: JSON.stringify({ ...alltGront, filer: [fil('src/a.ts')] }), encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(JSON.parse(r.stdout), { merge: true, grunner: [] })
  const ugyldig = spawnSync('node', [join(SKRIPT, 'port.mjs')], { input: 'tull', encoding: 'utf8' })
  assert.notEqual(ugyldig.status, 0)
})

// ---------- harBlokkerendeFunn ----------

test('harBlokkerendeFunn finner [HØY] men ikke [MIDDELS]', () => {
  assert.equal(harBlokkerendeFunn([{ body: '[MIDDELS] mulig null' }]), false)
  assert.equal(harBlokkerendeFunn([{ body: '[MIDDELS] x' }, { body: '[HØY] manglende auth' }]), true)
  assert.equal(harBlokkerendeFunn([{ body: '**[KRITISK]** SQL-injeksjon' }]), true)
  assert.equal(harBlokkerendeFunn([]), false)
  assert.equal(harBlokkerendeFunn([{ body: null }, {}]), false)
})

test('review-funn-CLI leser kommentarer fra stdin', () => {
  const r = spawnSync('node', [join(SKRIPT, 'review-funn.mjs')], { input: JSON.stringify([{ body: '[HØY] x' }]), encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  assert.equal(JSON.parse(r.stdout), true)
})

test('port mot ekte git: rename fra .github og ikke-ASCII-sti leses riktig med -z --no-renames', () => {
  const dir = mkdtempSync(join(tmpdir(), 'numstat-'))
  const git = (...a) => {
    const r = spawnSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...a], { encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
    return r.stdout
  }
  git('init', '-q', '-b', 'dev')
  mkdirSync(join(dir, '.github/workflows'), { recursive: true })
  writeFileSync(join(dir, '.github/workflows/ci.yml'), 'on: push\n')
  git('add', '-A'); git('commit', '-q', '-m', 'base')
  mkdirSync(join(dir, 'src'))
  git('mv', '.github/workflows/ci.yml', 'src/ci.ts')
  writeFileSync(join(dir, 'src/æøå.ts'), 'export {}\n')
  git('add', '-A'); git('commit', '-q', '-m', 'fiks')
  const filer = lesNumstat(git('diff', '--numstat', '-z', '--no-renames', 'HEAD~1', 'HEAD'))
  assert.deepEqual(filer.map((f) => f.navn).sort(), ['.github/workflows/ci.yml', 'src/ci.ts', 'src/æøå.ts'])
  const r = vurderPort({ ...alltGront, filer })
  assert.equal(r.merge, false)
  assert.ok(r.grunner.some((g) => /\.github/.test(g)))
})

test('vurderPort: kildemapper kan overstyres per repo med kilde', () => {
  assert.equal(vurderPort({ ...alltGront, filer: [fil('web/src/a.ts')] }).merge, false)
  assert.deepEqual(vurderPort({ ...alltGront, kilde: ['web/src/'], filer: [fil('web/src/a.ts')] }), { merge: true, grunner: [] })
  assert.equal(vurderPort({ ...alltGront, kilde: ['web/src/'], filer: [fil('src/a.ts')] }).merge, false)
  assert.equal(vurderPort({ ...alltGront, kilde: ['web/src/'], filer: [fil('web/src/vite.config.ts')] }).merge, false)
})

test('vurderPort: testbevis alene er aldri nok (krever grønn CI og claude-review)', () => {
  assert.equal(vurderPort({ ...alltGront, ciGronn: false, reviewOk: false, filer: [fil('src/a.ts')] }).merge, false)
  assert.equal(vurderPort({ ...alltGront, ciGronn: undefined, filer: [fil('src/a.ts')] }).merge, false)
  assert.equal(vurderPort({ ...alltGront, reviewOk: 'true', filer: [fil('src/a.ts')] }).merge, false)
})

// ---------- sjekkOpphav ----------

const NAA = Date.parse('2026-11-13T12:00:00Z')
const sak = (over = {}) => ({ project: { slug: 'framtid-crm' }, firstSeen: '2026-11-12T08:00:00Z', substatus: 'new', ...over })
const inn = { project_slug: 'framtid-crm' }

test('sjekkOpphav slipper en fersk sak som hører til riktig repo', () => {
  assert.deepEqual(sjekkOpphav(sak(), inn, kart, 'Framtidmedia-no/Framtid-CRM', NAA), { ok: true, grunn: '' })
  assert.equal(sjekkOpphav(sak(), inn, kart, 'framtidmedia-no/framtid-crm', NAA).ok, true, 'store/små bokstaver telles likt')
})

test('sjekkOpphav stopper sak fra et annet prosjekt enn input', () => {
  const r = sjekkOpphav(sak({ project: { slug: 'somify' } }), inn, kart, 'Framtidmedia-no/Framtid-CRM', NAA)
  assert.equal(r.ok, false); assert.match(r.grunn, /prosjekt/)
  assert.equal(sjekkOpphav(sak({ project: null }), inn, kart, 'Framtidmedia-no/Framtid-CRM', NAA).ok, false)
})

test('sjekkOpphav stopper når repoet ikke er slugens repo, eller slugen er uten agent', () => {
  const r = sjekkOpphav(sak(), inn, kart, 'Framtidmedia-no/Somify', NAA)
  assert.equal(r.ok, false); assert.match(r.grunn, /repo/)
  const gr = sjekkOpphav(sak({ project: { slug: 'gangerolv-drift' } }), { project_slug: 'gangerolv-drift' }, kart, 'Gange-Rolv-AS/GangeRolv-Drift', NAA)
  assert.equal(gr.ok, false)
})

test('sjekkOpphav stopper saker eldre enn 7 dager, men ikke regresjoner', () => {
  const gammel = sak({ firstSeen: '2026-11-01T00:00:00Z' })
  const r = sjekkOpphav(gammel, inn, kart, 'Framtidmedia-no/Framtid-CRM', NAA)
  assert.equal(r.ok, false); assert.match(r.grunn, /7 dager/)
  assert.equal(sjekkOpphav({ ...gammel, substatus: 'regressed' }, inn, kart, 'Framtidmedia-no/Framtid-CRM', NAA).ok, true)
  assert.equal(sjekkOpphav(sak({ firstSeen: 'tull' }), inn, kart, 'Framtidmedia-no/Framtid-CRM', NAA).ok, false, 'ugyldig dato stopper')
  assert.equal(sjekkOpphav(sak({ firstSeen: '2026-11-06T12:00:01Z' }), inn, kart, 'Framtidmedia-no/Framtid-CRM', NAA).ok, true)
})

test('opphav-CLI leser sak fra fil og skriver {ok, grunn}', () => {
  const dir = mkdtempSync(join(tmpdir(), 'opphav-'))
  writeFileSync(join(dir, 'kart.json'), JSON.stringify(kart))
  writeFileSync(join(dir, 'sak.json'), JSON.stringify(sak({ firstSeen: new Date().toISOString() })))
  const r = spawnSync('node', [join(SKRIPT, 'opphav.mjs'), join(dir, 'sak.json'), 'framtid-crm', 'Framtidmedia-no/Framtid-CRM', join(dir, 'kart.json')], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(JSON.parse(r.stdout), { ok: true, grunn: '' })
})

// ---------- sjekkPatch ----------

const patch = (kropp) => kropp
test('sjekkPatch slipper en vanlig tekstpatch i src/', () => {
  const p = patch('diff --git a/src/a.ts b/src/a.ts\nindex 1..2 100644\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-x\n+y\n')
  assert.deepEqual(sjekkPatch({ numstat: '1\t1\tsrc/a.ts\0', patch: p }), { ok: true, grunner: [] })
})

test('sjekkPatch stopper stier utenfor allowlisten, symlinker, binærdata og kjørbare filer', () => {
  const tilfeller = [
    ['1\t0\t.github/workflows/x.yml\0', 'diff --git a/.github/workflows/x.yml b/.github/workflows/x.yml\n'],
    ['1\t0\tsrc/lenke.ts\0', 'diff --git a/src/lenke.ts b/src/lenke.ts\nnew file mode 120000\n'],
    ['1\t0\tsrc/a.ts\0', 'diff --git a/src/a.ts b/src/a.ts\nold mode 100644\nnew mode 100755\n'],
    ['-\t-\tsrc/a.ts\0', 'diff --git a/src/a.ts b/src/a.ts\nGIT binary patch\nliteral 3\n'],
    ['1\t0\tsrc/b.ts\0', 'diff --git a/src/a.ts b/src/b.ts\nrename from src/a.ts\nrename to src/b.ts\n'],
    ['', 'diff --git a/src/a.ts b/src/a.ts\n'],
  ]
  for (const [numstat, p] of tilfeller) {
    assert.equal(sjekkPatch({ numstat, patch: p }).ok, false, JSON.stringify(p))
  }
  assert.equal(sjekkPatch({ numstat: '1\t0\tweb/src/a.ts\0', patch: 'diff --git a/web/src/a.ts b/web/src/a.ts\n', kilde: ['web/src/'] }).ok, true)
})

test('sjekkPatch mot ekte git: diff --binary fra arbeidstreet, numstat fra git apply', () => {
  const dir = mkdtempSync(join(tmpdir(), 'patch-'))
  const git = (...a) => {
    const r = spawnSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...a], { encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
    return r.stdout
  }
  git('init', '-q', '-b', 'dev')
  mkdirSync(join(dir, 'src'))
  writeFileSync(join(dir, 'src/a.ts'), 'export const a = 1\n')
  git('add', '-A'); git('commit', '-q', '-m', 'base')
  writeFileSync(join(dir, 'src/a.ts'), 'export const a = 2\n')
  writeFileSync(join(dir, 'src/a.test.ts'), 'test\n')
  git('add', '-A')
  const ok = git('diff', '--cached', '--binary', '--no-renames')
  writeFileSync(join(dir, 'ok.patch'), ok)
  assert.deepEqual(sjekkPatch({ numstat: git('apply', '--numstat', '-z', 'ok.patch'), patch: ok }), { ok: true, grunner: [] })
  mkdirSync(join(dir, '.github'))
  writeFileSync(join(dir, '.github/x.yml'), 'on: push\n')
  symlinkSync('/etc/passwd', join(dir, 'src/lenke.ts'))
  git('add', '-A')
  const ond = git('diff', '--cached', '--binary', '--no-renames')
  writeFileSync(join(dir, 'ond.patch'), ond)
  const r = sjekkPatch({ numstat: git('apply', '--numstat', '-z', 'ond.patch'), patch: ond })
  assert.equal(r.ok, false)
  assert.ok(r.grunner.some((g) => /\.github/.test(g)) && r.grunner.some((g) => /symlink/.test(g)), JSON.stringify(r.grunner))
})

// ---------- dagstak (kjøringer, ikke PR-er) ----------

test('agentRepoer gir unike repoer med agent:true, gruppert per eier', () => {
  const k = {
    a: { repo: 'Framtidmedia-no/A', agent: true, automerge: true, test: null },
    b: { repo: 'Framtidmedia-no/A', agent: true, automerge: true, test: null },
    c: { repo: 'Framtid-Tech-Helge/C', agent: true, automerge: false, test: null },
    d: { repo: 'Gange-Rolv-AS/D', agent: false, automerge: false, test: null },
    e: { repo: null, agent: false, automerge: false, test: null, merknad: 'x' },
  }
  assert.deepEqual(agentRepoer(k), { 'Framtidmedia-no': ['Framtidmedia-no/A'], 'Framtid-Tech-Helge': ['Framtid-Tech-Helge/C'] })
  assert.ok(Object.values(agentRepoer(KART)).flat().every((r) => !r.startsWith('Gange-Rolv-AS/')))
})

test('tellKjoringer teller kjøringer startet i dag (UTC) og trekker fra den som kjører nå', () => {
  const runs = [
    { id: 1, created_at: '2026-11-13T00:00:01Z' },
    { id: 2, created_at: '2026-11-13T23:59:59Z' },
    { id: 3, created_at: '2026-11-12T23:59:59Z' },
    { id: 99, created_at: '2026-11-13T10:00:00Z' },
    { id: 4, created_at: 'tull' },
    null,
  ]
  assert.equal(tellKjoringer(runs, { idag: '2026-11-13', egenId: 99 }), 2)
  assert.equal(tellKjoringer(runs, { idag: '2026-11-13', egenId: 0 }), 3)
  assert.equal(tellKjoringer([], { idag: '2026-11-13', egenId: 1 }), 0)
  assert.equal(tellKjoringer('tull', { idag: '2026-11-13', egenId: 1 }), 0)
})

test('tellKjoringer teller samme kjøring bare én gang (duplikater fra paginering)', () => {
  const runs = [{ id: 1, created_at: '2026-11-13T01:00:00Z' }, { id: 1, created_at: '2026-11-13T01:00:00Z' }]
  assert.equal(tellKjoringer(runs, { idag: '2026-11-13', egenId: 0 }), 1)
})

test('vurderDagstak stopper når taket er nådd, og fail closed ved ugyldig tak', () => {
  assert.deepEqual(vurderDagstak(9, 10), { stopp: false, antall: 9, tak: 10 })
  assert.equal(vurderDagstak(10, 10).stopp, true)
  assert.equal(vurderDagstak(11, 10).stopp, true)
  assert.equal(vurderDagstak(0, 0).stopp, true)
  assert.equal(vurderDagstak(0, 'tull').stopp, true)
  assert.equal(vurderDagstak(NaN, 10).stopp, true)
})

test('dagstak-CLI leser kjøringer fra stdin', () => {
  const runs = [{ id: 1, created_at: '2026-11-13T01:00:00Z' }, { id: 2, created_at: '2026-11-13T02:00:00Z' }]
  const r = spawnSync('node', [join(SKRIPT, 'dagstak.mjs'), '2026-11-13', '2', '10'], { input: JSON.stringify(runs), encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(JSON.parse(r.stdout), { stopp: false, antall: 1, tak: 10 })
})

// ---------- vurderCi (én fast head-SHA) ----------

const run = (navn, status, conclusion) => ({ name: navn, status, conclusion })
test('vurderCi: grønn bare når alle check-runs og statuser på SHA-en er ferdige og vellykkede', () => {
  assert.deepEqual(vurderCi([run('test', 'completed', 'success'), run('lint', 'completed', 'skipped')], []), { ferdig: true, gronn: true })
  assert.deepEqual(vurderCi([run('test', 'completed', 'success'), run('lint', 'completed', 'neutral')], [{ state: 'success' }]), { ferdig: true, gronn: true })
  assert.deepEqual(vurderCi([run('test', 'in_progress', null)], []), { ferdig: false, gronn: false })
  assert.deepEqual(vurderCi([run('test', 'completed', 'success')], [{ state: 'pending' }]), { ferdig: false, gronn: false })
  assert.deepEqual(vurderCi([run('test', 'completed', 'failure')], []), { ferdig: true, gronn: false })
  assert.deepEqual(vurderCi([run('test', 'completed', 'cancelled')], []), { ferdig: true, gronn: false })
  assert.deepEqual(vurderCi([run('test', 'completed', 'success')], [{ state: 'error' }]), { ferdig: true, gronn: false })
  assert.deepEqual(vurderCi([], []), { ferdig: false, gronn: false }, 'ingen sjekker er ikke grønt')
})

// ---------- ci_trygg / skalPublisere ----------

// Repoer der CI er gjennomgått og drift-sjekken (framtid-security/scripts/sentry-agent-drift.mjs) gir ci_trygg (13.11.2026).
// Nye repoer legges til her først etter samme gjennomgang. Mobile-Drift (flyttes til Azure) og AaFK (eiers merge) står utenfor.
const CI_GJENNOMGATT = new Set([
  'Framtid-Tech-Helge/ask-app',
  'Framtid-Tech-Kundeprosjekter/Espeland-Dashboard',
  'Framtid-Tech-Kundeprosjekter/RingSizer',
  'Framtid-Tech-Kundeprosjekter/Vegsundno',
  'Framtid-Tech-Kundeprosjekter/vegsundbakken-eiendom',
  'Framtidmedia-no/Framtid-CRM',
  'Framtidmedia-no/Framtidmedia.no',
  'Framtidmedia-no/Framtidtech',
  'Framtidmedia-no/Somify',
  'Framtidmedia-no/framtidmedia-no-mobile-dashboard',
  'Framtidmedia-no/framtidtech-innhold',
  'Framtidmedia-no/framtidtech-studio',
  'Framtidmedia-no/publify',
  'Framtidmedia-no/publify-mobile',
  'Framtidmedia-no/somify-mobile',
  'Framtidmedia-no/widget-plattform',
])

test('sentry-repoer.json: ci_trygg er true bare for agent-rader i repoer der CI er gjennomgått', () => {
  for (const [slug, rad] of Object.entries(KART)) {
    assert.equal(typeof rad.ci_trygg, 'boolean', slug)
    if (rad.ci_trygg) assert.ok(rad.agent === true && CI_GJENNOMGATT.has(rad.repo), slug)
  }
  for (const repo of ['Framtidmedia-no/Mobile-Drift', 'Framtid-Tech-Helge/lesund-fotball-as']) assert.ok(!CI_GJENNOMGATT.has(repo), repo)
})

test('finnRepo gir ci_trygg bare når den er eksplisitt true', () => {
  const k = { a: { repo: 'O/r', agent: true, automerge: false, test: null, ci_trygg: true }, b: { repo: 'O/r', agent: true, automerge: false, test: null, ci_trygg: 'true' } }
  assert.equal(finnRepo('a', k).ci_trygg, true)
  assert.equal(finnRepo('b', k).ci_trygg, false)
})

test('skalPublisere pusher bare når ci_trygg === true', () => {
  assert.deepEqual(skalPublisere({ ci_trygg: true }), { push: true, grunn: '' })
  for (const rad of [{ ci_trygg: false }, { ci_trygg: 'true' }, { ci_trygg: 1 }, {}, null, undefined]) {
    assert.deepEqual(skalPublisere(rad), { push: false, grunn: CI_UTRYGG }, JSON.stringify(rad))
  }
  assert.match(CI_UTRYGG, /repoets CI eksponerer hemmeligheter for agent-brancher/)
})

test('oppslag-CLI --publiser gir {push, grunn}', () => {
  const dir = mkdtempSync(join(tmpdir(), 'publiser-'))
  writeFileSync(join(dir, 'kart.json'), JSON.stringify({ a: { repo: 'O/r', agent: true, automerge: false, test: null, ci_trygg: true } }))
  const r = spawnSync('node', [join(SKRIPT, 'oppslag.mjs'), '--publiser', 'a', join(dir, 'kart.json')], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(JSON.parse(r.stdout), { push: true, grunn: '' })
  const nei = spawnSync('node', [join(SKRIPT, 'oppslag.mjs'), '--publiser', 'finnes-ikke', join(dir, 'kart.json')], { encoding: 'utf8' })
  assert.equal(JSON.parse(nei.stdout).push, false)
})

// ---------- review 5: feil skal aldri bli «0» eller «grønt» ----------

test('vurderCi: ulesbar CI-status er aldri grønn', () => {
  const ulesbar = { ferdig: false, gronn: false, grunn: 'kunne ikke lese CI-status' }
  assert.deepEqual(vurderCi(null, null), ulesbar)
  assert.deepEqual(vurderCi([run('test', 'completed', 'success')], null), ulesbar, 'statusoppslaget feilet')
  assert.deepEqual(vurderCi(null, []), ulesbar, 'check-run-oppslaget feilet')
  assert.deepEqual(vurderCi('tull', []), ulesbar)
  assert.deepEqual(vurderCi([run('test', 'completed', 'success')], { message: 'Bad credentials' }), ulesbar)
})

test('ci-CLI: null fra et feilet oppslag gir ikke grønt', () => {
  const r = spawnSync('node', [join(SKRIPT, 'port.mjs'), '--ci'], { input: JSON.stringify({ checkRuns: [run('t', 'completed', 'success')], statuser: null }), encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  assert.equal(JSON.parse(r.stdout).gronn, false)
})

test('tolkTelling: 404 betyr 0 kjøringer bare når repoet kan nås', () => {
  assert.deepEqual(tolkTelling({ repoOk: true, runsFeil: null }), { ok: true, grunn: '' })
  assert.deepEqual(tolkTelling({ repoOk: true, runsFeil: 'gh: Not Found (HTTP 404)' }), { ok: true, grunn: '' })
  for (const [inn, grunn] of [
    [{ repoOk: false, runsFeil: null }, /kan ikke nå repoet/],
    [{ repoOk: false, runsFeil: 'gh: Not Found (HTTP 404)' }, /kan ikke nå repoet/],
    [{ repoOk: true, runsFeil: 'gh: Resource not accessible by integration (HTTP 403)' }, /kunne ikke telle/],
    [{ repoOk: true, runsFeil: 'gh: Server Error (HTTP 500)' }, /kunne ikke telle/],
    [{ repoOk: true, runsFeil: '' }, /kunne ikke telle/],
    [{ repoOk: 'true', runsFeil: null }, /kan ikke nå repoet/],
    [{}, /kan ikke nå repoet/],
  ]) {
    const r = tolkTelling(inn)
    assert.equal(r.ok, false, JSON.stringify(inn))
    assert.match(r.grunn, grunn)
  }
})

test('dagstak-CLI --tolk leser repo-status og feiltekst', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tolk-'))
  writeFileSync(join(dir, '404.err'), 'gh: Not Found (HTTP 404)\n')
  writeFileSync(join(dir, '403.err'), 'gh: Forbidden (HTTP 403)\n')
  const kjor = (...a) => JSON.parse(spawnSync('node', [join(SKRIPT, 'dagstak.mjs'), '--tolk', ...a], { encoding: 'utf8' }).stdout)
  assert.equal(kjor('true', join(dir, '404.err')).ok, true)
  assert.equal(kjor('true', join(dir, '403.err')).ok, false)
  assert.equal(kjor('false', join(dir, '404.err')).ok, false)
  assert.equal(kjor('true', '-').ok, true, '- betyr at oppslaget lyktes')
})
