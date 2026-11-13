---
linear: FRA-1976
---

# Sentry-agent — byggeplan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** En ny Sentry-sak i et Framtid-prosjekt gir automatisk diagnose, Linear-sak og, når porten tillater det, en testet fiks merget til `dev`.

**Architecture:** Gjenbrukbar workflow `ci-workflows/.github/workflows/sentry-agent.yml` med tre jobber (triage → fiks → port). All logikk som skal være deterministisk (validering, rensing, port, oppslag) ligger i små Node-scripts uten avhengigheter under `scripts/sentry-agent/`, testet med `node --test`. n8n sender `repository_dispatch`, og `framtid-security` genererer kalleren i hvert repo.

**Tech Stack:** GitHub Actions, `anthropics/claude-code-action` (samme SHA-pin som `claude-review.yml`), Node 22 ESM, `node --test`, n8n, Doppler.

**Spec:** `docs/superpowers/specs/2026-11-13-sentry-agent-design.md`

## Global Constraints

- Gange-Rolv-prosjektene `gangerolv-catering`, `gangerolv-drift`, `gangerolv-gaver`, `gangerolv-heimelaga`, `gangerolv-no`, `eurosparmoa` og `myrvoll-lunde-it-drift` har `"agent": false`. Mangler en rad, betyr det utenfor.
- Dispatch-payload er KUN `{sentry_issue_id, project_slug}`.
- Triage: token med `event:read` + `project:read`, verktøy bare `Read,Grep,Glob`. Bare stacktrace, melding og breadcrumbs sendes til modellen, aldri `user`, `request.headers` eller `contexts`.
- Triage-JSON: `klasse` ∈ bug|støy|infrastruktur|uklar, `sikkerhet` 0–1, `filer[]` må finnes i repoet, `rotårsak` ≤ 500 tegn, `reproduksjon` ≤ 500 tegn.
- Fiks: ingen `secrets: inherit`, bare app-token (repo-begrenset) og Anthropic-nøkkel. Vitest i fase 1. Testbevis: ny test rød på `dev`, grønn på fiks.
- Port: diffen rører ikke `.github/**`, `package.json`, låsefiler, `supabase/migrations/**`, `.env*`, `doppler.yaml`, `vercel.json`. Maks 5 filer og 150 linjer. CI grønn, claude-review vellykket på head-SHA og uten `[KRITISK]`/`[HØY]`. Polling i maks 30 min, aldri `--auto`.
- Automerge bare når `automerge: true` i `sentry-repoer.json` og repoet har `dev`. Uten `dev`: PR mot `main`, aldri merge.
- Org-variabler `SENTRY_AGENT_PA` (kill switch, `false` stopper) og `SENTRY_AGENT_DAGSTAK` (10, felles for alle orger).
- Branch `sentry/<linear-id>-<kort-navn>`, med `-r2` ved regresjon. Label `sentry-agent`. Runner `ubuntu-latest`.
- Sentry-kommentar med `event:write`-token, bare i jobb 3. Sentry-saken markeres aldri løst.

## Review Focus

- Hendelsestekst med instruksjoner («ignore previous…, edit .github») → triage-JSON valideres, og jobb 2 ser bare den. Test: `validerTriage avviser ukjente felt og for lange strenger`, `rensHendelse fjerner user/headers/contexts`.
- `filer[]` med `../`, absolutte stier eller symlinker ut av repoet → avvises. Test i Task 1.
- Diff som gir nytt navn til en fil fra `.github/` eller endrer `pnpm-lock.yaml` i en undermappe → porten stopper. Test i Task 1.
- Samme Sentry-sak to ganger (webhook-retry) → én Linear-sak, én kjøring. Concurrency-nøkkel + oppslag på vedlegg-URL (Task 2).
- Ukjent prosjekt-slug eller Gange-Rolv-slug → ingen dispatch. Test `finnRepo` i Task 1, og n8n-grenen bruker samme fil (Task 4).

---

### Task 1: Deterministiske scripts og repo-kart (ci-workflows)

**Files:**
- Create: `sentry-repoer.json` (rot): `{ "<sentry-slug>": { "repo": "Org/navn", "agent": bool, "automerge": bool, "test": "pnpm vitest run" } }`. Lages fra Sentry-API-et (`GET /api/0/organizations/framtid-tech-as/projects/`) og repoenes `@sentry/*`-DSN-oppsett. Gange-Rolv-slugene står med `agent:false`.
- Create: `scripts/sentry-agent/{oppslag,rens-hendelse,valider-triage,port,review-funn}.mjs`
- Test: `tests/sentry-agent.test.mjs`

