---
linear: FRA-1976
---

# Sentry-agent: fra ny feil til testet fiks på dev

**Dato:** 13.11.2026 · **Status:** utkast til godkjenning · **Eier:** Frank

## Hvorfor

I dag starter Frank en økt for hver Sentry-sak og presser den gjennom diagnose, test, fiks og release.
Volumet er lavt (7 uløste saker på 14 dager, fordelt på 3 av 40 Sentry-prosjekter), men hver sak koster en økt
og blir liggende til noen tar den. Målet er at hver ny sak er diagnostisert, og helst har en testet fiks
på `dev`, innen minutter. Frank skal ikke starte noe.

Frank valgte **nivå B** (13.11.2026): agenten kan merge til `dev` automatisk. Promotering til `main`
skjer i en økt med Frank, via `/ship`.

## Mål

1. En ny Sentry-sak (første gang sett, eller regresjon) i ett av de 40 prosjektene utløser en kjøring i det
   tilhørende repoet innen ca. 10 minutter.
2. Saken klassifiseres som **bug**, **støy** (klient-/nettleserstøy, utvidelser, bots) eller **infrastruktur**
   (Postgres-restart, GitHub-nedetid, leverandørbrudd).
3. **Bug:** agenten skriver en feilende test, gjør minste mulige fiks og åpner en PR mot `dev`.
   Automerge skjer når porten under er bestått.
4. **Støy:** et testet filter i Sentry-init (`ignoreErrors`/`beforeSend`) går samme vei.
5. **Infrastruktur:** bare en Linear-sak med funn, ingen PR.
6. Hver Sentry-sak gir én Linear-sak (uten duplikater), med lenke til PR og Sentry.
   Sentry-saken får en kommentar med lenkene, men markeres ikke som løst.

## Ikke-mål

- Promotering til `main` og prod-deploy. Det gjøres i økt (`/ship` → `verify-prod`).
- Å markere Sentry-saker som løst. Det skjer først etter prod-bevis, i økt, etter regelen i `verify-prod`.
- Fikser som krever databasemigrasjon, nye avhengigheter eller endrede workflows. Da blir PR-en stående for Frank.
- Renovate-majors og Socket-varsler. De kommer i fase 2 på samme rammeverk (se nederst).

## Anti-mål (feil selv om det virker)

- At tekst i en Sentry-hendelse kan styre agenten til å endre workflows, hemmeligheter eller avhengigheter.
  DSN-en er offentlig i frontend, så hvem som helst kan sende inn hendelser.
- En flom av PR-er. Det skal maks være én kjøring per Sentry-sak, og et dagstak for hele orgen.
- En sak som markeres løst uten rotårsak.

## Tilnærminger vurdert

| | Tilnærming | Fordel | Ulempe |
|---|---|---|---|
| **Valgt** | **Gjenbrukbar GitHub Actions-workflow i `ci-workflows`**, kalt fra hvert repo. Rulles ut og overvåkes av `framtid-security` på samme måte som `claude-review` | Samme mønster som `claude-review` og `dependency-sak`. Kortlevde GitHub-hostede runnere. Styres sentralt. Repoets egen CI kjører testene | Krever at hvert repo har kallende workflow (sync-scriptet gjør dette) |
| | Hodeløs `claude -p` på fremtid-support, startet av n8n | Enklest å starte | Kloner og hemmeligheter for 40 repoer på samme boks som n8n og Kuma. Én kompromittert kjøring når alt |
| | Paperclip | Agent-orgkart finnes | Kjører på en MacBook som sover. Ikke klart for drift |

## Design

### Flyt

```
Sentry (issue.created / regresjon)
  → eksisterende Internal Integration-webhook → n8n «Sentry -> Slack» (ny gren)
  → oppslag prosjekt-slug → repo i sentry-repoer.json
  → GitHub repository_dispatch «sentry-issue» med KUN {sentry_issue_id, project_slug}
  → repoets sentry-agent.yml → ci-workflows/.github/workflows/sentry-agent.yml
      jobb 1: triage (kun lesing)   → validert JSON
      jobb 2: fiks (kun ved bug/støy) → PR mot dev
      jobb 3: port                   → automerge eller «trenger Frank»
  → Linear-sak + Sentry-kommentar
```

