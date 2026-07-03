-- Krok 2 (Caflou výdavok pri schválení ponuky): sparovanie profesistu s Caflou firmou
-- Spustiť raz v Supabase SQL Editor.

alter table specialists add column if not exists caflou_company_id bigint;
