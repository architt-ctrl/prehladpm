-- Poznámky k vyjadreniam (zoznam dátovaných interných záznamov, 2026-10-01).
-- Rovnaký vzor ako task_notes (poznámky k externým Caflou úlohám) — Jozef chcel poznámky
-- "štýlom ako máme pri projektoch", nie jedno prepisované pole. Jeden na celé vyjadrenie
-- (nie per pripomienka — to bolo skúšané a zrušené, pozri CLAUDE.md).

create table if not exists vyjadrenie_poznamky (
  id uuid primary key default gen_random_uuid(),
  vyjadrenie_id uuid not null references project_vyjadrenia(id) on delete cascade,
  text text not null,
  created_at timestamptz not null default now()
);

create index if not exists vyjadrenie_poznamky_vyjadrenie_id_idx on vyjadrenie_poznamky(vyjadrenie_id);

alter table vyjadrenie_poznamky enable row level security;

drop policy if exists "vyjadrenie_poznamky_open" on vyjadrenie_poznamky;
create policy "vyjadrenie_poznamky_open" on vyjadrenie_poznamky
  for all using (true) with check (true);