### Jobb 1 – triage (her finnes den upålitelige teksten)

- Henter saken og siste hendelse fra Sentry-API-et med et token som **bare kan lese** (`event:read`, `project:read`).
- Claude får bare lesende verktøy på repoet (Read, Grep, Glob). Ingen Bash, ingen skriving, ingen nettverksverktøy.
- Utdata følger et fast JSON-skjema som valideres av et script, ikke av modellen:
  `klasse` (bug | støy | infrastruktur | uklar), `sikkerhet` (0–1), `filer[]` (må finnes i repoet),
  `rotårsak` (≤ 500 tegn), `reproduksjon` (≤ 500 tegn).
- Er JSON-en ugyldig, eller `klasse` = uklar: bare Linear-sak, merket «trenger vurdering».

### Jobb 2 – fiks (ser aldri rå hendelsestekst)

- Får bare den validerte JSON-en. Rå hendelsesdata sendes aldri videre.
- Claude har Read, Edit og Write, og Bash er låst til repoets egne kommandoer (test, lint, typecheck) og git.
- Den feilende testen kommer først. Workflowen **beviser** det selv: den nye testen kjøres mot `dev` (skal feile)
  og mot fiksen (skal passere). Uten en slik test blir det ingen PR, bare en Linear-sak.
- Branch `sentry/<linear-id>-<kort-navn>` (Linears GitHub-integrasjon flytter status). PR mot `dev` med label `sentry-agent`.
- Har repoet ingen testoppsett, blir det en Linear-sak med diagnosen, ingen PR.

### Jobb 3 – port for automerge (deterministisk script, ikke modell)

Automerge til `dev` (`gh pr merge --auto --squash`) bare når ALT stemmer:

- diffen rører ikke `.github/**`, `package.json`, låsefiler, `supabase/migrations/**`, `.env*`, `doppler.yaml` eller `vercel.json`
- maks 5 filer og 150 endrede linjer
- testbeviset fra jobb 2 er bestått
- repoets CI er grønn, og `claude-review` har ingen blokkerende funn

Ellers står PR-en åpen, og Linear-saken sier hvorfor porten stoppet den.

### Grenser og kostnad

- Én kjøring per Sentry-sak (concurrency-nøkkel = issue-id). Finnes Linear-saken allerede, hoppes saken over.
  En regresjon får én ny kjøring.
- Dagstak for hele orgen (org-variabel `SENTRY_AGENT_DAGSTAK`, start 10). Kill switch: org-variabel `SENTRY_AGENT_PA` = `false`.
- Egen Anthropic-nøkkel med kostnadstak i Doppler-prosjektet `sentry-agent/prd`, synket som org-secret.
- Kortlevde GitHub-hostede runnere (`ubuntu-latest`), ikke framtid-ci. Dette er upålitelig input.

### Rydding og promotering

- Når Frank sier «ship sentry» i en økt: `/ship` promoterer de mergede `sentry-agent`-fiksene fra `dev` til `main`,
  `verify-prod` beviser dem, og først da markeres Sentry-saken løst og Linear-saken Done.

## Utrulling

Alle repoer med et Sentry-prosjekt får workflowen samtidig via et nytt `sync-sentry-agent.mjs` i `framtid-security`,
med drift-sjekk som for `claude-review`. Kill switchen gjør en full utrulling trygg. Arkiverte repoer og
Gange-Rolv-repoer uten Framtid-tilknytning holdes utenfor.

## Gange-Rolv og andre orger

Sentry-orgen `framtid-tech-as` tar imot hendelser fra både Framtid- og Gange-Rolv-repoer (blant annet
`gangerolv-drift`, `-catering`, `-gaver`, `-heimelaga`, `-no`, `eurosparmoa` og `myrvoll-lunde-it-drift`).
Agenten dekker begge (Franks føring 13.11.2026).

- `ci-workflows` er offentlig, og alle orgene (Framtidmedia-no, Gange-Rolv-AS, Framtid-Tech-Helge) ligger i samme
  enterprise og tillater actionen, så samme gjenbrukbare workflow kan kalles fra alle.
