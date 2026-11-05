#!/usr/bin/env bash
# Selvtest for drift-jobben i supabase-test.yml: trekker skriptet ut av workflowen og kjører det mot
# fixture-prosjekter med kjente avvik. Ingen nettverk (manifestet leses fra sql-guard.json i repoet).
set -uo pipefail
RAD="$(cd "$(dirname "$0")/.." && pwd)"
WF="$RAD/.github/workflows/supabase-test.yml"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
export RUNNER_TEMP="$TMP"; export SQL_GUARD_FILE="$RAD/sql-guard.json"
awk '/>>> drift/{f=1;next} /<<< drift/{f=0} f' "$WF" | sed 's/^          //' > "$TMP/drift.sh"
[ -s "$TMP/drift.sh" ] || { echo "FEILET: fant ikke drift-skriptet"; exit 1; }
ok=0
forvent() { local navn="$1" forventet="$2"; shift 2; local ut rc; ut="$("$@" 2>&1)"; rc=$?
  [ "$rc" = "$forventet" ] || { echo "$ut" | tail -8 >&2; echo "FEILET: $navn (exit $rc, forventet $forventet)" >&2; exit 1; }
  echo "  ok ($rc): $navn"; ok=$((ok+1)); }
kopi() { rm -rf "$TMP/p"; mkdir -p "$TMP/p"; cp -R "$RAD/tests/fixtures/gronn/supabase" "$TMP/p/supabase"; }
T="$TMP/p/supabase/tests/database"
kopi; forvent "grønn fixture er lik kanonisk" 0 env WORKDIR="$TMP/p" bash "$TMP/drift.sh"
kopi; echo "-- håndredigert" >> "$T/00-rls-paa-alle-tabeller.test.sql"
forvent "håndredigert test stopper" 1 env WORKDIR="$TMP/p" bash "$TMP/drift.sh"
kopi; rm "$T/03-anon-ingen-skriv.test.sql"
forvent "manglende test stopper" 1 env WORKDIR="$TMP/p" bash "$TMP/drift.sh"
kopi; sed -i.bak 's/^select plan(1);/select plan(1); -- endret/' "$T/01-anon-kun-allowlist.test.sql"; rm -f "$T"/*.bak
forvent "endret innhold uten ny header stopper" 1 env WORKDIR="$TMP/p" bash "$TMP/drift.sh"
kopi; printf 'select 1;\n' > "$T/02-ingen-using-true.test.sql"
forvent "fil som ikke er generert stopper" 1 env WORKDIR="$TMP/p" bash "$TMP/drift.sh"
# Utdatert: manifestet bumpet mens fixturen står igjen på gammel hash
kopi; python3 - "$RAD/sql-guard.json" "$TMP/guard-ny.json" <<'PY'
import json,sys
d=json.load(open(sys.argv[1])); k=next(iter(d["tester"])); d["tester"][k]="0"*64
json.dump(d,open(sys.argv[2],"w"))
PY
forvent "utdatert mot kilden stopper" 1 env SQL_GUARD_FILE="$TMP/guard-ny.json" WORKDIR="$TMP/p" bash "$TMP/drift.sh"
# Kode mellom header og markør (hashen dekker bare teksten etter markøren)
kopi; python3 - "$T/04-security-definer-search-path.test.sql" <<'PY'
import sys
p=sys.argv[1]; s=open(p).read()
m='-- ---- framtid-security:start ----'
open(p,'w').write(s.replace(m,'drop table public.x;\n'+m,1))
PY
forvent "kode mellom header og markør stopper" 1 env WORKDIR="$TMP/p" bash "$TMP/drift.sh"
# Valgfrie tester (manifestets «valgfrie»): fravær er greit, men finnes fila må den være lik kilden.
valgfri() { # valgfri <modus: ok|redigert|utdatert> -> skriver $TMP/guard-valg.json og evt. fila i fixturen
  python3 - "$RAD/sql-guard.json" "$TMP/guard-valg.json" "$T" "$1" <<'PY'
import hashlib,json,sys
g,ut,t,modus=sys.argv[1:5]
d=json.load(open(g)); navn="99-valgfri.test.sql"; innhold="select 1;\n"
h=hashlib.sha256(innhold.encode()).hexdigest()
d["valgfrie"]={navn:h}
json.dump(d,open(ut,"w"))
if modus=="mangler": sys.exit(0)
if modus=="utdatert": d["valgfrie"][navn]="0"*64; json.dump(d,open(ut,"w"))
tekst=f"-- GENERERT – ikke rediger. Kilde: framtid-security@abc ({navn}, sha256: {h})\n-- Endringer gjøres i Framtidmedia-no/framtid-security (sql/tests) og synkes med scripts/sync-sql.mjs.\n-- ---- framtid-security:start ----\n"+(innhold+"-- hånd\n" if modus=="redigert" else innhold)
open(t+"/"+navn,"w").write(tekst)
PY
}
kopi; valgfri mangler; forvent "valgfri test som mangler er ikke en feil" 0 env SQL_GUARD_FILE="$TMP/guard-valg.json" WORKDIR="$TMP/p" bash "$TMP/drift.sh"
kopi; valgfri ok; forvent "valgfri test som er lik kilden passerer" 0 env SQL_GUARD_FILE="$TMP/guard-valg.json" WORKDIR="$TMP/p" bash "$TMP/drift.sh"
kopi; valgfri redigert; forvent "håndredigert valgfri test stopper" 1 env SQL_GUARD_FILE="$TMP/guard-valg.json" WORKDIR="$TMP/p" bash "$TMP/drift.sh"
kopi; valgfri utdatert; forvent "utdatert valgfri test stopper" 1 env SQL_GUARD_FILE="$TMP/guard-valg.json" WORKDIR="$TMP/p" bash "$TMP/drift.sh"
echo "SUPABASE-DRIFT-SELVTEST OK ($ok kontroller)"
