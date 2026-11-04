#!/usr/bin/env bash
# Selvtest for .github/workflows/sikkerhet.yml: trekker skriptene ut av workflowen og kjører dem mot
# ekte git-repoer. Ingen hemmeligheter ligger i repoet: falske nøkler genereres ved kjøring.
#   Lokalt (uten nedlasting):  GITLEAKS_BIN=/sti/til/gitleaks bash tests/sikkerhet.test.sh
#   I CI (ubuntu):             bash tests/sikkerhet.test.sh   (tester også nedlasting og sjekksum)
set -uo pipefail
RAD="$(cd "$(dirname "$0")/.." && pwd)"
WF="$RAD/.github/workflows/sikkerhet.yml"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
export RUNNER_TEMP="$TMP/runner"; mkdir -p "$RUNNER_TEMP"
export GITHUB_OUTPUT="$TMP/output"; : > "$GITHUB_OUTPUT"

trekk() { awk -v m="$1" '$0 ~ ">>> "m{f=1;next} $0 ~ "<<< "m{f=0} f' "$WF" | sed 's/^          //'; }
trekk installer > "$TMP/installer.sh"; trekk skann > "$TMP/skann.sh"
[ -s "$TMP/installer.sh" ] && [ -s "$TMP/skann.sh" ] || { echo "FEILET: fant ikke skriptene i workflowen"; exit 1; }
# Versjon og sjekksummer leses fra workflowen, så testen alltid følger det som faktisk er låst.
for v in GITLEAKS_VERSION GITLEAKS_SHA256_X64 GITLEAKS_SHA256_ARM64; do
  export "$v=$(grep -E "^\s+$v:" "$WF" | head -1 | sed -E "s/^\s+$v:\s*'?([^' ]+)'?.*/\1/")"
done

ok=0; feil() { echo "FEILET: $*" >&2; exit 1; }
forvent() { # navn forventet-exit kommando...
  local navn="$1" forventet="$2"; shift 2
  local ut rc; ut="$("$@" 2>&1)"; rc=$?
  if [ "$rc" != "$forventet" ]; then echo "$ut" | tail -15 >&2; feil "$navn: exit $rc, forventet $forventet"; fi
  echo "  ok ($rc): $navn"; ok=$((ok+1))
}

b64u() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }
jwt() { local h p; h=$(printf '{"alg":"HS256","typ":"JWT"}' | b64u); p=$(printf '{"iss":"supabase","ref":"abcdefghijklmnopqrst","role":"%s","iat":1700000000,"exp":2000000000}' "$1" | b64u); echo "$h.$p.$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n')"; }

# --- Installasjon (bare på Linux: sjekksummene gjelder linux_x64/linux_arm64) ---
if [ -z "${GITLEAKS_BIN:-}" ]; then
  [ "$(uname -s)" = Linux ] || feil "sett GITLEAKS_BIN lokalt, installasjonen testes bare på Linux"
  echo "== Installasjon"
  forvent "låst versjon med riktig sjekksum" 0 bash "$TMP/installer.sh"
  grep -q "installert=true" "$GITHUB_OUTPUT" || feil "installert=true ble ikke satt"
  export GITLEAKS_BIN="$RUNNER_TEMP/gitleaks/gitleaks"
  [ "$("$GITLEAKS_BIN" version)" = "$GITLEAKS_VERSION" ] || feil "feil versjon installert"
  rm -rf "$RUNNER_TEMP/gitleaks"
  forvent "feil sjekksum stopper (aldri fail-open)" 1 env GITLEAKS_SHA256_X64=0000000000000000000000000000000000000000000000000000000000000000 GITLEAKS_SHA256_ARM64=0000000000000000000000000000000000000000000000000000000000000000 bash "$TMP/installer.sh"
  : > "$GITHUB_OUTPUT"
  forvent "nedlastingsfeil gir advarsel og hopper over, ikke rød" 0 env GITLEAKS_BASE_URL=http://127.0.0.1:9 bash "$TMP/installer.sh"
  grep -q "installert=false" "$GITHUB_OUTPUT" || feil "installert=false ble ikke satt ved nedlastingsfeil"
fi