- Linear-team velges per repo: `GR` for Gange-Rolv, `FRA` for Framtid, og repoets `LINEAR_TEAM_KEY` overstyrer.
- Gange-Rolv-repoer får egne Anthropic- og Sentry-nøkler i Gange-Rolvs Doppler-oppsett, ikke Framtids `felles`.
  Da holdes kostnad og tilgang adskilt per selskap.
- **Forutsetning (Franks avklaring):** Sentry-hendelser kan inneholde persondata (e-post, IP, URL-er).
  Agenten sender dem til Anthropics API. For Gange-Rolv må det dekkes av Gange-Rolvs eget avtalegrunnlag med
  Anthropic. For Framtid skal Anthropic stå i behandlingsprotokollen for dette formålet. Jobb 1 sender bare
  stacktrace, feilmelding og breadcrumbs til modellen, ikke `user`, `request.headers` eller `contexts`.

## Avklaringer etter byggersjekk (Claudes valg)

1. **Repo uten `dev`:** agenten åpner PR mot `main`, men den merges aldri automatisk (nivå B: aldri automatisk til prod).
2. **Andres repoer** (Framtid-Tech-Helge, kundeprosjekter, alt der eieren krever å merge selv, som AaFK): bare PR, ingen automerge.
   Automerge gjelder repoer i `Framtidmedia-no` og `Gange-Rolv-AS` med `dev`, og styres av en `automerge`-flagg per repo i `sentry-repoer.json`.
   Dagstaket er ett felles tak for alle orgene.
3. **Identitet:** PR-en åpnes med et token fra GitHub-appen, så repoets CI og claude-review faktisk starter
   (`GITHUB_TOKEN` starter ikke `pull_request`-workflows). Jobb 3 venter på CI ved polling i samme kjøring
   (maks 30 minutter). `--auto` brukes ikke, fordi det merger med en gang når `dev` mangler required checks.
4. **«Blokkerende funn» fra claude-review:** claude-review-kjøringen på PR-ens head-SHA må være fullført og vellykket, og
   den skal ikke ha lagt noen inline-kommentar merket `[KRITISK]` eller `[HØY]`. Mangler kjøringen, eller feilet den, blir det ingen automerge.
5. **Hemmeligheter i jobb 2:** ingen utover app-tokenet (begrenset til repoet) og Anthropic-nøkkelen. Ingen `secrets: inherit`.
   Tester som trenger Supabase eller Doppler teller ikke som bevis, og da blir det bare en Linear-sak.
6. **Regresjon:** en ny kjøring kommenterer på den eksisterende Linear-saken og flytter den til Todo, med branch-suffiks `-r2`.
   Står en agent-PR for samme sak fortsatt åpen, hoppes kjøringen over.
7. **Testbevis:** fase 1 støtter Vitest (brukt i ca. 20 repoer). Testkommandoen kan overstyres per repo i `sentry-repoer.json`.
   Andre repoer får diagnose og Linear-sak, men ingen PR.
8. **Sentry-kommentaren** skrives med et eget token med skrivetilgang (`event:write`), som bare brukes i jobb 3. Det er aldri i samme jobb som triage.

## Fase 2 (samme rammeverk, egen runde)

- **Renovate-major med rød CI:** jobb 2 og 3 kjøres på Renovate-branchen og retter bruddet (som TS 7).
- **Socket-varsel:** jobb 1 vurderer om sårbarheten er reell, og jobb 2 bumper pakken eller lager en Linear-sak.

## Avgjort av Claude (Frank kan overstyre)

- GitHub Actions i stedet for server eller Paperclip (se tabellen).
- Full utrulling med kill switch, ikke pilot.
- Støyfiltre automerges på samme port som bugfikser.
- Grensene på 5 filer og 150 linjer, og dagstaket på 10.

## Overlatt til den som bygger

- Om `repository_dispatch` sendes med GitHub-appen `FRAMTID_AGENT_APP` (Doppler `felles`) eller et eget token med minst mulig rettighet.
- Om `sentry-repoer.json` vedlikeholdes for hånd eller genereres fra Sentrys code mappings.
- Linear-team per repo: gjenbruk `LINEAR_TEAM_KEY` som i `dependency-sak.yml`.
