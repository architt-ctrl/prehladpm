-- Evidencia vyjadrení/stanovísk od úradov a správcov sietí (2026-09-30)
-- Zapisuje sem Apps Script trigger sledujVyjadrenia (appscript/Code.gs) po OCR+Gemini
-- extrakcii súborov z Drive priečinka 20_KOORDINACIA/VYJADRENIA daného projektu.

create table if not exists project_vyjadrenia (
  id uuid primary key default gen_random_uuid(),
  cislo text not null,
  file_id text not null unique,
  file_name text,
  file_url text,
  organ text,
  cislo_vyjadrenia text,
  kontakt text,
  datum_dokumentu date,
  termin_reakcie date,
  stav text,
  pripomienky jsonb default '[]'::jsonb,
  zhrnutie text,
  created_at timestamptz not null default now()
);

-- Idempotentné pridanie stĺpcov aj keď tabuľka už existuje zo staršej verzie tohto súboru
-- (cislo_vyjadrenia/kontakt pribudli 2026-09-30, deň po prvom nasadení; stav/pripomienky o pár
-- hodín neskôr v ten istý deň, na Jozefovu žiadosť kvôli klientskemu zdieľaniu).
alter table project_vyjadrenia add column if not exists cislo_vyjadrenia text;
alter table project_vyjadrenia add column if not exists kontakt text;
alter table project_vyjadrenia add column if not exists stav text;
alter table project_vyjadrenia add column if not exists pripomienky jsonb default '[]'::jsonb;

alter table project_vyjadrenia enable row level security;

drop policy if exists "public read/write" on project_vyjadrenia;
create policy "public read/write" on project_vyjadrenia
  for all using (true) with check (true);
