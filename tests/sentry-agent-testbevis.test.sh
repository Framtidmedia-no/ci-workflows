#!/usr/bin/env bash
# Selvtest for scripts/sentry-agent/testbevis.sh (FRA-1976): bygger små git-repoer der en ny test enten
# beviser fiksen (rød på base, grønn på fiks) eller ikke gjør det. Testkommandoen er `node --test`.
#   bash tests/sentry-agent-testbevis.test.sh
set -uo pipefail
RAD="$(cd "$(dirname "$0")/.." && pwd)"
BEVIS="$RAD/scripts/sentry-agent/testbevis.sh"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

ok=0
feil() { echo "FEILET: $*" >&2; exit 1; }
forvent() { # navn forventet-exit(0|ikke0) kommando...
  local navn="$1" forventet="$2"; shift 2
  local ut rc; ut="$("$@" 2>&1)"; rc=$?
  if { [ "$forventet" = 0 ] && [ "$rc" != 0 ]; } || { [ "$forventet" != 0 ] && [ "$rc" = 0 ]; }; then
    echo "$ut" | tail -20 >&2; feil "$navn: exit $rc, forventet $forventet"
  fi
  echo "  ok ($rc): $navn"; ok=$((ok+1))
}

# lag_repo <mappe>: base-branch «dev» med en bug i lib.mjs (summer trekker fra i stedet for å legge sammen).
lag_repo() {
  local d="$1"
  mkdir -p "$d" && cd "$d" || exit 1
  git init -q -b dev
  git config user.email t@t && git config user.name t && git config commit.gpgsign false
  printf 'export const summer = (a, b) => a - b\n' > lib.mjs
  printf 'export const annen = () => 1\n' > annen.mjs
  git add . && git commit -q -m base
  git switch -q -c fiks
}
ny_test() { # gyldig test som reproduserer buggen
  printf "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\nimport { summer } from './lib.mjs'\ntest('summer', () => assert.equal(summer(2, 3), 5))\n" > lib.test.mjs
}
fiks() { printf 'export const summer = (a, b) => a + b\n' > lib.mjs; }
commit() { git add -A && git commit -q -m "$1"; }

echo "testbevis.sh:"

# 1. Riktig: testen er rød på base og grønn på fiks.
lag_repo "$TMP/1"; ny_test; fiks; commit fiks
forvent "rød på base, grønn på fiks gir bevis" 0 env TESTBEVIS_BASE=dev bash "$BEVIS" "node --test" lib.test.mjs
[ "$(cat lib.mjs)" = 'export const summer = (a, b) => a + b' ] || feil "fiksen ble ikke gjenopprettet etter kjøringen"
[ -z "$(git status --porcelain)" ] || feil "arbeidstreet er ikke rent etter kjøringen"

# 2. Testen passerer også på base: beviser ingenting.
lag_repo "$TMP/2"
printf "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\nimport { annen } from './annen.mjs'\ntest('annen', () => assert.equal(annen(), 1))\n" > lib.test.mjs
fiks; commit fiks
forvent "test som er grønn på base gir ikke bevis" 1 env TESTBEVIS_BASE=dev bash "$BEVIS" "node --test" lib.test.mjs

# 3. Testen feiler også på fiks.
lag_repo "$TMP/3"; ny_test; commit "bare test"
printf 'export const summer = (a, b) => a * b\n' > lib.mjs; commit "feil fiks"
forvent "test som er rød på fiks gir ikke bevis" 1 env TESTBEVIS_BASE=dev bash "$BEVIS" "node --test" lib.test.mjs

# 4. Ingen testfiler.
lag_repo "$TMP/4"; fiks; commit fiks
forvent "ingen testfiler gir ikke bevis" 1 env TESTBEVIS_BASE=dev bash "$BEVIS" "node --test"

# 5. Testfil som ikke er endret i diffen (gammel test kan ikke være bevis).
lag_repo "$TMP/5"; git switch -q dev; ny_test; commit "test på dev"; git switch -q -c fiks2; fiks; commit fiks
forvent "testfil utenfor diffen gir ikke bevis" 1 env TESTBEVIS_BASE=dev bash "$BEVIS" "node --test" lib.test.mjs

# 6. Skittent arbeidstre.
lag_repo "$TMP/6"; ny_test; fiks; commit fiks; printf '// x\n' >> lib.mjs
forvent "skittent arbeidstre stoppes" 1 env TESTBEVIS_BASE=dev bash "$BEVIS" "node --test" lib.test.mjs
git checkout -q -- lib.mjs

# 7. Ugyldige filnavn (ikke testfil, sti med .., opsjon).
lag_repo "$TMP/7"; ny_test; fiks; commit fiks
forvent "ikke-testfil som testfil stoppes" 1 env TESTBEVIS_BASE=dev bash "$BEVIS" "node --test" lib.mjs
forvent "sti med .. stoppes" 1 env TESTBEVIS_BASE=dev bash "$BEVIS" "node --test" ../7/lib.test.mjs
forvent "filnavn som opsjon stoppes" 1 env TESTBEVIS_BASE=dev bash "$BEVIS" "node --test" --lib.test.mjs

# 8. Ny fil i fiksen (finnes ikke på base) fjernes under base-kjøringen og kommer tilbake etterpå.
lag_repo "$TMP/8"
printf "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\nimport { hjelp } from './hjelp.mjs'\ntest('hjelp', () => assert.equal(hjelp(), 2))\n" > hjelp.test.mjs
printf 'export const hjelp = () => 2\n' > hjelp.mjs; commit "ny modul"
forvent "ny modul: rød på base (mangler), grønn på fiks" 0 env TESTBEVIS_BASE=dev bash "$BEVIS" "node --test" hjelp.test.mjs
[ -f hjelp.mjs ] || feil "ny fil ble ikke gjenopprettet"

