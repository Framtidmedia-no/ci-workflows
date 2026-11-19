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
// CLI (token og ID-er via env, aldri argumenter):
//   SENTRY_WRITE_TOKEN=… SENTRY_LINEAR_INSTALLASJON=… SENTRY_ISSUE_ID=… LINEAR_UUID=… LINEAR_ID=FRA-1 node koble.mjs
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
  const svar = await fetchFn(url, {
    method: metode,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  const tekst = await svar.text()
  if (!svar.ok) {
    // Aldri token i feilmeldingen. Sentry-svaret kuttes: det er ubetrodd tekst.
    throw new Error(`Sentry ${metode} ${new URL(url).pathname.replace(/\d{6,}/g, '#')} ga HTTP ${svar.status}: ${tekst.slice(0, 200)}`)
  }
  try { return JSON.parse(tekst) } catch { return null }
}

/** @returns {Promise<{status: 'koblet' | 'allerede', webUrl?: string}>} */
export async function kobleSentryTilLinear({ fetch: fetchFn = fetch, token, installasjon, gruppeId, linearUuid, linearId }) {
  if (!erGyldigInput({ token, installasjon, gruppeId, linearUuid, linearId })) throw new Error('Ugyldig input til kobleSentryTilLinear')

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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const e = process.env
  kobleSentryTilLinear({
    token: e.SENTRY_WRITE_TOKEN ?? '',
    installasjon: e.SENTRY_LINEAR_INSTALLASJON ?? '',
    gruppeId: e.SENTRY_ISSUE_ID ?? '',
    linearUuid: e.LINEAR_UUID ?? '',
    linearId: e.LINEAR_ID ?? '',
  }).then(
    (r) => console.log(`Sentry-sak ${e.SENTRY_ISSUE_ID} ↔ ${e.LINEAR_ID}: ${r.status}${r.webUrl ? ` (${r.webUrl})` : ''}`),
    (err) => { console.error(`::error::${err.message}`); process.exit(1) },
  )
}
