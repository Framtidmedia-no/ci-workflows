#!/usr/bin/env bash
# Selvtest for supabase-live-drift.yml: kjører skriptet fra workflowen mot en falsk Management API som i sin tur
# spør en engangs-Postgres (Supabase-imaget). Beviser at en ren database er grønn og at hvert avvik gjør den rød.
# Rører aldri en ekte database. Krever docker og node.
#   bash tests/live-drift.test.sh
set -uo pipefail
RAD="$(cd "$(dirname "$0")/.." && pwd)"
WF="$RAD/.github/workflows/supabase-live-drift.yml"
IMG="${SQL_SELVTEST_IMAGE:-public.ecr.aws/supabase/postgres:17.11.0.006}"
NAVN="live-drift-selvtest-$$"
TMP="$(mktemp -d)"
REF="abcdefghijklmnopqrst"
TOKEN="selvtest-$(openssl rand -hex 8)"
PORT="$((20000 + RANDOM % 20000))"
cleanup() { [ -n "${API_PID:-}" ] && kill "$API_PID" 2>/dev/null; docker rm -f "$NAVN" >/dev/null 2>&1; rm -rf "$TMP"; }
trap cleanup EXIT
feil() { echo "FEILET: $*" >&2; exit 1; }

awk '/>>> drift/{f=1;next} /<<< drift/{f=0} f' "$WF" | sed 's/^          //' > "$TMP/drift.sh"
[ -s "$TMP/drift.sh" ] || feil "fant ikke skriptet i workflowen"

docker run -d --rm --name "$NAVN" -e POSTGRES_PASSWORD="$(openssl rand -hex 12)" "$IMG" >/dev/null
for _ in $(seq 1 90); do
  if docker logs "$NAVN" 2>&1 | grep -q "PostgreSQL init process complete" && docker exec "$NAVN" pg_isready -U postgres -q 2>/dev/null \
    && [ "$(docker exec "$NAVN" psql -U supabase_admin -d postgres -Atc "select count(*) from pg_roles where rolname = 'anon'" 2>/dev/null)" = "1" ]; then READY=1; break; fi
  sleep 2
done
[ "${READY:-0}" = "1" ] || feil "Postgres ble ikke klar"
sqla() { docker exec -i "$NAVN" psql -U supabase_admin -d postgres -q -v ON_ERROR_STOP=1 -c "$1" >/dev/null || feil "sql (admin) feilet: $1"; }
sql() { docker exec -i "$NAVN" psql -U postgres -d postgres -q -v ON_ERROR_STOP=1 -c "$1" >/dev/null || feil "sql feilet: $1"; }

mkdir -p "$TMP/api"
node "$RAD/tests/live-drift-api.mjs" "$PORT" "$NAVN" "$TOKEN" "$REF" "$TMP/api" > "$TMP/api.log" 2>&1 & API_PID=$!; disown "$API_PID" 2>/dev/null
for _ in $(seq 1 30); do grep -q klar "$TMP/api.log" && break; sleep 0.3; done
grep -q klar "$TMP/api.log" || feil "falsk API startet ikke"

ok=0
kjor() { # kjor <modus> -> bruker $KONF som prosjektets konfig (tom = ingen)
  mkdir -p "$TMP/p/supabase/tests/database"
  rm -f "$TMP/p/supabase/tests/database/_config.sqlinc"
  [ -n "${KONF:-}" ] && printf '%s\n' "$KONF" > "$TMP/p/supabase/tests/database/_config.sqlinc"
  env SUPABASE_ACCESS_TOKEN="${TOK:-$TOKEN}" REF_INPUT="${REFIN:-$REF}" REF_SECRET="" MILJO=selvtest WORKDIR="$TMP/p" \
    CONFIG_FILE=supabase/tests/database/_config.sqlinc HOPP_OVER="${HOPP:-}" UTVIDET="${UTVIDET:-false}" DRIFT_API_BASE="http://127.0.0.1:$PORT" GITHUB_STEP_SUMMARY="$TMP/sammendrag.md" \
    bash "$TMP/drift.sh" 2>&1
}
forvent() { # forvent <navn> <exit> [tekst som skal stå i utskriften]
  local navn="$1" forventet="$2" tekst="${3:-}" ut rc
  ut="$(kjor)"; rc=$?
  if [ "$rc" != "$forventet" ]; then echo "$ut" | tail -15 >&2; feil "$navn: exit $rc, forventet $forventet"; fi
  if [ -n "$tekst" ] && ! grep -qF -- "$tekst" <<<"$ut"; then echo "$ut" | tail -15 >&2; feil "$navn: mangler «$tekst» i utskriften"; fi
  echo "  ok ($rc): $navn"; ok=$((ok+1))
}
bryt() { # bryt <navn> <forventet tekst> <sql som bryter> <sql som retter>
  sql "$3"; forvent "$1 stopper" 1 "$2"; sql "$4"; forvent "$1 er borte igjen" 0 "OK: ingen nye funn"
}

