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

Valgfrie `with:`-inputs: `node-version` (default 24, brukes bare uten `.nvmrc`), `pnpm-version`
(default 11, brukes bare uten `packageManager`), `eslint-args` (default `.`), `typecheck: true`
(+ `typecheck-command`) for repoer uten egen CI.

Pakkebehandler oppdages fra lockfila. Repoer uten ESLint installert får en notice og porten hopper over.
Krasjer ESLint på PR-en (ugyldig config, manglende plugin) feiler porten — det er en reell feil.

## sikkerhet.yml — hemmeligheter og avhengighetsvarsler (FRA-1753)

Basis-nivået i sikkerhetsstandarden. To jobber:

1. **gitleaks** (CLI, låst versjon med verifisert sjekksum, ikke `gitleaks-action` som krever lisens for org). Skanner bare
   commits i PR-området (`base..HEAD`), så gammel historikk gjør ikke nye PR-er røde. Offentlige klientnøkler
   (`NEXT_PUBLIC_*`/`VITE_*`/`EXPO_PUBLIC_*`, anon-nøkler, `sb_publishable_*`, Sentry DSN, Stripe publishable) gir ikke falsk
   positiv; `service_role`-nøkler og andre hemmeligheter stopper PR-en.
2. **audit** (`pnpm audit`/`npm audit`, high og over) som advarsel. `fail-on-audit: true` gjør den til feil.

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

Valgfrie inputs: `runs-on` (JSON, f.eks. output fra `velg-runner.yml`), `gitleaks-config`, `fail-on-audit`. Selvtest:
`bash tests/sikkerhet.test.sh` (lokalt med `GITLEAKS_BIN=...`, i CI også nedlasting og sjekksum).
Oppgradering av gitleaks: ny versjon + begge sjekksummer i `env:`, kjør selvtesten.

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
Når testene i framtid-security endres: `node scripts/sync-sql.mjs --manifest > sql-guard.json` her (PR mot dette repoet), ellers
feiler framtid-security sin CI. Selvtest: `bash tests/supabase-drift.test.sh` og en egen workflow som kjører hele jobben mot en grønn fixture.

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
