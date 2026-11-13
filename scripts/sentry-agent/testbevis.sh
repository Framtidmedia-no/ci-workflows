#!/usr/bin/env bash
# Testbevis for sentry-agent (FRA-1976): beviser at de nye testene fanger feilen.
#
#   testbevis.sh "<testkommando>" <testfil>...
#
# Kjøres i en ren checkout der fiksen er committet (HEAD). Fasene kjører etter hverandre i SAMME sti
# ($tmp/arbeid), som lages fra bunnen før hver fase og slettes etterpå:
#   base-fasen: base (TESTBEVIS_BASE, ellers origin/dev, ellers origin-standardbranchen) pakket ut med
#               `git archive`, med BARE testfilene fra fiksen kopiert inn. Testene skal FEILE.
#   fiks-fasen: fiks-commiten pakket ut på samme måte. Testene skal PASSERE.
# Fasene har ingen .git (git-kommandoer feiler likt), samme sti, nye filtider og egen installasjon av
# avhengighetene (--frozen-lockfile --ignore-scripts, eller TESTBEVIS_INSTALL). Ingenting lenkes fra
# arbeidstreet. Testen ser altså bare forskjellen i koden. Exit 0 = bevis.
#
# Beviset er aldri nok alene: porten krever også grønn CI og claude-review uten blokkerende funn.
#
# Testfilene kommer fra modellens diff og behandles som ubetrodd input: de må være testfiler
# (*.test.* / *.spec.*), relative, uten .. og opsjoner, og endret i diffen mot base.
# Testkommandoen kommer fra sentry-repoer.json (betrodd) og deles på mellomrom med vilje.
set -uo pipefail

stopp() { echo "::error::Testbevis: $*" >&2; exit 1; }

[ $# -ge 1 ] || stopp "mangler testkommando"
kommando="$1"; shift
[ -n "$kommando" ] || stopp "tom testkommando"
[ $# -ge 1 ] || stopp "ingen testfiler. Uten en ny test finnes ikke noe bevis"

git rev-parse --is-inside-work-tree >/dev/null 2>&1 || stopp "ikke et git-repo"
rot="$(git rev-parse --show-toplevel)" || stopp "fant ikke repo-roten"
cd "$rot" || stopp "fant ikke repo-roten"

base="${TESTBEVIS_BASE:-}"
if [ -z "$base" ]; then
  if git rev-parse -q --verify "refs/remotes/origin/dev^{commit}" >/dev/null; then
    base=origin/dev
  else
    base="$(git symbolic-ref -q --short refs/remotes/origin/HEAD || echo origin/main)"
  fi
fi
base_sha="$(git rev-parse -q --verify "$base^{commit}")" || stopp "fant ikke base $base"
fiks_sha="$(git rev-parse HEAD)" || stopp "fant ikke HEAD"

[ -z "$(git status --porcelain --untracked-files=no)" ] || stopp "arbeidstreet har ucommittede endringer"

endret="$(git diff --name-only --no-renames "$base_sha" "$fiks_sha")"
er_endret() { printf '%s\n' "$endret" | grep -Fxq -- "$1"; }

testfiler=()
for f in "$@"; do
  case "$f" in
    -*|/*) stopp "ugyldig testfil: $f" ;;
  esac
  printf '%s' "$f" | grep -Eq '^[A-Za-z0-9._@()+/-]+$' || stopp "ugyldige tegn i testfil: $f"
  printf '/%s/' "$f" | grep -Fq '/../' && stopp "testfil med ..: $f"
  printf '%s' "$f" | grep -Eq '\.(test|spec)\.[cm]?[jt]sx?$' || stopp "ikke en testfil: $f"
  er_endret "$f" || stopp "testfilen er ikke endret mot $base: $f"
  git cat-file -e "$fiks_sha:$f" 2>/dev/null || stopp "testfilen finnes ikke i fiksen: $f"
  testfiler+=("$f")
done

andre=0
while IFS= read -r f; do
  [ -n "$f" ] || continue
  er_test=false
  for t in "${testfiler[@]}"; do [ "$t" = "$f" ] && er_test=true; done
  $er_test || andre=$((andre + 1))
done <<< "$endret"
[ "$andre" -gt 0 ] || stopp "diffen har bare testfiler, ingen fiks"

tmp="$(mktemp -d)" || stopp "mktemp feilet"
arbeid="$tmp/arbeid"
trap 'rm -rf "$tmp"' EXIT
# Ingen git-repo over arbeidsmappen skal bli funnet fra testene.
export GIT_CEILING_DIRECTORIES="$tmp"

read -r -a kmd <<< "$kommando"

installer() {
  if [ -n "${TESTBEVIS_INSTALL:-}" ]; then bash -c "$TESTBEVIS_INSTALL"; return; fi
  if [ -f pnpm-lock.yaml ]; then pnpm install --frozen-lockfile --ignore-scripts
  elif [ -f package-lock.json ]; then npm ci --ignore-scripts
  elif [ -f yarn.lock ]; then yarn install --frozen-lockfile --ignore-scripts
  else return 0
  fi
}

# klargjor <commit> [testfiler-fra-fiks]: tom $arbeid med innholdet i <commit>, nye filtider.
klargjor() {
  rm -rf "$arbeid"
  mkdir -p "$arbeid" || stopp "kunne ikke lage arbeidsmappe"
  git -C "$rot" archive --format=tar "$1" | tar -x -m -C "$arbeid" || stopp "kunne ikke pakke ut $1"
}

kjor_fase() { # navn → exit-kode fra testene
  (
    cd "$arbeid" || exit 125
    installer >/dev/null || { echo "::error::Installasjon feilet i $1-fasen" >&2; exit 125; }
    "${kmd[@]}" "${testfiler[@]}"
  )
}

# 1) Base + bare testfilene: skal feile.
klargjor "$base_sha"
for f in "${testfiler[@]}"; do
  mkdir -p "$arbeid/$(dirname "$f")"
  git -C "$rot" show "$fiks_sha:$f" > "$arbeid/$f" || stopp "kunne ikke hente $f"
done
echo "Kjører testene mot $base + testfilene (skal feile): ${kommando} ${testfiler[*]}"
kjor_fase base; rc_base=$?
[ "$rc_base" -ne 125 ] || stopp "base-fasen kunne ikke kjøres"

# 2) Fiks-commiten i samme sti: skal passere.
klargjor "$fiks_sha"
echo "Kjører testene mot fiksen (skal passere)"
kjor_fase fiks; rc_fiks=$?

if [ "$rc_base" -eq 0 ]; then stopp "testene passerer også på $base, så de beviser ikke feilen"; fi
if [ "$rc_fiks" -ne 0 ]; then stopp "testene feiler på fiksen (exit $rc_fiks)"; fi
echo "Testbevis OK: rød på $base (exit $rc_base), grønn på fiks."