echo "== Grønn database (baseline-ekvivalent, RLS på, ingen avvik)"
sql "alter default privileges for role postgres in schema public revoke all on tables from anon"
sql "alter default privileges for role postgres in schema public revoke all on sequences from anon"
sql "alter default privileges for role postgres in schema public revoke execute on functions from anon"
sql "alter default privileges for role postgres revoke execute on functions from public"
sql "create table public.ordre (id bigint generated always as identity primary key, eier uuid not null, kunde text)"
sql "alter table public.ordre enable row level security"
sql "create policy eier on public.ordre for select to authenticated using (eier = auth.uid())"
sql "create function public.ny() returns int language sql security definer set search_path = '' as \$\$ select 1 \$\$"
forvent "ren database er grønn" 0 "OK: ingen nye funn"

echo "== Feil token og feil ref stopper (ingen stille grønn)"
TOK=feil forvent "feil token" 1 "Management API svarte 401"
REFIN=feil forvent "ugyldig ref" 1 "project-ref"
REFIN=zzzzzzzzzzzzzzzzzzzz forvent "ukjent ref gir 404" 1 "svarte 404"

echo "== Hvert avvik gjør den rød, og grønn igjen når det rettes"
bryt "anon default-ACL" "anon_default_acl" "alter default privileges for role postgres in schema public grant select on tables to anon" "alter default privileges for role postgres in schema public revoke all on tables from anon"
bryt "anon-kjørbar funksjon" "anon_kan_kjore_funksjon: public.ny()" "grant execute on function public.ny() to anon" "revoke execute on function public.ny() from public, anon, authenticated; grant execute on function public.ny() to authenticated"
bryt "tabell uten RLS" "rls_av: public.apen" "create table public.apen (id int)" "drop table public.apen"
bryt "anon-skriv" "anon_kan_endre: public.ordre" "grant insert on public.ordre to anon" "revoke insert on public.ordre from anon"
bryt "anon-skriv på visning" "anon_kan_endre: public.vis" "create view public.vis with (security_invoker = true) as select id from public.ordre; grant delete on public.vis to anon" "drop view public.vis"
bryt "using(true)" "using_true: public.ordre: bred" "create policy bred on public.ordre for select to authenticated using (true)" "drop policy bred on public.ordre"
bryt "user_metadata i policy" "user_metadata: public.ordre: meta" "create policy meta on public.ordre for select to authenticated using ((current_setting('request.jwt.claims', true)::jsonb -> 'user_metadata' ->> 'tenant') = kunde)" "drop policy meta on public.ordre"
bryt "user_metadata i funksjon" "user_metadata: public.er_admin()" "create function public.er_admin() returns boolean language sql stable set search_path = '' as \$\$ select (select raw_user_meta_data ->> 'rolle' from auth.users limit 1) = 'admin' \$\$" "drop function public.er_admin()"

echo "== Unntak fra prosjektets pgTAP-konfig gjenbrukes"
sql "grant execute on function public.ny() to anon"
KONF="insert into tests_anon_funksjon_allowlist values ('public.ny()') on conflict do nothing; -- kalles før innlogging, godkjent i test"
forvent "allowlist-unntak slipper gjennom" 0 "OK: ingen nye funn"
KONF="-- insert into tests_anon_funksjon_allowlist values ('public.ny()')" forvent "utkommentert unntak teller ikke" 1 "anon_kan_kjore_funksjon"
KONF="insert into tests_anon_funksjon_allowlist values ('public.annen()') on conflict do nothing;" forvent "unntak for annen signatur teller ikke" 1 "anon_kan_kjore_funksjon"
sql "revoke execute on function public.ny() from public, anon, authenticated; grant execute on function public.ny() to authenticated"
sql "create table public.ref (id int); alter table public.ref enable row level security; create policy r on public.ref for select to authenticated using (true)"
forvent "using(true) uten unntak" 1 "using_true: public.ref: r"
KONF="insert into tests_using_true_unntak values ('ref', 'SELECT') on conflict do nothing;" forvent "using(true)-unntak per kommando" 0 "OK: ingen nye funn"
KONF="insert into tests_using_true_unntak (tabell, kommando) values
  ('annen', 'SELECT'), ('ref', 'SELECT') -- kolonneliste og flere rader
