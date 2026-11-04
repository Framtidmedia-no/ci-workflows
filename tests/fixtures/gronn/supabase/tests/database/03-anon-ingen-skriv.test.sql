-- GENERERT – ikke rediger. Kilde: framtid-security@8b8ee077190a (03-anon-ingen-skriv.test.sql, sha256: 77fe7f0c647c4af33ef79ab8c3375373544f2c33a94468d5a48a834cb3a55bda)
-- Endringer gjøres i Framtidmedia-no/framtid-security (sql/tests) og synkes med scripts/sync-sql.mjs.
-- ---- framtid-security:start ----
-- Universell sikkerhetstest: anon har ikke skrivetilgang (INSERT, UPDATE, DELETE, TRUNCATE)
-- på tabeller i public. INSERT og UPDATE sjekkes også på kolonnenivå (grant insert (kolonne) ...). Offentlige skjemaer der anon skal kunne sende inn data (f.eks. et
-- kontaktskjema) legges i tests_anon_skriv_unntak i _config.sqlinc, med RLS-policy som begrenser.
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
      and not exists (select 1 from pg_depend d where d.objid = c.oid and d.deptype = 'e')
      and (has_any_column_privilege('anon', c.oid, 'INSERT')
        or has_any_column_privilege('anon', c.oid, 'UPDATE')
        or has_table_privilege('anon', c.oid, 'DELETE')
        or has_table_privilege('anon', c.oid, 'TRUNCATE'))
      and c.relname not in (select tabell from tests_anon_skriv_unntak)
  $$,
  'anon har ikke skrivetilgang på tabeller i public'
);

select * from finish();
rollback;
