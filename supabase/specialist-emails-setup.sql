-- Ďalšie e-mailové adresy (viacero pracovníkov tej istej firmy/profesistu) — pozri CLAUDE.md
-- "Automatické ukladanie príloh od profesistov" (sledujPrilohy). Hlavný `specialists.email`
-- ostáva primárny kontakt; tieto riadky sú doplnkové adresy, ktoré sa majú rozpoznať ako
-- ten istý profesista (rovnaká profesia) pri triedení príloh z mailov.

create table if not exists specialist_emails (
  id uuid primary key default gen_random_uuid(),
  specialist_id uuid not null references specialists(id) on delete cascade,
  email text not null unique,
  created_at timestamptz default now()
);

alter table specialist_emails enable row level security;

drop policy if exists "specialist_emails_all" on specialist_emails;
create policy "specialist_emails_all" on specialist_emails for all using (true) with check (true);
