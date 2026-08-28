-- Spustiť ručne v Supabase SQL Editore, PRED testovaním v appke
-- (inak sa upsert v syncResponsibleContacts() potichu neuloží).
-- Zodpovedný interný projektant za projekt (odvodené z Caflou úlohy "Príprava ASR"),
-- aby ho vedel zobraziť aj portal.html, ktorý nemá prístup ku Caflou API.
create table if not exists project_contacts (
  cislo text primary key,
  name text,
  email text,
  updated_at timestamptz default now()
);
alter table project_contacts enable row level security;
create policy "open access" on project_contacts for all using (true) with check (true);
