-- GENERERT – ikke rediger. Kilde: framtid-security@8b8ee077190a (05-views-security-invoker.test.sql, sha256: 8e3ba0729d83382243e035700be13182e2ce695b7efb5da0a886555706599aab)
-- Endringer gjøres i Framtidmedia-no/framtid-security (sql/tests) og synkes med scripts/sync-sql.mjs.
-- ---- framtid-security:start ----
-- Universell sikkerhetstest: views i public har security_invoker = true.
-- En view kjører med eierens rettigheter og går forbi RLS på tabellene den leser, slik at anon/authenticated
-- kan se rader de ikke skulle. Rett med: alter view public.navn set (security_invoker = true);
-- Godkjente unntak (med begrunnelse) legges i tests_view_unntak i _config.sqlinc.
\ir _config.sqlinc
begin;
select plan(1);

select is_empty(
  $$
    select format('%I.%I', n.nspname, c.relname)
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind = 'v'
      and not exists (select 1 from pg_depend d where d.objid = c.oid and d.deptype = 'e')
      and not (coalesce(c.reloptions, '{}') && array['security_invoker=true', 'security_invoker=on'])
      and c.relname not in (select visning from tests_view_unntak)
  $$,
  'alle views i public har security_invoker'
);

select * from finish();
rollback;