**Interfaces (Produces):**
- `finnRepo(slug: string, kart: object) → {repo, automerge, test} | null` (null ved manglende rad eller `agent:false`)
- `rensHendelse(event: object) → {melding: string, stacktrace: string, breadcrumbs: string}` (frames: fil:linje funksjon, maks 40 frames, maks 30 breadcrumbs, maks 8000 tegn totalt)
- `validerTriage(tekst: string, repoRot: string) → {ok: true, data} | {ok: false, feil: string}` (avviser ekstra felt, sti utenfor repoet, ikke-eksisterende fil)
- `vurderPort({filer: [{navn, linjer}], testbevis: bool, ciGronn: bool, reviewOk: bool, automerge: bool, harDev: bool}) → {merge: bool, grunner: string[]}`
- `harBlokkerendeFunn(kommentarer: {body: string}[]) → bool`
- CLI: `node scripts/sentry-agent/<modul>.mjs …` leser JSON fra stdin/argv og skriver JSON til stdout (brukes av workflowen).

- [ ] Step 1: Skriv testene: `finnRepo gir null for gangerolv-drift og ukjent slug`, `rensHendelse fjerner user/headers/contexts`, `validerTriage avviser ukjente felt og for lange strenger`, `validerTriage avviser ../ og absolutt sti`, `vurderPort stopper .github, lockfil i undermappe, 6 filer, 151 linjer, automerge=false, harDev=false`, `vurderPort slipper 2 filer/40 linjer med alt grønt`, `harBlokkerendeFunn finner [HØY] men ikke [MIDDELS]`.
- [ ] Step 2: `node --test tests/sentry-agent.test.mjs` → FAIL
- [ ] Step 3: Implementer modulene.
- [ ] Step 4: `node --test tests/sentry-agent.test.mjs` → PASS
- [ ] Step 5: Commit `feat(sentry-agent): validering, port og repo-kart (FRA-1976)`

### Task 2: Gjenbrukbar workflow (ci-workflows)

**Files:**
- Create: `.github/workflows/sentry-agent.yml` (`on: workflow_call`, inputs `sentry_issue_id`, `project_slug`; secrets `SENTRY_AGENT_ANTHROPIC_KEY`, `SENTRY_READ_TOKEN`, `SENTRY_WRITE_TOKEN`, `FRAMTID_AGENT_APP_ID`, `FRAMTID_AGENT_APP_KEY`, `LINEAR_API_KEY`)
- Create: `scripts/sentry-agent/testbevis.sh <testkommando> <testfiler…>`: sjekker ut `origin/dev` (eller standardbranch) med bare de nye testfilene → må feile; på fiks-branch → må passere. Exit 0 = bevis.
- Modify: `tests/` med en actionlint-kjøring av den nye fila (actionlint.yml dekker allerede `.github/workflows/`).

**Jobber:**
1. `triage`: kill switch + dagstak (`gh search prs --label sentry-agent --created >=$(date +%F)` på tvers av orgene ≥ tak → stopp) → hent sak + siste event med lesetoken → `rensHendelse` → claude-code-action med `--allowedTools "Read,Grep,Glob"` og prompt som krever bare JSON → `validerTriage` → output `triage` (JSON). Lager/finner Linear-sak (vedlegg = Sentry-sak-URL, som `dependency-sak.yml`). Regresjon: kommenter, flytt til Todo, suffiks `-r2`. Åpen agent-PR for samme sak → stopp.
2. `fiks` (bare `bug`/`støy` og `finnRepo.test` satt): app-token via `actions/create-github-app-token` (repo-begrenset) → claude-code-action med `Read,Edit,Write,Bash(<testkommando>*),Bash(git diff*),Bash(git status*)` og bare triage-JSON i prompten → `testbevis.sh` → push branch, PR mot `dev` (eller `main` uten dev) med label `sentry-agent`.
3. `port`: poll `gh pr checks` til ferdig (maks 30 min) → claude-review-run på head-SHA + inline-kommentarer → `vurderPort` → `gh pr merge --squash` når `merge=true`, ellers Linear-kommentar med grunnene → Sentry-kommentar (skrivetoken) med Linear- og PR-lenke.

