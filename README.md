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
