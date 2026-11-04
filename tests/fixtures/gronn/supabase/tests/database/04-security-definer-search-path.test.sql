-- GENERERT – ikke rediger. Kilde: framtid-security@8b8ee077190a (04-security-definer-search-path.test.sql, sha256: bc685c8abb051444da5f379b96461b3caf30c2372c16a28484a7a14be80e98c8)
-- Endringer gjøres i Framtidmedia-no/framtid-security (sql/tests) og synkes med scripts/sync-sql.mjs.
-- ---- framtid-security:start ----
-- Universell sikkerhetstest: alle SECURITY DEFINER-funksjoner i public har fast search_path.
-- Uten det kan en bruker som kan lage objekter i et skjema tidligere i søkestien kapre kallet.
-- Rett det med: alter function public.navn(args) set search_path = '';
\ir _config.sqlinc
begin;
select plan(1);

select is_empty(
  $$
    select p.oid::regprocedure::text
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prokind in ('f', 'p')
      and p.prosecdef
      and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
      and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) as c where c like 'search_path=%')
  $$,
  'alle SECURITY DEFINER-funksjoner har fast search_path'
);

select * from finish();
rollback;
