-- Baseline sikkerhet for Supabase-prosjekter (kilde: framtid-security/sql/baseline.sql).
-- Kopieres inn som migrasjon (supabase/migrations/<tidsstempel>_baseline_sikkerhet.sql).
--
-- Hva den gjør: fjerner standardtilgangen Supabase gir `anon` (og PUBLIC) på NYE objekter i
-- public. Uten dette får hver ny tabell, funksjon og sekvens automatisk grants til anon, og
-- beskyttelsen hviler på at noen husker RLS og REVOKE hver gang.
--
-- Hva den IKKE gjør: den rører ingen eksisterende objekter. Eksisterende anon-tilgang må
-- gjennomgås per prosjekt (anon-allowlist) før noe fjernes, ellers kan innlogging og
-- offentlige sider slutte å virke.
--
-- Objekter lages av rollen `postgres` i migrasjoner, så det er den rollens standard vi endrer.
-- Standarden til `supabase_admin` kan ikke endres fra en migrasjon og gjelder bare objekter
-- Supabase selv oppretter.

-- Tabeller og sekvenser: anon får ingenting automatisk.
alter default privileges for role postgres in schema public revoke all on tables from anon;
alter default privileges for role postgres in schema public revoke all on sequences from anon;

-- Funksjoner: Postgres gir EXECUTE til PUBLIC på nye funksjoner. Uten den globale revoken
-- under arver anon retten via PUBLIC selv om anon er revoket i public-skjemaet.
alter default privileges for role postgres revoke execute on functions from public;
alter default privileges for role postgres in schema public revoke execute on functions from anon;
-- Innloggede roller beholder det PUBLIC ga dem før: ellers får `authenticated` «permission denied»
-- på hjelpefunksjoner i andre skjemaer enn public (f.eks. privat.er_medlem() brukt i RLS-policyer).
-- Bare anon mister tilgang. Målt i Supabase-imaget: uten disse to linjene var authenticated false.
alter default privileges for role postgres grant execute on functions to authenticated, service_role;

-- Regelen for revoke på en eksisterende funksjon: ALLTID mot PUBLIC, anon og authenticated,
-- og verifiser med has_function_privilege, ikke ved å lese migrasjonen:
--   revoke execute on function public.navn(args) from public, anon, authenticated;
--   select has_function_privilege('anon', 'public.navn(args)'::regprocedure, 'EXECUTE'); -- skal være false
-- Gi deretter bare det som trengs:
--   grant execute on function public.navn(args) to authenticated;
