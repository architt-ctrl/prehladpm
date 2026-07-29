-- Spustiť ručne v Supabase SQL Editore, PRED testovaním funkcie v appke
-- (inak sa odpovede budú ukladať len lokálne a pri ďalšom syncData() zmiznú).
-- Umožňuje podvlákno odpovedí pod jedným zápisom denníka.
alter table dennik add column if not exists parent_id uuid references dennik(id) on delete cascade;
create index if not exists dennik_parent_id_idx on dennik(parent_id);
