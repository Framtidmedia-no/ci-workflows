#!/usr/bin/env bash
# Selvtest for runner-vakten (FRA-2060): fork-kode skal aldri nå de persistente runnerne, og et feilet
# runner-valg skal aldri gjøre en påkrevd sjekk til «skipped». Ingen nettverk (falsk `gh`).
set -uo pipefail
RAD="$(cd "$(dirname "$0")/.." && pwd)"
WFD="$RAD/.github/workflows"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
awk '/>>> velg/{f=1;next} /<<< velg/{f=0} f' "$WFD/velg-runner.yml" | sed 's/^          //' > "$TMP/velg.sh"
[ -s "$TMP/velg.sh" ] || { echo "FEILET: fant ikke velg-skriptet i velg-runner.yml"; exit 1; }

mkdir -p "$TMP/bin"
printf '#!/usr/bin/env bash\nexit 0\n' > "$TMP/bin/gh"
chmod +x "$TMP/bin/gh"

R=eier/repo
EGEN='["self-hosted","framtid-ci"]'
HOSTET='"ubuntu-latest"'
ok=0
velg() { # hendelse pr-nummer head-repo aldri-overløp [github-etiketter]
  local ut="$TMP/output"; : > "$ut"
  env PATH="$TMP/bin:$PATH" GITHUB_OUTPUT="$ut" GITHUB_STEP_SUMMARY=/dev/null GITHUB_REPOSITORY="$R" GITHUB_RUN_ID=1 \
    HENDELSE="$1" PR_NUMMER="$2" HEAD_REPO="$3" ALDRI_OVERLOP="$4" GITHUB_VALG="${5:-$HOSTET}" \
    BASE="$EGEN" TERSKEL=12 STATUS="" GREN=feature/x bash "$TMP/velg.sh" > /dev/null 2>&1
  grep '^etiketter=' "$ut" | tail -1 | cut -d= -f2-
}
forvent() { local navn="$1" onsket="$2" fikk; shift 2; fikk="$(velg "$@")"
  [ "$fikk" = "$onsket" ] || { echo "FEILET: ${navn} (fikk [${fikk}], ønsket [${onsket}])" >&2; exit 1; }
  echo "  ok: $navn"; ok=$((ok+1)); }

forvent "intern PR med aldri-overløp bruker egne runnere" "$EGEN" pull_request 7 "$R" true
forvent "intern PR uten last bruker egne runnere" "$EGEN" pull_request 7 "$R" ""
forvent "push bruker egne runnere" "$EGEN" push "" "" true
forvent "fork-PR med aldri-overløp går til GitHub" "$HOSTET" pull_request 7 annen/fork true
forvent "fork-PR uten aldri-overløp går til GitHub" "$HOSTET" pull_request 7 annen/fork ""
forvent "pull_request_target fra fork går til GitHub" "$HOSTET" pull_request_target 7 annen/fork true
forvent "slettet fork (tomt head-repo) går til GitHub" "$HOSTET" pull_request 7 "" true
forvent "PR-hendelse uten nummer og head-repo regnes som fork" "$HOSTET" pull_request "" "" true
forvent "fork kan ikke få egne runnere via github-etiketter" "$HOSTET" pull_request 7 annen/fork true "$EGEN"

# Hver runs-on som kan gi en egen runner må ha fork-vakten i selve uttrykket.
VAKT="github.event.pull_request.number && github.event.pull_request.head.repo.full_name != github.repository"
for f in "$WFD"/*.yml; do
  while IFS= read -r linje; do
    case "$linje" in
      *"$VAKT"*) ok=$((ok+1)) ;;
      *) echo "FEILET: runs-on uten fork-vakt i $(basename "$f"): $linje" >&2; exit 1 ;;
    esac
  done < <(grep -E '^[[:space:]]+runs-on:.*fromJSON' "$f")
done
echo "  ok: alle runs-on med fromJSON har fork-vakt"

# Lint-porten: feilet runner-valg skal gi en kjøring på GitHub, ikke en hoppet sjekk.
blokk="$(awk '/^  lint-port:/{f=1} f&&/^    steps:/{exit} f' "$WFD/lint-gate.yml")"
grep -Fq 'if: ${{ !cancelled() && !inputs.hopp-over }}' <<< "$blokk" \
  || { echo "FEILET: lint-port mangler !cancelled() && !inputs.hopp-over" >&2; exit 1; }
echo "  ok: lint-port kjører selv om runner-valget feilet"; ok=$((ok+1))
grep -Fq "needs.runner.outputs.etiketter || '\"ubuntu-latest\"'" <<< "$blokk" \
  || { echo "FEILET: lint-port mangler fallback til ubuntu-latest" >&2; exit 1; }
echo "  ok: lint-port faller tilbake til ubuntu-latest"; ok=$((ok+1))

echo "runner-vakt: $ok kontroller ok"
