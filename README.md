# ci-workflows

Felles, gjenbrukbare GitHub Actions-workflows for Framtidmedia-no, Gange-Rolv-AS og frlund3.
Repoet er **offentlig** fordi reusable workflows må være det for å kalles på tvers av organisasjoner
(samme modell som [renovate-config](https://github.com/Framtidmedia-no/renovate-config)).

## lint-gate.yml — Lint-port

To porter, ingen per-repo-konfig å vedlikeholde:

1. **Endrede filer:** ESLint på filene PR-en rører. Feil der blokkerer merge — ny kode er alltid ren,
   og etterslepet ryddes der man jobber.
2. **Terskel mot base:** totalt antall ESLint-feil på PR-en må ikke være høyere enn på base-branchen.
   Terskelen er alltid «dagens nivå» og ratchet-er seg ned av seg selv.

Kall fra et repo (`.github/workflows/lint-port.yml`):

```yaml
name: Lint-port
on:
  pull_request:
jobs:
  lint-port:
    uses: Framtidmedia-no/ci-workflows/.github/workflows/lint-gate.yml@main
```

**Advarsler (opt-in, `maks-advarsler`):** uten input telles ikke advarsler, slik at repoer som ikke har meldt seg på
oppfører seg som før (også de som kaller `@main`). Med `maks-advarsler: '0'` blir advarsler en del av porten: Port 1 kjører
`--max-warnings 0` på endrede filer, og Port 2 ratchet-er antall advarsler på hele repoet mot base på samme måte som feil.
Et repo med gamle advarsler felles dermed ikke av dem, bare av nye. Tallet er maks advarsler i endrede filer.

```yaml
    uses: Framtidmedia-no/ci-workflows/.github/workflows/lint-gate.yml@<sha>
    with:
      maks-advarsler: '0'
```

Valgfrie `with:`-inputs: `maks-advarsler` (default tom = av), `node-version` (default 24, brukes bare uten `.nvmrc`), `pnpm-version`
(default 11, brukes bare uten `packageManager`), `eslint-args` (default `.`), `typecheck: true`
(+ `typecheck-command`) for repoer uten egen CI.

Pakkebehandler oppdages fra lockfila. Repoer uten ESLint installert får en notice og porten hopper over.
Krasjer ESLint på PR-en (ugyldig config, manglende plugin) feiler porten — det er en reell feil.

## sikkerhet.yml — hemmeligheter og avhengighetsvarsler (FRA-1753)

Basis-nivået i sikkerhetsstandarden. Tre jobber:

1. **gitleaks** (CLI, låst versjon med verifisert sjekksum, ikke `gitleaks-action` som krever lisens for org). Skanner bare
   commits i PR-området (`base..HEAD`), så gammel historikk gjør ikke nye PR-er røde. Offentlige klientnøkler
   (`NEXT_PUBLIC_*`/`VITE_*`/`EXPO_PUBLIC_*`, anon-nøkler, `sb_publishable_*`, Sentry DSN, Stripe publishable) gir ikke falsk
   positiv; `service_role`-nøkler og andre hemmeligheter stopper PR-en.
2. **audit** (`pnpm audit`/`npm audit`, high og over) som advarsel. `fail-on-audit: true` gjør den til feil.
3. **osv** (FRA-1812/GR-1732): `osv-scanner` (CLI, låst versjon med verifisert sjekksum) mot `package-lock.json`,
   `pnpm-lock.yaml` og `yarn.lock`, altså konkrete versjoner og ikke versjonsområder. I en PR (og merge queue) sammenlignes
   HEAD mot basen, og bare sårbarheter PR-en **introduserer** rapporteres som `::warning` (pakke, antall, høyeste CVSS, id-er).
   Eksisterende sårbarheter rapporteres ikke og kan aldri gjøre en urelatert PR rød. Ved `push` og andre hendelser varsles alt,
   men jobben feiler aldri. `fail-on-osv: true` gjør **nye** funn med CVSS 7.0+ (HIGH/CRITICAL) til feil; standard er av
   (varsle-modus). Funn uten CVSS-score teller som advarsel. Feilhåndtering som for gitleaks: feil sjekksum gir rødt, mens
   nedlastingsfeil og nettfeil mot osv.dev gir advarsel og hopp over. En lockfil som ikke lar seg lese (ødelagt) er ikke en nettfeil:
   med `fail-on-osv` stopper den PR-en, og funn i de andre lockfilene teller likevel. `osv` kommer i tillegg til `audit` (npm/pnpm bruker
   GitHubs advisory-database, OSV dekker flere kilder); `audit` vurderes fjernet når OSV har gått stabilt.

Feilhåndtering er bevisst asymmetrisk: funn, ugyldig konfig og krasj gir rødt; **feil sjekksum gir rødt** (aldri fail-open mot en
manipulert binær); en nedlasting som feiler pga. nett gir advarsel og hopper over, ellers kunne et nettverkshikk låse alle merger.

Repoets egen `.gitleaks.toml` er valgfri og kjedes inn for repo-spesifikke unntak. Den **må** ha `[extend] useDefault = true`,
ellers feiler jobben (ellers ville skanningen stille mistet alle standardregler).

```yaml
name: Sikkerhet
on:
  pull_request:
  push:
    branches: [main, dev]
jobs:
  sikkerhet:
    uses: Framtidmedia-no/ci-workflows/.github/workflows/sikkerhet.yml@<sha>
    permissions:
      contents: read
```

Valgfrie inputs: `runs-on` (JSON, f.eks. output fra `velg-runner.yml`), `gitleaks-config`, `fail-on-audit`, `fail-on-osv`,
`full-historikk` (standard av, FRA-1765): skanner alle brancher og tagger i stedet for PR-området og hopper over audit.
Kall den fra en egen planlagt workflow (ukentlig); funn i gammel historikk gjør ikke vanlige PR-er røde.

```yaml
name: Hemmeligheter (full historikk)
on:
  schedule: [{ cron: '17 4 * * 1' }]
  workflow_dispatch:
jobs:
  historikk:
    uses: Framtidmedia-no/ci-workflows/.github/workflows/sikkerhet.yml@<sha>
    with: { full-historikk: true }
    permissions: { contents: read }
``` Selvtest:
`bash tests/sikkerhet.test.sh` (lokalt med `GITLEAKS_BIN=...`, i CI også nedlasting og sjekksum).
Oppgradering av gitleaks: ny versjon + begge sjekksummer i `env:`, kjør selvtesten.
Oppgradering av osv-scanner: ny `OSV_VERSION` + begge sjekksummer fra `osv-scanner_SHA256SUMS` i releasen, kjør selvtesten (lokalt med `OSV_BIN=...`).
`full-historikk` hopper over både `audit` og `osv`.

## supabase-test.yml — pgTAP og skjema-lint (FRA-1754)

Kundedata-nivået i sikkerhetsstandarden, som påkrevd PR-sjekk i repoer med Supabase og brukerdata. To jobber:

1. **drift:** de synkede universelle testene (`supabase/tests/database/0N-*.test.sql`) er like kanonisk kilde
   ([framtid-security](https://github.com/Framtidmedia-no/framtid-security), `sql/tests`) via `sql-guard.json`
   (sha256 per test, bumpes sammen med testene). Feiler hvis en test mangler, er håndredigert eller utdatert.
2. **pgtap:** `supabase start`, `supabase db lint --local --fail-on error` og `supabase test db`. Migrasjonene kjøres fra
   scratch, så jobben fanger også migrasjoner som ikke lar seg kjøre.

Security Advisor er bevisst ikke en PR-gate (den krever prosjektet i skyen); den kjøres ved utrulling og ukentlig.

```yaml
name: Supabase-test
on:
  pull_request:
jobs:
  supabase-test:
    uses: Framtidmedia-no/ci-workflows/.github/workflows/supabase-test.yml@<sha>
    permissions:
      contents: read
```

Valgfrie inputs: `working-directory` (monorepo), `runs-on` (JSON), `supabase-version` (standard 2.115.0), `guard-ref`.
`sql-guard.json` har to nøkler: `tester` (påkrevd, eldre drift-sjekker leser bare den) og `valgfrie` (f.eks.
`06-ingen-user-metadata-i-autorisasjon`): sjekkes bare der fila finnes i konsumenten, mangel er ikke en feil.
Når testene i framtid-security endres: `node scripts/sync-sql.mjs --manifest > sql-guard.json` her (PR mot dette repoet), ellers
feiler framtid-security sin CI. Selvtest: `bash tests/supabase-drift.test.sh` og en egen workflow som kjører hele jobben mot en grønn fixture.

## supabase-live-drift.yml — drift-sjekk mot live stg/prd (FRA-1765)

pgTAP tester skjemaet bygget fra migrasjonene. Denne kjører de universelle kartleggingsspørringene mot den **ekte**
databasen via Supabase Management API (kun lesing av kataloger, ingen DB-passord, ingen radinnhold i utskriften), så en ACL
som er endret manuelt i stg/prd blir fanget. Sjekker: anon default-ACL, anon-kjørbare funksjoner, tabeller uten RLS,
anon-skriv, `using (true)` og `user_metadata` i autorisasjon. Unntakene gjenbrukes fra prosjektets pgTAP-konfig
(`supabase/tests/database/_config.sqlinc`) og fra registeret `public.offentlige_tabeller` hvis det finnes.

```yaml
name: Supabase live-drift
on:
  workflow_dispatch:
  # schedule: [{ cron: '30 3 * * *' }]   # først når kjøringen er grønn og støyfri
jobs:
  prd:
    uses: Framtidmedia-no/ci-workflows/.github/workflows/supabase-live-drift.yml@<sha>
    with: { miljo: prd, project-ref: <ref> }   # eller secret SUPABASE_PROJECT_REF
    secrets:
      SUPABASE_ACCESS_TOKEN: ${{ secrets.SUPABASE_ACCESS_TOKEN }}   # Doppler ci, synket til GitHub
    permissions: { contents: read }
```

Én jobb per miljø (stg/prd). Valgfrie inputs: `config-file`, `working-directory`, `hopp-over` (kommaseparerte kind), `runs-on`.
Rødt betyr nye funn: rett opp med en migrasjon, ikke ved å utvide unntakene. Selvtest: `bash tests/live-drift.test.sh`
(engangs-Postgres bak en falsk Management API) og `selvtest-live-drift.yml`. Aldri kjør selvtesten mot en ekte database.

## ssrf-drift.yml — SSRF-guard er lik kanonisk (FRA-976)

Feiler hvis den genererte `src/lib/net/ssrf.ts` mangler, er redigert for hånd eller er utdatert mot
`security-guard.json` (sha256 per variant, bumpes sammen med `src/ssrf.ts` i
[framtid-security](https://github.com/Framtidmedia-no/framtid-security)). Kilden synkes inn med
`node scripts/sync.mjs <repo> [--server-only]` der.

```yaml
name: SSRF-drift
on:
  pull_request:
jobs:
  ssrf-drift:
    uses: Framtidmedia-no/ci-workflows/.github/workflows/ssrf-drift.yml@main
```

Valgfri input: `path` (default `src/lib/net/ssrf.ts`).

## branch-sweep.yml — Ukentlig branch-sveip

Kjører mandager og sletter brancher i alle repoer hos Framtidmedia-no, Gange-Rolv-AS og frlund3
som er **merget og eldre enn 7 dager**. Behold-lista er eksakt: `main`, `Main`, `dev`, `Dev`, `DEV`,
`beta`, `Beta`, pluss beskyttede brancher og brancher med åpen PR.

«Merget» betyr null commits foran default-branchen, *eller* en merget PR fra branchen der PR-ens
head-SHA er identisk med branchens nåværende SHA (squash-merge gjør at commit-telling lyver).
Alt annet beholdes og listes som «uavklart» i run-summary. Slettede brancher logges med SHA og kan
gjenopprettes:

```bash
gh api -X POST repos/<eier>/<repo>/git/refs -f ref=refs/heads/<navn> -f sha=<sha>
```

Kjør manuelt fra Actions-fanen. `dry-run` er på som default ved manuell kjøring.

Trenger secret `BRANCH_SWEEP_TOKEN` (PAT med repo-tilgang i alle tre eierne; kilden er Doppler
`felles/prd` → `GITHUB_BRANCH_SWEEP_TOKEN`). Dette er ikke en reusable workflow — den kjører bare her.

## tree-gronn.yml — hopp over duplikat-push

Svarer `skip=true` på push når samme tree (identiske filer) allerede var grønt på en `pull_request`-kjøring
av samme workflow. PR, `workflow_dispatch` og `schedule` hoppes aldri over. Se toppkommentaren i filen.

```yaml
jobs:
  tre:
    uses: Framtidmedia-no/ci-workflows/.github/workflows/tree-gronn.yml@main
    permissions: { contents: read, actions: read }
  test:
    needs: tre
    if: needs.tre.outputs.skip != 'true'
```
