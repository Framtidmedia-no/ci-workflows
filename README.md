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
