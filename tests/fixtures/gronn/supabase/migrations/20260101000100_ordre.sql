create table public.ordre (
  id bigint generated always as identity primary key,
  eier uuid not null default auth.uid(),
  kunde text
);
alter table public.ordre enable row level security;
create policy ordre_eier on public.ordre for select to authenticated using (eier = (select auth.uid()));
grant select, insert, update, delete on public.ordre to authenticated;
