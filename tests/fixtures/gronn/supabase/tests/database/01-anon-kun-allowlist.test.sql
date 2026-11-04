-- GENERERT – ikke rediger. Kilde: framtid-security@8b8ee077190a (01-anon-kun-allowlist.test.sql, sha256: ee3eac9b8bde06bf53f40139f5313cb1682a9dadd8f41917da6292729d5b6205)
-- Endringer gjøres i Framtidmedia-no/framtid-security (sql/tests) og synkes med scripts/sync-sql.mjs.
-- ---- framtid-security:start ----
-- Universell sikkerhetstest: anon har bare EXECUTE på funksjoner i en eksplisitt allowlist.
-- Allowlisten matcher på FULL signatur, f.eks. 'public.er_epost_tilgjengelig(text)', slik at en ny overload
-- ikke arver godkjenningen. Feilmeldingen fra testen skriver signaturen i nøyaktig riktig format.
-- Allowlisten (tests_anon_funksjon_allowlist i _config.sqlinc) skal komme fra en gjennomgang av
-- kallsteder i koden, ikke fra RLS alene, og være godkjent av et menneske.
\ir _config.sqlinc
begin;
select plan(1);

select is_empty(
  $$
    select format('%s.%s(%s)', n.nspname, p.proname, coalesce((select string_agg(format_type(t, null), ', ' order by o) from unnest(string_to_array(nullif(p.proargtypes::text, ''), ' ')::oid[]) with ordinality as u(t, o)), ''))
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prokind in ('f', 'p')
      and has_function_privilege('anon', p.oid, 'EXECUTE')
      and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
      and format('%s.%s(%s)', n.nspname, p.proname, coalesce((select string_agg(format_type(t, null), ', ' order by o) from unnest(string_to_array(nullif(p.proargtypes::text, ''), ' ')::oid[]) with ordinality as u(t, o)), '')) not in (select funksjon from tests_anon_funksjon_allowlist)
  $$,
  'anon har bare EXECUTE på funksjoner i allowlisten'
);

select * from finish();
rollback;
