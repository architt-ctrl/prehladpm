-- Evidencia vyjadrení/stanovísk od úradov a správcov sietí (2026-09-30)
-- Zapisuje sem Apps Script trigger sledujVyjadrenia (appscript/Code.gs) po OCR+Gemini
-- extrakcii súborov z Drive priečinka 20_KOORDINACIA/VYJADRENIA daného projektu.
-- Bez stĺpca "stav" - vedomé rozhodnutie (Jozef), stačí dátum/termín + odkaz na súbor.

create table if not exists project_vyjadrenia (
  id uuid primary key default gen_random_uuid(),
  cislo text not null,
  file_id text not null unique,
  file_name text,
  file_url text,
  organ text,
  datum_dokumentu date,
  termin_reakcie date,
  zhrnutie text,
  created_at timestamptz not null default now()
);

alter table project_vyjadrenia enable row level security;

create policy "public read/write" on project_vyjadrenia
  for all using (true) with check (true);
