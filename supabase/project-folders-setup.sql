-- Spustiť ručne v Supabase SQL Editore, PRED testovaním v appke.
-- Cache odkazu na priečinok 20_KOORDINACIA (Drive) pre projekt, aby sa
-- nemuselo pri každom batch-vytváraní dopytov znova hľadať cez Apps Script.
create table if not exists project_folders (
  cislo text primary key,
  koordinacia_url text,
  updated_at timestamptz default now()
);
alter table project_folders enable row level security;
create policy "open access" on project_folders for all using (true) with check (true);
