-- Spustiť ručne v Supabase SQL Editore, PRED testovaním v appke
-- (inak sa priradenie uloží len lokálne a pri ďalšom syncData() zmizne).
-- Priradenie oficiálneho mailového vlákna (Gmail link) k externej Caflou úlohe.
create table if not exists task_email_threads (
  task_id bigint primary key,
  thread_url text not null,
  updated_at timestamptz default now()
);
alter table task_email_threads enable row level security;
create policy "open access" on task_email_threads for all using (true) with check (true);
