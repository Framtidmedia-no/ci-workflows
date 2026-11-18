#!/usr/bin/env node
// Statisk CSP-sjekk (FRA-2030, fase 1). Best effort: leser CSP-en fra tekst i next.config.*, vercel.json,
// proxy.ts/middleware.ts, index.html og CSP-/header-filer under src/, og gir ADVARSLER, aldri feil.
// Standarden den måler mot er src/csp.ts i Framtidmedia-no/framtid-security (docs/csp.md der).
//
//   node scripts/csp-sjekk.mjs <repo-rot>          # ::warning::-linjer + oppsummering, exit 0
//   node scripts/csp-sjekk.mjs <repo-rot> --json   # funnene som JSON
//
// Det er tekstanalyse, ikke kjøring: verdier fra miljøvariabler og funksjonskall kan ikke ses, og en
// konstant brukes bare hvis den er definert i samme fil (`const X = …`, to nivåer). Vakter (dev/preview)
// gjenkjennes på ord i samme linje eller fil. Falske positive og negative er mulige; derfor bare advarsler.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

export const DIREKTIVER = [
  'default-src', 'script-src-elem', 'script-src-attr', 'script-src', 'style-src-elem', 'style-src-attr', 'style-src',
  'img-src', 'font-src', 'connect-src', 'frame-src', 'child-src', 'worker-src', 'media-src', 'object-src',
  'manifest-src', 'base-uri', 'form-action', 'frame-ancestors', 'report-uri', 'report-to', 'upgrade-insecure-requests',
  'sandbox', 'require-trusted-types-for', 'trusted-types',
]

/** Verter der hvem som helst kan publisere innhold (samme liste som DELTE_VERTER i framtid-security/src/csp.ts). */
export const DELTE_VERTER = [
  'vercel.app', 'vercel.com', 'supabase.co', 'supabase.in', 'unpkg.com', 'cdn.jsdelivr.net', 'raw.githubusercontent.com',
  'github.io', 'netlify.app', 'pages.dev', 'workers.dev', 'storage.googleapis.com', 'firebasestorage.googleapis.com',
  'blob.core.windows.net', 's3.amazonaws.com',
]
/** Delte verter som også gir advarsel i connect-src (kravet i FRA-2030). */
const DELTE_I_CONNECT = ['supabase.co', 'vercel.app', 'unpkg.com']

const HOPP_OVER = new Set(['node_modules', '.git', '.next', 'dist', 'build', 'coverage', '.vercel', '.turbo', 'out'])
const FASTE_FILER = [
  'vercel.json', 'index.html', 'next.config.js', 'next.config.mjs', 'next.config.ts', 'next.config.cjs',
  'proxy.ts', 'proxy.js', 'middleware.ts', 'middleware.js', 'src/proxy.ts', 'src/proxy.js', 'src/middleware.ts',
  'src/middleware.js', 'src/lib/csp.ts', 'src/lib/csp.js',
]
const KODEFIL = /\.(m?[jt]sx?|cjs)$/
const CSP_NAVN = /csp|sikkerhetsheader|security-?headers|^headers\./i
const TESTFIL = /\.(test|spec)\.|__tests__|\/e2e\/|\/tests?\//

function gaa(rot, mappe, ut) {
  let oppforinger
  try {
    oppforinger = readdirSync(join(rot, mappe), { withFileTypes: true })
  } catch {
    return
  }
  for (const o of oppforinger) {
    const sti = mappe ? `${mappe}/${o.name}` : o.name
    if (o.isDirectory()) {
      if (!HOPP_OVER.has(o.name)) gaa(rot, sti, ut)
    } else if (KODEFIL.test(o.name) && CSP_NAVN.test(o.name) && !TESTFIL.test(`/${sti}`)) {
      ut.add(sti)
    }
  }
}

/** Kandidatfiler (relativ sti) som finnes i repoet. */
export function finnFiler(rot) {
  const ut = new Set(FASTE_FILER.filter((f) => existsSync(join(rot, f)) && statSync(join(rot, f)).isFile()))
  for (const m of ['src', 'lib', 'app']) gaa(rot, m, ut)
  return [...ut].sort()
}

/** Fjerner blokk-kommentarer og hele kommentarlinjer (ikke `//` midt i en linje, som kan være en URL). */
export function fjernKommentarer(tekst) {
  return tekst.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/^[ \t]*\/\/.*$/gm, '')
}

const DIREKTIV_RE = new RegExp(`(?<![\\w-])(${DIREKTIVER.map((d) => d.replace(/-/g, '\\-')).join('|')})(?![\\w-])`, 'g')

