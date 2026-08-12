-- Poznámky k Caflou úlohám (task notes) — primárne úložisko namiesto Caflou comments API.
-- Dôvod: GET /comments?commented_type=Task&commented_id=... ignoruje filter server-side
-- (rovnaký problém ako pri denníku projektov) — záznam sa po čase stratí pod bot-komentármi.
-- Caflou comments API ostáva len ako write-through backup (pozri addTaskNote v index.html).

create table if not exists task_notes (
  id uuid primary key default gen_random_uuid(),
  task_id bigint not null,
  cislo text,
  text text not null,
  created_at timestamptz not null default now()
);

create index if not exists task_notes_task_id_idx on task_notes(task_id);

alter table task_notes enable row level security;

create policy "task_notes_open" on task_notes
  for all using (true) with check (true);
