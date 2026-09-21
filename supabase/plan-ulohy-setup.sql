-- Plánovanie práce kolegov: úlohy z Caflou s tagom "harmon" zoradené do poradia s odhadom dní.
-- Spustiť ručne v Supabase SQL Editore, PRED prvým použitím stránky planovanie.html.
--
-- Riadok = jedna Caflou úloha. Stĺpce nazov/cislo/projekt/projektant/termin sú KÓPIA z Caflou
-- (aby plán videli aj kolegovia, ktorí nemajú Caflou prístup v prehliadači) — aktualizuje ich editor
-- tlačidlom "Načítať z Caflou". Vlastné dáta plánu sú len poradie a odhad_dni (zostáva dní práce).
create table if not exists plan_ulohy (
  task_id bigint primary key,                                   -- Caflou task id
  projektant text not null,                                     -- meno člena tímu (ako CAFLOU_USERS)
  poradie integer not null default 0,                           -- poradie v rade daného projektanta (menšie = skôr)
  odhad_dni numeric not null default 1 check (odhad_dni > 0),   -- koľko pracovných dní práce ešte zostáva
  nazov text not null,
  cislo text,                                                   -- číslo projektu (order_number)
  projekt text,                                                 -- názov projektu
  termin date,                                                  -- termín úlohy z Caflou (end_time)
  updated_at timestamptz not null default now()
);

create index if not exists plan_ulohy_projektant_idx on plan_ulohy(projektant, poradie);

alter table plan_ulohy enable row level security;
drop policy if exists "plan_ulohy open access" on plan_ulohy;
create policy "plan_ulohy open access" on plan_ulohy for all using (true) with check (true);
