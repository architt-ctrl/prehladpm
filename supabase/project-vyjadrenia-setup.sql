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
  kontakt_email text,
  datum_dokumentu date,
  termin_reakcie date,
  stav text,
  pripomienky jsonb default '[]'::jsonb,
  zhrnutie text,
  pripnute boolean not null default false,
  created_at timestamptz not null default now()
);

-- Idempotentné pridanie stĺpcov aj keď tabuľka už existuje zo staršej verzie tohto súboru
-- (cislo_vyjadrenia/kontakt pribudli 2026-09-30, deň po prvom nasadení; stav/pripomienky o pár
-- hodín neskôr v ten istý deň; kontakt_email ešte o čosi neskôr, na Jozefovu žiadosť kvôli
-- klientskemu zdieľaniu). Pozor: `pripomienky` drží pole OBJEKTOV `{text, done, typ}`
-- (`typ`: 'projekt'|'realizacia'|null, pridané 2026-10-01 - pozri nižšie), nie pole holých
-- reťazcov ako pri prvom nasadení - staré záznamy (pred príslušnými zmenami) majú starší formát,
-- kým sa nespracujú znova cez "🗑 Reset" + "Skontrolovať teraz".
alter table project_vyjadrenia add column if not exists cislo_vyjadrenia text;
alter table project_vyjadrenia add column if not exists kontakt text;
alter table project_vyjadrenia add column if not exists kontakt_email text;
alter table project_vyjadrenia add column if not exists stav text;
alter table project_vyjadrenia add column if not exists pripomienky jsonb default '[]'::jsonb;
-- pripnute (2026-10-01): ručné pripnutie vyjadrenia na vrch zoznamu (📌) - nezávislé od
-- automatického zoraďovania podľa pripomienky[].typ='projekt' (pozri index.html sortVyjadrenia).
alter table project_vyjadrenia add column if not exists pripnute boolean not null default false;

alter table project_vyjadrenia enable row level security;

drop policy if exists "public read/write" on project_vyjadrenia;
create policy "public read/write" on project_vyjadrenia
  for all using (true) with check (true);