# 9. Uten TESTBEVIS_BASE brukes origin/dev.
lag_repo "$TMP/9"; ny_test; fiks; commit fiks
git update-ref refs/remotes/origin/dev "$(git rev-parse dev)"
forvent "origin/dev er standard base" 0 bash "$BEVIS" "node --test" lib.test.mjs

# 10. Forfalsket bevis: testen ser forskjell på fasene i stedet for å teste koden. Den passerer bare når
#     fase.txt (ignorert, uncommittet, finnes bare i agentens arbeidstre) finnes og treet er rent, og feiler
#     ellers. I samme arbeidstre ville base-fasen vært skitten og fiks-fasen ren. I egne worktrees fra
#     commitene finnes ikke fase.txt i noen fase, så det blir ikke bevis.
lag_repo "$TMP/10"
printf 'fase.txt\n' > .gitignore
printf 'x\n' > fase.txt
cat > fase.test.mjs <<'JS'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { execSync } from 'node:child_process'
test('fase', () => {
  const ren = execSync('git status --porcelain --untracked-files=no').toString() === ''
  assert.ok(existsSync('fase.txt') && ren)
})
JS
commit "falsk"
forvent "test som skiller fasene (fil bare i arbeidstreet) gir ikke falskt bevis" 1 env TESTBEVIS_BASE=dev bash "$BEVIS" "node --test" fase.test.mjs

# 11. Testene kjøres ikke i agentens arbeidstre: en fil testen skriver havner ikke der.
lag_repo "$TMP/11"; fiks
cat > lib.test.mjs <<'JS'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { summer } from './lib.mjs'
test('summer', () => { writeFileSync('spor.txt', 'x'); assert.equal(summer(2, 3), 5) })
JS
commit fiks
forvent "riktig bevis, testene kjører ikke i arbeidstreet" 0 env TESTBEVIS_BASE=dev bash "$BEVIS" "node --test" lib.test.mjs
[ ! -e spor.txt ] || feil "testen kjørte i agentens arbeidstre (spor.txt finnes)"
[ "$(git worktree list | wc -l | tr -d ' ')" = 1 ] || feil "midlertidige worktrees ble ikke ryddet"

# 12. pwd skiller ikke fasene: begge kjører i samme sti.
lag_repo "$TMP/12"; fiks
cat > lib.test.mjs <<'JS'
import { test } from 'node:test'
import assert from 'node:assert/strict'
test('pwd', () => assert.ok(/fiks/.test(process.cwd())))
JS
commit fiks
forvent "test som leser pwd gir ikke falskt bevis" 1 env TESTBEVIS_BASE=dev bash "$BEVIS" "node --test" lib.test.mjs

# 13. git log skiller ikke fasene.
lag_repo "$TMP/13"; fiks
cat > lib.test.mjs <<'JS'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execSync } from 'node:child_process'
test('git log', () => assert.equal(execSync('git log -1 --format=%s').toString().trim(), 'fiks'))
JS
commit fiks
forvent "test som leser git log gir ikke falskt bevis" 1 env TESTBEVIS_BASE=dev bash "$BEVIS" "node --test" lib.test.mjs

# 14. Fingeravtrykk: sti, git-tilstand og filene på toppnivå er like i begge fasene.
lag_repo "$TMP/14"; ny_test; fiks
mkdir -p "$TMP/14-spor"
cat >> lib.test.mjs <<'JS'
import { appendFileSync, readdirSync } from 'node:fs'
import { execSync as ex } from 'node:child_process'
let g; try { g = ex('git rev-parse HEAD 2>&1').toString() } catch (e) { g = 'feil' }
appendFileSync(process.env.SPOR + '/avtrykk', JSON.stringify([process.cwd(), g, readdirSync('.').sort()]) + '\n')
JS
commit fiks
forvent "fingeravtrykk: riktig bevis" 0 env SPOR="$TMP/14-spor" TESTBEVIS_BASE=dev bash "$BEVIS" "node --test" lib.test.mjs
[ "$(wc -l < "$TMP/14-spor/avtrykk" | tr -d ' ')" = 2 ] || feil "forventet to fingeravtrykk"
[ "$(sort -u "$TMP/14-spor/avtrykk" | wc -l | tr -d ' ')" = 1 ] || { cat "$TMP/14-spor/avtrykk" >&2; feil "fasene ser ulike ut for testen"; }
echo "  ok: begge fasene ser like ut for testen"; ok=$((ok+1))

# 15. Installasjon kjøres i hver fase (TESTBEVIS_INSTALL); node_modules fra arbeidstreet lenkes aldri inn.
lag_repo "$TMP/15"; fiks
cat > lib.test.mjs <<'JS'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { summer } from './lib.mjs'
test('summer', () => {
  assert.ok(existsSync('installert.txt'), 'install kjørte ikke i fasen')
  assert.ok(!existsSync('node_modules/hemmelig'), 'node_modules fra arbeidstreet ble lenket inn')
  assert.equal(summer(2, 3), 5)
})
JS
commit fiks
mkdir -p node_modules/hemmelig
forvent "install i hver fase, ingen lenket node_modules" 0 env TESTBEVIS_BASE=dev TESTBEVIS_INSTALL="touch installert.txt" bash "$BEVIS" "node --test" lib.test.mjs
rm -rf node_modules

echo "Alle $ok testbevis-tester bestod."
