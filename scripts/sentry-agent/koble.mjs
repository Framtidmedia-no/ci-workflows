// Kobler Linear-saken agenten lager til Sentry-saken via Sentrys offisielle Linear-integrasjon (FRA-1976).
// Da vises saken under «Linked Issues» i Sentry, og når Linear-saken settes til completed løser Linear Sentry-saken.
// En vanlig Linear-lenke (attachmentLinkURL) gir IKKE dette: Linear husker bare koblinger som kommer fra integrasjonen.
//
// Mekanisme: samme kall som «Link Linear issue» i Sentry-grensesnittet. Sentry signerer og sender kallet til Linears
// /hooks/sentry/issues/link, Linear registrerer koblingen hos seg, og Sentry lagrer den som ekstern sak.
//   POST https://sentry.io/api/0/sentry-app-installations/{installasjon}/external-issue-actions/
//        {groupId, action: "link", uri: "/hooks/sentry/issues/link", issueId: <Linear-sakens UUID>}
// sentry.io er control-silo (installasjoner), de.sentry.io er regionen (Sentry-saker).
//
// Token: SENTRY_KOBLE_TOKEN er et BRUKERtoken (event:read + event:write). App-tokenet SENTRY_WRITE_TOKEN gir 403 her, fordi
// endepunktet bare godtar kall fra brukere eller fra Linear-appen selv.
// CLI (token og ID-er via env, aldri argumenter):
//   SENTRY_KOBLE_TOKEN=… SENTRY_LINEAR_INSTALLASJON=… SENTRY_ISSUE_ID=… LINEAR_UUID=… LINEAR_ID=FRA-1 node koble.mjs
import { fileURLToPath } from 'node:url'

const CONTROL = 'https://sentry.io/api/0'
const REGION = 'https://de.sentry.io/api/0'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function erGyldigInput({ token, installasjon, gruppeId, linearUuid, linearId } = {}) {
  return (
    typeof token === 'string' && token.length > 0 &&
    typeof installasjon === 'string' && UUID.test(installasjon) &&
    typeof gruppeId === 'string' && /^\d{1,20}$/.test(gruppeId) &&
    typeof linearUuid === 'string' && UUID.test(linearUuid) &&
    typeof linearId === 'string' && /^[A-Z][A-Z0-9]{0,9}-\d{1,7}$/.test(linearId)
  )
}

async function kall(fetchFn, token, metode, url, body) {
  const sti = new URL(url).pathname.replace(/\d{6,}/g, '#')
  let svar
  try {
    svar = await fetchFn(url, {
      method: metode,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
  } catch (err) {
    // Nettverksfeil kan forsøkes på nytt. Meldingen har aldri token.
    throw Object.assign(new Error(`Sentry ${metode} ${sti} feilet: ${String(err?.message ?? err).slice(0, 100)}`), { retry: true })
  }
  const tekst = await svar.text()
  if (!svar.ok) {
    // Aldri token i feilmeldingen. Sentry-svaret kuttes: det er ubetrodd tekst.
    throw Object.assign(new Error(`Sentry ${metode} ${sti} ga HTTP ${svar.status}: ${tekst.slice(0, 200)}`), { retry: svar.status >= 500 })
  }
  try { return JSON.parse(tekst) } catch { return null }
}

async function kobleEnGang({ fetchFn, token, installasjon, gruppeId, linearUuid, linearId }) {
  const eksisterende = await kall(fetchFn, token, 'GET', `${REGION}/issues/${gruppeId}/external-issues/`)
  const alt = (Array.isArray(eksisterende) ? eksisterende : []).find(
    (e) => e?.serviceType === 'linear' && typeof e.webUrl === 'string' && e.webUrl.toLowerCase().includes(`/issue/${linearId.toLowerCase()}/`),
  )
  if (alt) return { status: 'allerede', webUrl: alt.webUrl }

  const ut = await kall(fetchFn, token, 'POST', `${CONTROL}/sentry-app-installations/${installasjon}/external-issue-actions/`, {
    groupId: gruppeId,
    action: 'link',
    uri: '/hooks/sentry/issues/link',
    issueId: linearUuid,
  })
  return { status: 'koblet', webUrl: ut?.webUrl }
}

/** @returns {Promise<{status: 'koblet' | 'allerede', webUrl?: string}>} */
export async function kobleSentryTilLinear({ fetch: fetchFn = fetch, token, installasjon, gruppeId, linearUuid, linearId, ventMs = 3000 }) {
  if (!erGyldigInput({ token, installasjon, gruppeId, linearUuid, linearId })) throw new Error('Ugyldig input til kobleSentryTilLinear')
  // Ett nytt forsøk etter kort backoff ved 5xx og nettverksfeil. Hele sekvensen (sjekk + link) kjøres på nytt, så et 5xx
  // der linken faktisk gikk igjennom gir «allerede» og ikke dobbel kobling. 4xx feiler høyt med en gang.
  const inn = { fetchFn, token, installasjon, gruppeId, linearUuid, linearId }
  try {
    return await kobleEnGang(inn)
  } catch (err) {
    if (!err?.retry) throw err
    await new Promise((r) => setTimeout(r, ventMs))
    return await kobleEnGang(inn)
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const e = process.env
  kobleSentryTilLinear({
    token: e.SENTRY_KOBLE_TOKEN ?? '',
    installasjon: e.SENTRY_LINEAR_INSTALLASJON ?? '',
    gruppeId: e.SENTRY_ISSUE_ID ?? '',
    linearUuid: e.LINEAR_UUID ?? '',
    linearId: e.LINEAR_ID ?? '',
  }).then(
    (r) => console.log(`Sentry-sak ${e.SENTRY_ISSUE_ID} ↔ ${e.LINEAR_ID}: ${r.status}${r.webUrl ? ` (${r.webUrl})` : ''}`),
    (err) => { console.error(`::error::${err.message}`); process.exit(1) },
  )
}
