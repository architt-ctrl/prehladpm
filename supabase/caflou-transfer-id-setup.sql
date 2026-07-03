-- Uloženie ID vytvorených Caflou výdavkov (transfers) ku konkrétnej ponuke.
-- Jedna ponuka môže mať viac fáz -> viac samostatných výdavkov, preto jsonb mapa {faza: transfer_id}.
-- Zatiaľ sa nepoužíva na nič ďalšie (napr. mazanie/rušenie) - len sa ukladá pre budúce použitie.
-- Spustiť raz v Supabase SQL Editor.

alter table quotes add column if not exists caflou_transfer_ids jsonb;

-- Pôvodný stĺpec caflou_transfer_id (bigint, jeden súčtový výdavok) sa už nepoužíva,
-- ostáva nateraz nevyužitý (žiadne dáta sa v ňom nestratia zmazaním, ale zmazanie nie je nutné).