on conflict do nothing;" forvent "kolonneliste og flere rader i én insert" 0 "OK: ingen nye funn"
KONF="insert into tests_using_true_unntak values ('ref', 'INSERT') on conflict do nothing;" forvent "unntak for feil kommando teller ikke" 1 "using_true"
sql "drop policy r on public.ref; alter table public.ref disable row level security"
KONF="insert into tests_rls_unntak values ('ref') on conflict do nothing;" forvent "rls-unntak" 0 "OK: ingen nye funn"
sql "alter table public.ref enable row level security"
sql "grant update on public.ref to anon"
forvent "anon-skriv uten unntak" 1 "anon_kan_endre: public.ref"
KONF="insert into tests_anon_skriv_unntak values ('ref') on conflict do nothing;" forvent "anon-skriv-unntak" 0 "OK: ingen nye funn"
sql "revoke update on public.ref from anon; create policy r on public.ref for select to authenticated using (true)"
HOPP="using_true,user_metadata" KONF="" forvent "hopp-over av kind" 0 "OK: ingen nye funn" 
echo "== Register over åpne tabeller (offentlige_tabeller) leses fra den live databasen"
sql "create table public.offentlige_tabeller (table_name text primary key, begrunnelse text not null check (length(begrunnelse) >= 10)); alter table public.offentlige_tabeller enable row level security; revoke all on public.offentlige_tabeller from public, anon, authenticated"
forvent "register uten rad: using(true) flagges" 1 "using_true: public.ref: r"
sql "insert into public.offentlige_tabeller values ('ref', 'Delt referanseliste, ikke kundedata.')"
forvent "registrert tabell er unntatt" 0 "1 fra offentlige_tabeller"
bryt "skrivepolicy med true på registrert tabell" "using_true: public.ref: skriv" "create policy skriv on public.ref for insert to authenticated with check (true)" "drop policy skriv on public.ref"

echo "== Utskriften har bare objektnavn, aldri radinnhold"
sql "insert into public.ordre (eier, kunde) values (gen_random_uuid(), 'HEMMELIG-KUNDENAVN')"
sql "grant insert on public.ordre to anon"
ut="$(kjor)"; grep -q "HEMMELIG-KUNDENAVN" <<<"$ut" && feil "radinnhold lekket til utskriften"
echo "  ok: ingen radinnhold i utskriften"; ok=$((ok+1))
[ -s "$TMP/sammendrag.md" ] && ! grep -q "HEMMELIG-KUNDENAVN" "$TMP/sammendrag.md" || feil "sammendraget mangler eller lekker"
echo "== Utvidede sjekker (FRA-1896) er rådgivende: varsler, men aldri rød jobb"
sqla "create schema if not exists storage; create table if not exists storage.buckets (id text primary key, public boolean not null default false); grant all on storage.buckets to postgres"
sqla "alter system set log_connections = 'off'"; sqla "select pg_reload_conf()"
sql "revoke insert on public.ordre from anon" ; sql "delete from public.ordre"
sql "drop policy if exists r on public.ref"
ok_api() { printf '%s' '{"config":{"dbAllowedCidrs":["203.0.113.7/32"],"dbAllowedCidrsV6":[]}}' > "$TMP/api/nettverk.json"
  printf '%s' '{"currentConfig":{"database":true}}' > "$TMP/api/ssl.json"
  printf '%s' '{"password_min_length":12,"password_hibp_enabled":true,"jwt_exp":3600,"mfa_totp_enroll_enabled":true}' > "$TMP/api/auth.json"; }
