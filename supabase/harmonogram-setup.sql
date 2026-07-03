-- Harmonogram: kapacitné plánovanie interného tímu (fázy projektov -> projektant -> navrhovaný štart)
-- Spustiť raz v Supabase SQL Editor.

create table if not exists harmonogram (
  id uuid primary key default gen_random_uuid(),
  cislo text not null,                          -- Caflou order_number projektu
  faza_kod text not null,                       -- rovnaký kód ako ponuky.html requests.phases: SZ | DSP/PS | RP | UP | Studia | Inziniering
  projektant text not null,                     -- meno člena interného tímu (rovnaké mená ako CAFLOU_USERS)
  poradie integer not null default 1,           -- poradie fázy v rámci projektu (1,2,3...) - len na zobrazenie/triedenie, algoritmus ho na plánovanie nepoužíva
  trvanie_tyzdne numeric not null,              -- odhad dĺžky fázy v týždňoch (zadáva Jozef/šéf ručne)
  alokacia_percent integer not null default 100 check (alokacia_percent > 0 and alokacia_percent <= 100),
  start_datum date,                             -- null = zatiaľ nenaplánované, algoritmus navrhne
  najskor_od date,                              -- manuálny spodný limit štartu (napr. očakávaný dátum vybavenia povolenia/schválenia klientom) - jediný zdroj "čaká sa na niečo", žiadna fáza sa nereťazí automaticky od konca predchádzajúcej
  prioritny boolean not null default false,     -- záväzný termín s klientom
  termin_klient date,                           -- pevný termín, relevantné len ak prioritny = true
  poznamka text,
  created_at timestamptz not null default now()
);

create index if not exists harmonogram_cislo_idx on harmonogram(cislo);
create index if not exists harmonogram_projektant_idx on harmonogram(projektant);

alter table harmonogram enable row level security;
create policy "harmonogram open access" on harmonogram for all using (true) with check (true);
