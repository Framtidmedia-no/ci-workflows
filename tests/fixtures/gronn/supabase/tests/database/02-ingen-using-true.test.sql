-- GENERERT – ikke rediger. Kilde: framtid-security@8b8ee077190a (02-ingen-using-true.test.sql, sha256: fd0c6be24b2a4a8e7edceeda79d9417b86d8694f13831055c0604e1c4c18bd15)
-- Endringer gjøres i Framtidmedia-no/framtid-security (sql/tests) og synkes med scripts/sync-sql.mjs.
-- ---- framtid-security:start ----
-- Universell sikkerhetstest: ingen RLS-policy med using (true) / with check (true) i public,
-- unntatt policyer som bare gjelder service_role og (tabell, kommando)-par i tests_using_true_unntak
-- (typisk SELECT på offentlige oppslagstabeller; begrunnelse skrives i _config.sqlinc). Unntaket gjelder
-- bare den kommandoen: en skrivepolicy med true på samme tabell flagges fortsatt.
\ir _config.sqlinc
begin;
select plan(1);

select is_empty(
  $$
    select format('%I.%I: %I', schemaname, tablename, policyname)
    from pg_policies
    where schemaname = 'public'
      and (replace(coalesce(qual, ''), ' ', '') in ('true', '(true)')
        or replace(coalesce(with_check, ''), ' ', '') in ('true', '(true)'))
      and roles <> array['service_role']::name[]
      and not exists (select 1 from tests_using_true_unntak u where u.tabell = tablename and u.kommando = cmd)
  $$,
  'ingen policy med using (true) utenfor unntakslisten'
);

select * from finish();
rollback;