ok_api
UTVIDET=false forvent "utvidet av: ingen utvidede sjekker kjører" 0 "OK: ingen nye funn"
ut="$(UTVIDET=false kjor)"; grep -q "Utvidede sjekker" <<<"$ut" && feil "utvidede sjekker kjørte uten å være slått på"
UTVIDET=true forvent "utvidet på: åpne funn gir varsel, men exit 0" 0 "Utvidede sjekker (rådgivende)"
UTVIDET=true forvent "log_connections av flagges" 0 "logging_tilkoblinger"
UTVIDET=true forvent "manglende pgaudit flagges" 0 "logging_pgaudit"
sqla "alter system set log_connections = 'on'"; sqla "select pg_reload_conf()"
printf '%s' '{"config":{"dbAllowedCidrs":["0.0.0.0/0"],"dbAllowedCidrsV6":["::/0"]}}' > "$TMP/api/nettverk.json"
UTVIDET=true forvent "åpent nettverk gir varsel" 0 "nettverk_apent"
printf '%s' '{"currentConfig":{"database":false}}' > "$TMP/api/ssl.json"
UTVIDET=true forvent "SSL av gir varsel" 0 "ssl_ikke_pavunget"
printf '%s' '{"password_min_length":6,"password_hibp_enabled":false,"jwt_exp":604800,"mfa_totp_enroll_enabled":false}' > "$TMP/api/auth.json"
UTVIDET=true forvent "svak auth-konfig gir fire varsler" 0 "auth_passordlengde"
UTVIDET=true forvent "lekket-passord av" 0 "auth_lekket_passord"
UTVIDET=true forvent "lang JWT-levetid" 0 "auth_jwt_utloep"
UTVIDET=true forvent "MFA av" 0 "auth_mfa"
ok_api
sqla "create role app_inn login password 'x'; create role su_inn login superuser password 'x'"
UTVIDET=true forvent "rolle med innlogging flagges" 0 "rolle_innlogging: app_inn"
UTVIDET=true forvent "superbruker flagges" 0 "rolle_superbruker: su_inn"
ut="$(KONF="insert into tests_rolle_unntak values ('app_inn') on conflict do nothing; -- backup, godkjent i test" UTVIDET=true kjor)"
grep -q "rolle_innlogging: app_inn" <<<"$ut" && feil "unntatt rolle ble likevel flagget"
grep -q "rolle_superbruker: su_inn" <<<"$ut" || feil "superbruker forsvant med rolle-unntaket for en annen rolle"
echo "  ok: rolle-unntak gjenbrukes"; ok=$((ok+1))
sqla "drop role app_inn; drop role su_inn"
sql "insert into storage.buckets values ('logoer', true), ('privat', false)"
UTVIDET=true forvent "offentlig bucket flagges" 0 "bucket_offentlig: logoer"
ut="$(UTVIDET=true kjor)"; grep -q "bucket_offentlig: privat" <<<"$ut" && feil "privat bucket ble flagget"
ut="$(KONF="insert into tests_bucket_unntak values ('logoer') on conflict do nothing; -- offentlige logoer, ingen persondata" UTVIDET=true kjor)"
grep -q "bucket_offentlig: logoer" <<<"$ut" && feil "unntatt bucket ble likevel flagget"
echo "  ok: bucket-unntak gjenbrukes"; ok=$((ok+1))
sql "delete from storage.buckets"
sql "create table public.integrasjon (id int, access_token text, refresh_token text, passord_hash text, api_key text); alter table public.integrasjon enable row level security"
sql "insert into public.integrasjon values (1, 'ya29.KLARTEKST-TOKEN-VERDI', 'enc:v2:k1:abc.def.ghi', '\$2b\$10\$abcdefghijklmnopqrstuv', null)"
UTVIDET=true forvent "token i klartekst flagges" 0 "token_klartekst: integrasjon.access_token"
ut="$(UTVIDET=true kjor)"
grep -q "KLARTEKST-TOKEN-VERDI" <<<"$ut" && feil "tokenverdi lekket til utskriften"
grep -q "KLARTEKST-TOKEN-VERDI" "$TMP/sammendrag.md" && feil "tokenverdi lekket til sammendraget"
grep -q "token_klartekst: integrasjon.refresh_token" <<<"$ut" && feil "kryptert token ble flagget"
grep -q "integrasjon.api_key" <<<"$ut" && feil "tom kolonne ble flagget"
echo "  ok: kryptert/hash/tom flagges ikke, og ingen tokenverdi i utskrift"; ok=$((ok+1))
ut="$(KONF="insert into tests_tokenkolonne_unntak values ('integrasjon.access_token') on conflict do nothing; -- testunntak" UTVIDET=true kjor)"
grep -q "token_klartekst: integrasjon.access_token" <<<"$ut" && feil "unntatt tokenkolonne ble flagget"
echo "  ok: tokenkolonne-unntak gjenbrukes"; ok=$((ok+1))
rm -f "$TMP/api/ssl.json"
UTVIDET=true forvent "API-feil gir sjekk_feilet, ikke krasj" 0 "sjekk_feilet: ssl"
echo "LIVE-DRIFT-SELVTEST OK ($ok kontroller)"
