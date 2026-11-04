-- GENERERT – ikke rediger. Kilde: framtid-security@8b8ee077190a (00-rls-paa-alle-tabeller.test.sql, sha256: 9526034d8dfbf23668d300f9a76aeafdaa8dc38f7e496747a3163e8f21ad7137)
-- Endringer gjøres i Framtidmedia-no/framtid-security (sql/tests) og synkes med scripts/sync-sql.mjs.
-- ---- framtid-security:start ----
-- Universell sikkerhetstest: RLS er på i alle tabeller i public.
-- Partisjoner sjekkes også: RLS på den partisjonerte tabellen dekker ikke direkte tilgang til partisjonen.
-- Unntak (med begrunnelse) legges i tests_rls_unntak i _config.sqlinc.
\ir _config.sqlinc
begin;
select plan(1);

select is_empty(
  $$
    select format('%I.%I', n.nspname, c.relname)
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind in ('r', 'p')
      and not c.relrowsecurity
      and not exists (select 1 from pg_depend d where d.objid = c.oid and d.deptype = 'e')
      and c.relname not in (select tabell from tests_rls_unntak)
  $$,
  'RLS er på i alle tabeller i public'
);

select * from finish();
rollback;
