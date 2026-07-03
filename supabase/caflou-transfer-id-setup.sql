-- Uloženie ID vytvoreného Caflou výdavku (transfer) ku konkrétnej ponuke.
-- Zatiaľ sa nepoužíva na mazanie/rušenie — len sa ukladá pre budúce použitie.
-- Spustiť raz v Supabase SQL Editor.

alter table quotes add column if not exists caflou_transfer_id bigint;