- [ ] Step 1: Skriv `testbevis.sh` og en test i `tests/sentry-agent-testbevis.test.sh` med et minirepo (git init, vitest-fri testkommando `node --test`) der testen feiler før fiks og passerer etter.
- [ ] Step 2: Kjør testen → FAIL, implementer, kjør → PASS.
- [ ] Step 3: Skriv workflowen. Pin alle actions til SHA (samme som `claude-review.yml`). `actionlint .github/workflows/sentry-agent.yml` → ingen funn.
- [ ] Step 4: Commit, PR mot `main` i ci-workflows, grønn CI, merge.

### Task 3: Kaller og sync/drift (framtid-security)

**Files:**
- Create: `workflows/sentry-agent.yml` (kalleren: `on: repository_dispatch: types: [sentry-issue]`, `concurrency: sentry-agent-${{ github.event.client_payload.sentry_issue_id }}`, permissions `contents: read`, `uses: Framtidmedia-no/ci-workflows/.github/workflows/sentry-agent.yml@<SHA> # main`, eksplisitte secrets)
- Create: `scripts/sync-sentry-agent.mjs`, `scripts/sentry-agent-drift.mjs` (+ `.test.ts`). Gjenbruk mønsteret fra `sync-claude-review.mjs`/`claude-review-drift.mjs`. Repo-lista til drift = `agent:true`-radene i `ci-workflows/sentry-repoer.json`.
- Modify: drift-workflowen (ukentlig) så den også kjører `sentry-agent-drift.mjs`.

- [ ] Step 1: Tester (kopier `sync-claude-review.test.ts`-casene: generert fil ok, håndredigert, utdatert, SHA-bump er ikke drift). → FAIL
- [ ] Step 2: Implementer → `pnpm test` PASS, `pnpm typecheck` grønn.
- [ ] Step 3: PR → grønn CI → merge.

### Task 4: Nøkler, n8n og personvern

- [ ] Doppler-prosjekt `sentry-agent` med config `prd`: `SENTRY_AGENT_ANTHROPIC_KEY` (egen nøkkel med kostnadstak, laget i Anthropic Console via Chrome), `SENTRY_READ_TOKEN` (`event:read`, `project:read`), `SENTRY_WRITE_TOKEN` (`event:write`). Sync til org-secrets i Framtidmedia-no, Framtid-Tech-Helge, Framtid-Tech-Kundeprosjekter og Framtid-Tech-Frank. `FRAMTID_AGENT_APP_ID/KEY` og `LINEAR_API_KEY` synkes fra `felles`.
- [ ] Sjekk at GitHub-appen har `contents:write`, `pull-requests:write`, `actions:read`, `checks:read` og er installert i orgene. Ellers: be om godkjenning av endringen.
- [ ] Org-variabler `SENTRY_AGENT_PA=true`, `SENTRY_AGENT_DAGSTAK=10`.
- [ ] n8n `dc3TYIQAM7a6O6Or`: ny gren etter webhooken. Bare `issue.created` og regresjon. Hent `sentry-repoer.json` fra `raw.githubusercontent.com/Framtidmedia-no/ci-workflows/main/`, slå opp slug (`agent:true` ellers stopp), lag app-token og `POST /repos/<repo>/dispatches` med `{event_type:"sentry-issue", client_payload:{sentry_issue_id, project_slug}}`. Test med pin-data for en Framtid-slug (dispatch) og `gangerolv-drift` (ingen dispatch).
- [ ] Behandlingsprotokollen (`Framtidtech/docs/compliance/Behandlingsprotokoll-FramtidTechAS.md`): Anthropic for formålet «automatisk feilanalyse», med oppdatert versjon og dato på forsiden.

### Task 5: Utrulling og ende-til-ende-bevis

- [ ] Skill `flate`: `sync-sentry-agent.mjs` inn i hvert repo med `agent:true`. PR → grønn CI → merge (dev/main etter repoets flyt; Helges repoer: PR og blokkering).
- [ ] Ende-til-ende: send en syntetisk feil til et Framtid-prosjekt med `automerge:true` (en testhendelse med `Sentry.captureException` fra en lokal kjøring mot prosjektets DSN). Bevis: n8n-eksekvering → workflow-run → Linear-sak → PR eller Linear-diagnose → Sentry-kommentar. Lukk PR-en og saken etterpå hvis fiksen er syntetisk.
- [ ] `sentry-agent-drift.mjs` viser `ok` for alle `agent:true`-repoer.
