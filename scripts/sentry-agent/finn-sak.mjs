// Finner eksisterende Linear-sak for en Sentry-sak (FRA-1976), slik at en ny dispatch gjenbruker saken i stedet for å lage duplikat.
//
// Rekkefølge (billigst og mest presis først):
//  1. attachmentsForURL: Sentry-URL-en gir saken når koble-jobben har lyktes (Linear har da et sentry-vedlegg). Ett kall.
//  2. Linear-søk i beskrivelsen: agenten skriver alltid «Sentry: <url>» på egen linje, og beskrivelsen beholder lenken.
//     Dette er det som fanger tilfellet der koble feilet (HTTP-feil, manglende token) og saken derfor ikke har vedlegg.
//     Begrenset til teamet, og treffene filtreres på klientsiden til agentens egne saker (tittel «Sentry: …», markøren
//     «Sentry-agent» og lenken på egen linje), så en menneskeskrevet sak som nevner URL-en ikke gjenbrukes.
// Sentrys egne external-issues (GET /issues/{id}/external-issues/) brukes bevisst IKKE her: de finnes bare når koblingen
// lyktes, altså i nøyaktig de tilfellene der vedlegget også finnes. De gir ingenting trinn 1 ikke gir, og koster et Sentry-kall
// med eget token i triage-jobben.
// Feil (HTTP eller GraphQL) kaster alltid: «fant ingenting» ved feil ville gitt en duplikat.
//
// CLI (alt via miljøvariabler): LINEAR_API_KEY, SENTRY_URL, ISSUE_ID, TEAM_KEY
//   Skriver {sak, kilde} som JSON, eller «null» når ingen sak finnes.
import { fileURLToPath } from 'node:url'

const LINEAR = 'https://api.linear.app/graphql'
const MARKOR = 'Sentry-agent'

const Q_VEDLEGG = 'query($u:String!){attachmentsForURL(url:$u){nodes{issue{id identifier url title createdAt state{type}}}}}'
const Q_SOK = 'query($team:String!,$nal:String!){issues(first:25,orderBy:createdAt,filter:{team:{key:{eq:$team}},title:{startsWith:"Sentry: "},description:{contains:$nal}}){nodes{id identifier url title description createdAt state{type}}}}'

/**
 * Beskrivelsen har en linje «Sentry: <url med /issues/<id>/>». Linear lagrer lenken som markdown
 * («Sentry: [url](<url>)»), så linjen sjekkes for URL-en uavhengig av innpakning. Hindrer treff på 1162362319 når vi søker 162362319.
 */
export function beskrivelseHarSentryLenke(beskrivelse, gruppeId) {
  if (typeof beskrivelse !== 'string' || !/^\d{1,20}$/.test(String(gruppeId))) return false
  const url = new RegExp(`https://[^\\s<>\\[\\]()]*/issues/${gruppeId}(?:/|[\\s<>\\[\\]()]|$)`)
  return beskrivelse.split('\n').some((linje) => linje.startsWith('Sentry: ') && url.test(linje))
}

async function gql(fetchFn, nokkel, query, variables) {
  const svar = await fetchFn(LINEAR, {
    method: 'POST',
    headers: { Authorization: nokkel, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  })
  const tekst = await svar.text()
  if (!svar.ok) throw new Error(`Linear ga HTTP ${svar.status}: ${tekst.slice(0, 200)}`)
  let json
  try { json = JSON.parse(tekst) } catch { throw new Error('Linear ga ugyldig JSON') }
  if (Array.isArray(json.errors) && json.errors.length > 0) throw new Error(`Linear-feil: ${String(json.errors[0]?.message ?? '').slice(0, 200)}`)
  return json.data ?? {}
}

/** @returns {Promise<{sak: object, kilde: 'vedlegg' | 'beskrivelse'} | null>} */
export async function finnEksisterendeSak({ fetch: fetchFn = fetch, linearKey, sentryUrl, gruppeId, teamKey }) {
  if (
    typeof linearKey !== 'string' || linearKey === '' ||
    typeof sentryUrl !== 'string' || !/^https:\/\//.test(sentryUrl) ||
    typeof gruppeId !== 'string' || !/^\d{1,20}$/.test(gruppeId) ||
    typeof teamKey !== 'string' || !/^[A-Z][A-Z0-9]{0,9}$/.test(teamKey)
  ) throw new Error('Ugyldig input til finnEksisterendeSak')

  const v = await gql(fetchFn, linearKey, Q_VEDLEGG, { u: sentryUrl })
  const medVedlegg = (v.attachmentsForURL?.nodes ?? []).map((n) => n?.issue).filter(Boolean)
  if (medVedlegg.length > 0) return { sak: medVedlegg[0], kilde: 'vedlegg' }

  const s = await gql(fetchFn, linearKey, Q_SOK, { team: teamKey, nal: `/issues/${gruppeId}/` })
  const treff = (s.issues?.nodes ?? [])
    .filter((n) => n && typeof n.title === 'string' && n.title.startsWith('Sentry: ') &&
      typeof n.description === 'string' && n.description.includes(MARKOR) && beskrivelseHarSentryLenke(n.description, gruppeId))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
  if (treff.length === 0) return null
  const { description: _utelatt, ...sak } = treff[0]
  return { sak, kilde: 'beskrivelse' }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const miljo = process.env
  finnEksisterendeSak({
    linearKey: miljo.LINEAR_API_KEY ?? '',
    sentryUrl: miljo.SENTRY_URL ?? '',
    gruppeId: miljo.ISSUE_ID ?? '',
    teamKey: miljo.TEAM_KEY ?? '',
  }).then(
    (r) => process.stdout.write(JSON.stringify(r) + '\n'),
    (err) => { console.error(`::error::${err.message}`); process.exit(1) },
  )
}
