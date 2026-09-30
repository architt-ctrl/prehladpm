-- Koncepčný zoznam dokumentácie (AI návrh, krok 1) — 2026-09-30
-- Jozef: pri každom stupni PD (30_FAZY/FSxA_...) appka navrhne cez AI koncepčný zoznam
-- dokumentácie (stavebné objekty / prevádzkové súbory), ktorý si projektant/architekt
-- upraví. Zoznam je per projekt + per stupeň (nie jeden spoločný za celý projekt).

create table if not exists zoznam_dokumentacie (
  id uuid primary key default gen_random_uuid(),
  cislo text not null,
  faza text not null,                -- jedna z DOKUMENTACIA_FAZY hodnôt (FS1A_ZADANIE..FS7A_ODOVZDANIE)
  kategoria text not null,           -- 'SO' | 'PS'
  kod text,                          -- napr. "SO 01", voliteľné
  nazov text not null,
  poradie int not null default 0,
  zdroj text not null default 'ai',  -- 'ai' | 'rucne' — len informatívne, nič to neblokuje
  created_at timestamptz not null default now()
);

alter table zoznam_dokumentacie enable row level security;

drop policy if exists "public read/write" on zoznam_dokumentacie;
create policy "public read/write" on zoznam_dokumentacie
  for all using (true) with check (true);