# --- Skanning ---
echo "== Skanning"
REPO="$TMP/repo"; mkdir -p "$REPO"; cd "$REPO"
git init -q; git config user.email t@t; git config user.name t
echo "# ren" > a.md; git add -A; git commit -qm base; BASE=$(git rev-parse HEAD)
echo "GAMMEL=ghp_$(openssl rand -hex 18)" > gammel.env; git add -A; git commit -qm gammel
git rm -q gammel.env; git commit -qm fjern; MELLOM=$(git rev-parse HEAD)
skann() { env EVENT=pull_request BASE_SHA="$1" KONFIG_REPO=.gitleaks.toml bash "$TMP/skann.sh"; }

forvent "gammel historikk utenfor PR-området flagges ikke" 0 skann "$MELLOM"
echo "ren endring" > b.md; git add -A; git commit -qm ren
forvent "ren commit" 0 skann "$MELLOM"
printf 'NEXT_PUBLIC_SUPABASE_ANON_KEY=%s\nNEXT_PUBLIC_SENTRY_DSN=https://%s@o123.ingest.sentry.io/456\n' "$(jwt anon)" "$(openssl rand -hex 16)" > .env.example
git add -A; git commit -qm offentlige
forvent "offentlige klientnøkler (anon JWT, Sentry DSN) gir ikke falsk positiv" 0 skann "$MELLOM"
# Omgåelsesforsøk: unntakene skal ikke kunne skjule en hemmelighet bare fordi linja nevner en offentlig nøkkel.
PUBBASE=$(git rev-parse HEAD)
echo "# anon key, se docs: ghp_$(openssl rand -hex 18)" > omga1.txt; git add -A; git commit -qm omga1
forvent "ordet 'anon key' i en kommentar skjuler ikke en token på samme linje" 1 skann "$PUBBASE"
git rm -q omga1.txt; git commit -qm rm1; PUBBASE=$(git rev-parse HEAD)
echo "const t = \"ghp_$(openssl rand -hex 18)\"; // NEXT_PUBLIC_X=1" > omga2.js; git add -A; git commit -qm omga2
forvent "NEXT_PUBLIC_-navn midt på linja skjuler ikke en token" 1 skann "$PUBBASE"
git rm -q omga2.js; git commit -qm rm2
echo "SUPABASE_SERVICE_ROLE_KEY=$(jwt service_role)" > .env.prod; git add -A; git commit -qm service
forvent "service_role-nøkkel stopper PR-en" 1 skann "$MELLOM"
git rm -q .env.prod; git commit -qm fjern2
echo "TOKEN=ghp_$(openssl rand -hex 18)" > ny.env; git add -A; git commit -qm lekk
forvent "ny token i PR-området stopper PR-en" 1 skann "$MELLOM"
forvent "gammel token blir funnet når den ligger i området" 1 skann "$BASE"
git rm -q ny.env; git commit -qm fjern3
forvent "token fjernet igjen i siste commit ligger fortsatt i historikken i området" 1 skann "$MELLOM"

printf '[extend]\nuseDefault = true\n[[allowlists]]\ndescription = "testdata"\npaths = [%s^testdata/%s]\n' "'''" "'''" > .gitleaks.toml
mkdir -p testdata; echo "T=ghp_$(openssl rand -hex 18)" > testdata/fixture.env; git add -A; git commit -qm testdata
NYBASE=$(git rev-parse HEAD~1)
forvent "repoets egen .gitleaks.toml kjedes inn (testdata-unntak)" 0 skann "$NYBASE"
printf '[[allowlists]]\ndescription = "uten useDefault"\npaths = [%s^x/%s]\n' "'''" "'''" > .gitleaks.toml
forvent "repo-konfig uten useDefault avvises (ellers stille uten standardregler)" 1 skann "$NYBASE"
printf 'title = "x"\n[[rules]\nbroken' > .gitleaks.toml; printf '[extend]\nuseDefault = true\n' >> .gitleaks.toml
forvent "ugyldig toml gir rød (verktøyfeil er ikke grønt)" 1 skann "$NYBASE"
rm -f .gitleaks.toml
# Push til ny gren: før-SHA er alle nuller, og vi skanner siste commit
echo "TOKEN=ghp_$(openssl rand -hex 18)" > sist.env; git add -A; git commit -qm sist
forvent "push til ny gren skanner siste commit" 1 env EVENT=push BEFORE_SHA=0000000000000000000000000000000000000000 BASE_SHA= KONFIG_REPO=.gitleaks.toml bash "$TMP/skann.sh"

echo "SIKKERHET-SELVTEST OK ($ok kontroller)"
