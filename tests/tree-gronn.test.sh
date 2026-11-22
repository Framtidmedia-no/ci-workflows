#!/usr/bin/env bash
# Selvtest for avgjørelsen i tree-gronn.yml (FRA-2060): trekker skriptet ut av workflowen og kjører det
# mot en falsk `gh` med faste API-svar. Ingen nettverk. Hovedregelen som testes: er det tvil, kjøres alt.
set -uo pipefail
RAD="$(cd "$(dirname "$0")/.." && pwd)"
WF="$RAD/.github/workflows/tree-gronn.yml"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
awk '/>>> avgjor/{f=1;next} /<<< avgjor/{f=0} f' "$WF" | sed 's/^          //' > "$TMP/avgjor.sh"
[ -s "$TMP/avgjor.sh" ] || { echo "FEILET: fant ikke avgjor-skriptet i tree-gronn.yml"; exit 1; }

mkdir -p "$TMP/bin"
cat > "$TMP/bin/gh" <<'GH'
#!/usr/bin/env bash
[ "$1" = api ] || exit 9
shift; sti="$1"; shift; uttrykk=""
while [ $# -gt 0 ]; do case "$1" in --jq) uttrykk="$2"; shift 2 ;; *) shift ;; esac; done
fil="$FX/$(printf '%s' "$sti" | tr '/?&=' '____').json"
[ -f "$fil" ] || { echo "HTTP 404: $sti" >&2; exit 1; }
if [ -n "$uttrykk" ]; then jq -r "$uttrykk" "$fil"; else cat "$fil"; fi
GH
chmod +x "$TMP/bin/gh"

R=eier/repo
sett() { printf '%s' "$2" > "$FX/$(printf '%s' "$1" | tr '/?&=' '____').json"; }
blob() { printf '{"path":"%s","mode":"%s","type":"blob","sha":"%s"}' "$1" "${3:-100644}" "$2"; }
tre() { # tre-sha oppføring...
  local t="$1"; shift; local inn; inn=$(IFS=,; echo "$*")
  sett "repos/$R/git/trees/$t?recursive=1" "{\"sha\":\"$t\",\"truncated\":false,\"tree\":[$inn]}"
}
commit() { sett "repos/$R/git/commits/$1" "{\"sha\":\"$1\",\"tree\":{\"sha\":\"$2\"},\"parents\":[{\"sha\":\"$3\"}]}"; }
kjoring() { # id sha gren [event] [head-repo]
  printf '{"id":%s,"head_sha":"%s","head_branch":"%s","event":"%s","conclusion":"success","head_repository":{"full_name":"%s"}}' \
    "$1" "$2" "$3" "${4:-push}" "${5:-$R}"
}
jobber() { sett "repos/$R/actions/runs/$1/jobs?per_page=100" "{\"jobs\":[$2]}"; }
jobb() { printf '{"name":"%s","conclusion":"%s"}' "$1" "$2"; }

# Grunnoppsett: base B (tree TB), testet commit M (tree TM), en grønn push-kjøring på dev med tree TM.
oppsett() {
  FX="$TMP/fx"; rm -rf "$FX"; mkdir -p "$FX"; export FX
  sett "repos/$R/actions/runs/500" '{"workflow_id":77}'
  sett "repos/$R/branches/dev" '{"protected":true}'
  sett "repos/$R/branches/main" '{"protected":true}'
  sett "repos/$R/branches/fri" '{"protected":false}'
  commit M TM B
  commit B TB A
  commit E TM D
  tre TB "$(blob src/a.ts a1)"
  tre TM "$(blob src/a.ts a2)"
  sett "repos/$R/actions/workflows/77/runs?event=push&status=success&per_page=30" \
    "{\"workflow_runs\":[$(kjoring 9 E dev)]}"
  jobber 9 "$(jobb Test success),$(jobb Lint success)"
}

kjor() { # skriver utfallet som «tung supabase skip»
  local ut="$TMP/output"; : > "$ut"
  env PATH="$TMP/bin:$PATH" FX="$FX" GITHUB_OUTPUT="$ut" GITHUB_STEP_SUMMARY=/dev/null \
    REPO="$R" SHA=M RUN_ID=500 EVENT="${EVENT:-pull_request}" SPARING="${SPARING:-true}" \
    BEVIS_JOBBER="${BEVIS-$'Test\nLint'}" BASE_REF="${BASE_REF-dev}" REF_NAME="${REF_NAME-1/merge}" \
    HEAD_REPO="${HEAD_REPO-$R}" BEFORE_SHA="${BEFORE-B}" bash "$TMP/avgjor.sh" >"$TMP/logg" 2>&1
  local rc=$?
  [ "$rc" = 0 ] || { cat "$TMP/logg" >&2; echo "krasj($rc)"; return; }
  verdi() { grep "^$1=" "$ut" | tail -1 | cut -d= -f2-; }
  echo "$(verdi hopp-tung) $(verdi hopp-supabase) $(verdi skip)"
}
ok=0
forvent() { local navn="$1" onsket="$2" fikk; fikk="$(kjor)"
  [ "$fikk" = "$onsket" ] || { tail -5 "$TMP/logg" >&2; echo "FEILET: ${navn} (fikk [${fikk}], ønsket [${onsket}])" >&2; exit 1; }
  echo "  ok: $navn"; ok=$((ok+1)); }

FULL="false false false"

# --- Gjenbruk av grønt tree
oppsett; forvent "identisk tree med grønn push-kjøring hopper over" "true true true"
oppsett; EVENT=push REF_NAME=dev BASE_REF="" HEAD_REPO="" forvent "push med identisk tree hopper over" "true true true"
oppsett; commit E TX D; tre TX "$(blob src/a.ts a9)"
forvent "dev har egne commits (ulikt tree) gir full CI" "false true false"
oppsett; jobber 9 "$(jobb Test skipped),$(jobb Lint success)"
forvent "hoppet jobb er ikke bevis (ingen kjede av hopp)" "false true false"
oppsett; jobber 9 "$(jobb Test failure),$(jobb Lint success)"
forvent "feilet jobb er ikke bevis" "false true false"
oppsett; jobber 9 "$(jobb Lint success)"
forvent "manglende påkrevd jobb er ikke bevis" "false true false"
oppsett; sett "repos/$R/actions/workflows/77/runs?event=push&status=success&per_page=30" "{\"workflow_runs\":[$(kjoring 9 E fri)]}"
forvent "kjøring på ubeskyttet branch er ikke bevis" "false true false"
oppsett; sett "repos/$R/actions/workflows/77/runs?event=push&status=success&per_page=30" "{\"workflow_runs\":[$(kjoring 9 E dev pull_request)]}"
forvent "pull_request-kjøring er ikke bevis" "false true false"
oppsett; sett "repos/$R/actions/workflows/77/runs?event=push&status=success&per_page=30" "{\"workflow_runs\":[$(kjoring 9 E dev push annen/fork)]}"
forvent "kjøring fra annet repo er ikke bevis" "false true false"
oppsett; BEVIS="" forvent "uten bevis-jobber ingen gjenbruk" "false true false"

# --- Endringer som alltid gir full CI, også med gyldig bevis
for sti in .github/workflows/ci.yml pnpm-lock.yaml package-lock.json apps/web/yarn.lock package.json \
  supabase/migrations/1_x.sql apps/a/supabase/config.toml .npmrc .gitleaks.toml vercel.json next.config.ts \
  src/middleware.ts .env.example Dockerfile; do
  oppsett; tre TM "$(blob src/a.ts a1)" "$(blob "$sti" ny)"
  forvent "full CI: $sti" "$FULL"
done
oppsett; tre TM "$(blob src/a.ts a1)" "$(blob .GitHub/workflows/ci.yml ny)"
forvent "store bokstaver lurer ikke deteksjonen" "$FULL"
oppsett; tre TB "$(blob src/a.ts a1)" "$(blob .github/workflows/ci.yml gammel)"; tre TM "$(blob src/a.ts a1)"
forvent "slettet workflow gir full CI" "$FULL"
oppsett; tre TB "$(blob docs/a.md a1)"; tre TM "$(blob docs/a.md a1 120000)"
forvent "symlenke maskert som docs gir full CI" "$FULL"
oppsett; tre TM "$(blob src/a.ts a1)" '{"path":"vendor/x","mode":"160000","type":"commit","sha":"s1"}'
forvent "submodul gir full CI" "$FULL"

# --- Docs og Supabase
oppsett; commit E TX D; tre TX "$(blob x y)"; tre TM "$(blob src/a.ts a1)" "$(blob docs/guide.md d1)" "$(blob README.md r1)"
forvent "rene docs hopper over tungt" "true true true"
oppsett; commit E TX D; tre TX "$(blob x y)"; tre TM "$(blob src/a.ts a1)" "$(blob 'docs/$(touch pwned).md' d1)"
forvent "filnavn tolkes aldri som kode" "true true true"
[ ! -e pwned ] && [ ! -e "$TMP/pwned" ] || { echo "FEILET: filnavn ble kjørt"; exit 1; }
oppsett; commit E TX D; tre TX "$(blob x y)"; tre TM "$(blob src/a.ts a1)" "$(blob docs/guide.mdx d1)"
forvent "mdx er kode, ikke docs" "false true false"
oppsett; commit E TX D; tre TX "$(blob x y)"; tre TM "$(blob src/a.ts a1)" "$(blob CLAUDE.md c1)"
forvent "agentinstruksjoner regnes ikke som docs" "false true false"
oppsett; commit E TX D; tre TX "$(blob x y)"; tre TM "$(blob src/a.ts a2)"
forvent "kode uten Supabase: tung kjører, Supabase hoppes" "false true false"
oppsett; commit E TX D; tre TX "$(blob x y)"; tre TM "$(blob src/a.ts a1)" "$(blob supabase/functions/f/index.ts s1)"
forvent "Supabase-fil kjører Supabase" "false false false"
oppsett; commit E TX D; tre TX "$(blob x y)"; tre TM "$(blob src/a.ts a1)" "$(blob apps/web/Supabase/tests/x.sql s1)"
forvent "Supabase i underkatalog, uansett store bokstaver" "false false false"

# --- Push med flere commits (rebase-merge): hele pushen teller, ikke bare siste commit
oppsett; commit E TX D; tre TX "$(blob x y)"; commit A TA Z
tre TA "$(blob src/a.ts gammel)" "$(blob docs/a.md d0)"
tre TB "$(blob src/a.ts a1)" "$(blob docs/a.md d0)"
tre TM "$(blob src/a.ts a1)" "$(blob docs/a.md d1)"
EVENT=push REF_NAME=dev BASE_REF="" HEAD_REPO="" BEFORE=A forvent "kode i tidligere commit i pushen er ikke docs" "false true false"
oppsett; commit A TA Z; tre TA "$(blob src/a.ts a1)" "$(blob .github/workflows/ci.yml gammel)"
tre TB "$(blob src/a.ts a1)"; tre TM "$(blob src/a.ts a2)"
EVENT=push REF_NAME=dev BASE_REF="" HEAD_REPO="" BEFORE=A forvent "workflow-endring i tidligere commit gir full CI" "$FULL"
oppsett; EVENT=push REF_NAME=dev BASE_REF="" HEAD_REPO="" BEFORE=0000000000000000000000000000000000000000 forvent "ny branch (null-SHA) gir full CI" "$FULL"
oppsett; EVENT=push REF_NAME=dev BASE_REF="" HEAD_REPO="" BEFORE="" forvent "manglende before gir full CI" "$FULL"

# --- Fail closed
oppsett; sett "repos/$R/git/trees/TM?recursive=1" '{"sha":"TM","truncated":true,"tree":[]}'
forvent "avkortet tree gir full CI" "$FULL"
oppsett; rm "$FX/repos_${R//\//_}_git_commits_M.json"; forvent "commit-oppslag feiler" "$FULL"
oppsett; rm "$FX/repos_${R//\//_}_git_trees_TB_recursive_1.json"; forvent "tree-oppslag feiler" "$FULL"
oppsett; printf 'ikke json' > "$FX/repos_${R//\//_}_git_trees_TM_recursive_1.json"; forvent "ugyldig JSON gir full CI" "$FULL"
oppsett; rm "$FX/repos_${R//\//_}_actions_runs_500.json"; forvent "workflow-oppslag feiler" "false true false"
oppsett; rm "$FX/repos_${R//\//_}_actions_runs_9_jobs_per_page_100.json"; forvent "jobb-oppslag feiler" "false true false"
oppsett; HEAD_REPO=annen/fork forvent "fork-PR gir full CI" "$FULL"
oppsett; BASE_REF=fri forvent "PR mot ubeskyttet base gir full CI" "$FULL"
oppsett; EVENT=push REF_NAME=fri BASE_REF="" HEAD_REPO="" forvent "push til ubeskyttet branch gir full CI" "$FULL"
for e in workflow_dispatch schedule merge_group pull_request_target; do
  oppsett; EVENT=$e forvent "hendelsen $e gir full CI" "$FULL"
done

# --- Uten sparing (standard): oppfører seg som før, med strengere bevis
eldre() { # base-ref-i-kjøringen status-fra-compare
  oppsett
  sett "repos/$R/actions/workflows/77/runs?event=pull_request&status=success&per_page=100" \
    "{\"workflow_runs\":[{\"head_sha\":\"H\",\"head_repository\":{\"full_name\":\"$R\"},\"pull_requests\":[{\"base\":{\"ref\":\"$1\",\"sha\":\"B\"}}]}]}"
  commit H TM B
  sett "repos/$R/compare/B...H" "{\"status\":\"$2\"}"
}
SPARING=false EVENT=pull_request forvent "av: PR kjører alltid" "  false"
eldre dev ahead; SPARING=false EVENT=push REF_NAME=dev BASE_REF="" HEAD_REPO="" forvent "av: push hopper når PR-en testet nøyaktig dette treet" "  true"
eldre dev diverged; SPARING=false EVENT=push REF_NAME=dev BASE_REF="" HEAD_REPO="" forvent "av: basen hadde commits PR-en manglet, så merge-treet var et annet" "  false"
eldre annen ahead; SPARING=false EVENT=push REF_NAME=dev BASE_REF="" HEAD_REPO="" forvent "av: PR mot en annen base er ikke bevis" "  false"

echo "tree-gronn: $ok tester ok"