/** Initialisatoren til `const|let|var NAVN = …` (til slutten av uttrykket på bunnivå), eller null. */
export function definisjon(tekst, navn) {
  const m = new RegExp(`(?:const|let|var)\\s+${navn}\\b[^=\\n]*=`).exec(tekst)
  if (!m) return null
  let dybde = 0
  let i = m.index + m[0].length
  const start = i
  let streng = null
  for (; i < tekst.length; i++) {
    const c = tekst[i]
    if (streng) {
      if (c === '\\') i++
      else if (c === streng) streng = null
      continue
    }
    if (c === '"' || c === "'" || c === '`') streng = c
    else if ('([{'.includes(c)) dybde++
    else if (')]}'.includes(c)) {
      if (dybde === 0) break
      dybde--
    } else if ((c === ';' || c === '\n') && dybde === 0 && !/[=,&|?:(+[]\s*$/.test(tekst.slice(start, i))) break
  }
  return tekst.slice(start, i)
}

/** Teksten som hører til hvert direktiv: fra navnet til neste direktiv, med konstanter fra samme fil slått opp. */
export function segmenter(tekst) {
  const treff = [...tekst.matchAll(DIREKTIV_RE)]
  const ut = []
  for (let n = 0; n < treff.length; n++) {
    const slutt = Math.min(treff[n + 1]?.index ?? tekst.length, treff[n].index + 2000)
    let seg = tekst.slice(treff[n].index + treff[n][0].length, slutt)
    const sett = new Set()
    let ny = seg
    for (let nivaa = 0; nivaa < 3; nivaa++) {
      let neste = ''
      for (const [id] of ny.matchAll(/[A-Za-z_$][\w$]*/g)) {
        if (sett.has(id)) continue
        sett.add(id)
        const d = definisjon(tekst, id)
        if (d) neste += `\n${d}`
      }
      if (!neste) break
      seg += neste
      ny = neste
    }
    ut.push({ direktiv: treff[n][1], tekst: seg, linje: tekst.slice(0, treff[n].index).split('\n').length })
  }
  return ut
}

/**
 * Kilder i et segment: tokens skilt av mellomrom, anførselstegn og kodetegn. Med skjema (`https://…`) teller alle
 * verter; uten skjema bare wildcard-verter og verter reglene gjelder (delte verter, vercel.live), så kode som
 * `u.origin` ikke leses som en vert. Nøkkelord (`'unsafe-eval'`) leses fra rå tekst andre steder.
 */
export function kilder(seg) {
  const ut = new Set()
  const vertRe = /^(?:\*\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}(?::(?:\d+|\*))?(?:\/[^\s]*)?$/i
  for (const t of seg.split(/[\s,;'"`()[\]{}$]+/)) {
    if (!t) continue
    if (t === '*' || /^(https?|wss?|data|blob):$/.test(t)) ut.add(t)
    else if (/^(https?|wss?):\/\//i.test(t) && vertRe.test(t.replace(/^(https?|wss?):\/\//i, ''))) ut.add(t)
    else if (vertRe.test(t) && (t.startsWith('*.') || t.toLowerCase() === 'vercel.live' || deltVert(vert(t), DELTE_VERTER))) ut.add(t)
  }
  return [...ut]
}

export function vert(kilde) {
  return kilde.replace(/^(?:https?|wss?):\/\//, '').replace(/[:/].*$/, '').toLowerCase()
}

const deltVert = (v, liste) => {
  const ren = v.replace(/^\*\./, '')
  return liste.find((d) => ren === d || ren.endsWith(`.${d}`)) ?? null
}

const DEV_VAKT = /dev(elopment)?\b|NODE_ENV|localhost/i
const PREVIEW_VAKT = /VERCEL_ENV|['"`]preview['"`]/

/** Finner CSP-tekst i vercel.json (headers[].headers[] med key Content-Security-Policy[-Report-Only]). */
function vercelJsonCsp(tekst) {
  try {
    const json = JSON.parse(tekst)
    const ut = []
    for (const blokk of json.headers ?? []) {
      for (const h of blokk.headers ?? []) {
        if (/^content-security-policy(-report-only)?$/i.test(h.key ?? '')) ut.push(String(h.value ?? ''))
      }
    }
    return ut
  } catch {
    return null
  }
}

/** Analyserer én fil. Returnerer { harCsp, harReportUri, funn: [{ linje, melding }] }. */
export function analyserFil(sti, raa) {
  const funn = []
  const erStatisk = sti.endsWith('vercel.json') || sti.endsWith('.html')
  let tekst = sti.endsWith('.json') || sti.endsWith('.html') ? raa : fjernKommentarer(raa)
  if (sti.endsWith('vercel.json')) {
    const csp = vercelJsonCsp(raa)
    if (csp === null) return { harCsp: false, harReportUri: false, funn }
    // Hver policy som én streng, så segmenteringen ser bare CSP-en og ikke resten av fila.
    tekst = csp.map((c) => JSON.stringify(c)).join('\n')
  }
  const harCsp = /content-security-policy/i.test(tekst) || /(?<![\w-])script-src(?![\w-])/.test(tekst)
  if (!harCsp) return { harCsp: false, harReportUri: false, funn }
  const harReportUri = /(?<![\w-])report-uri(?![\w-])/.test(tekst)
  const linjer = tekst.split('\n')
  const linjeNr = (i) => tekst.slice(0, i).split('\n').length

  for (const m of tekst.matchAll(/'unsafe-eval'/g)) {
    const l = linjeNr(m.index)
    if (!erStatisk && DEV_VAKT.test(linjer[l - 1] ?? '')) continue
    funn.push({ linje: l, melding: "'unsafe-eval' uten dev-vakt" })
  }

  const preview = !erStatisk && PREVIEW_VAKT.test(tekst)
  const sett = new Set()
  const legg = (linje, melding) => {
    if (sett.has(melding)) return
    sett.add(melding)
    funn.push({ linje, melding })
  }
  const liveDirektiver = []
  let liveLinje = 0
  for (const seg of segmenter(tekst)) {
    if (!seg.direktiv.endsWith('-src')) continue
    const erScript = seg.direktiv.startsWith('script-src')
    const erConnect = seg.direktiv === 'connect-src'
    for (const k of kilder(seg.tekst)) {
      const v = vert(k)
      if (v === 'vercel.live' && !preview && !liveDirektiver.includes(seg.direktiv)) {
        liveDirektiver.push(seg.direktiv)
        liveLinje ||= seg.linje
      }
      if (erScript) {
        if (k === '*' || /^(https?|wss?|data|blob):$/.test(k)) legg(seg.linje, `${seg.direktiv}: ${k} slipper inn script fra hvor som helst`)
        else if (v.includes('*')) legg(seg.linje, `${seg.direktiv}: wildcard-vert ${k}`)
        const d = deltVert(v, DELTE_VERTER)
        if (d) legg(seg.linje, `${seg.direktiv}: ${k} er en delt vert (${d}) der hvem som helst kan publisere script`)
      }
      if (erConnect) {
        const d = deltVert(v, DELTE_I_CONNECT)
        if (d && v.includes('*')) legg(seg.linje, `connect-src: ${k} åpner for alle prosjekter på ${d}; bruk eksakt opprinnelse`)
        else if (d === 'unpkg.com') legg(seg.linje, `connect-src: ${k} er en delt vert (${d})`)
      }
    }
  }
  if (sti.endsWith('vercel.json')) {
    // Tekstens linjer er policyene, ikke fila. Pek på linjen med CSP-headeren i vercel.json.
    const l = raa.split('\n').findIndex((x) => /content-security-policy/i.test(x)) + 1
    for (const f of funn) f.linje = l || undefined
    if (liveDirektiver.length) liveLinje = l
  }
  if (liveDirektiver.length) {
    funn.push({ linje: liveLinje, melding: `vercel.live uten preview-vakt (VERCEL_ENV === 'preview') i ${liveDirektiver.join(', ')}` })
  }
  return { harCsp, harReportUri, funn }
}

/** Hele repoet. Returnerer { filer, advarsler: [{ fil?, linje?, melding }] }. */
export function sjekkRepo(rot) {
  const filer = finnFiler(rot)
  const advarsler = []
  let harCsp = false
  let harReportUri = false
  const cspFiler = []
  for (const f of filer) {
    const r = analyserFil(f, readFileSync(join(rot, f), 'utf8'))
    if (!r.harCsp) continue
    harCsp = true
    cspFiler.push(f)
    harReportUri ||= r.harReportUri
    for (const x of r.funn) advarsler.push({ fil: f, linje: x.linje, melding: x.melding })
  }
  if (!harCsp) advarsler.unshift({ melding: 'Fant ingen Content-Security-Policy (se framtid-security/docs/csp.md)' })
  else if (!harReportUri) advarsler.unshift({ fil: cspFiler[0], melding: 'CSP uten report-uri: brudd blir ikke rapportert (Sentry security-endepunkt, se framtid-security/docs/csp.md)' })
  return { filer: cspFiler, advarsler }
}

const esc = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')

function main(argv) {
  const args = argv.slice(2)
  const rot = args.find((a) => !a.startsWith('--')) ?? '.'
  const { filer, advarsler } = sjekkRepo(rot)
  if (args.includes('--json')) {
    process.stdout.write(`${JSON.stringify({ filer, advarsler }, null, 2)}\n`)
    return
  }
  for (const a of advarsler) {
    const param = [a.fil && `file=${esc(relative('.', join(rot, a.fil)) || a.fil)}`, a.linje && `line=${a.linje}`, 'title=CSP'].filter(Boolean)
    console.log(`::warning ${param.join(',')}::${esc(a.melding)}`)
  }
  console.log(`csp-sjekk: ${advarsler.length} advarsler (CSP funnet i: ${filer.join(', ') || 'ingen filer'})`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main(process.argv)
  } catch (feil) {
    // Fase 1: sjekken skal aldri gjøre en PR rød, heller ikke når den selv krasjer.
    console.log(`::warning title=CSP::csp-sjekk krasjet: ${esc(feil instanceof Error ? feil.message : feil)}`)
  }
}
