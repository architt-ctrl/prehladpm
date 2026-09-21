-- Spustiť ručne v Supabase SQL Editore.
-- Názov projektu uložený priamo pri riadku harmonogramu, aby ho videli aj kolegovia,
-- ktorí nemajú Caflou prístup v prehliadači (inak by v harmonograme videli len čísla projektov).
-- Editor (prihlásený Jozef s Caflou prístupom) ho po spustení tejto migrácie doplní sám pri otvorení
-- harmonogramu; pred migráciou stránka funguje ako doteraz (názov sa jednoducho neukladá).
alter table harmonogram add column if not exists nazov text;
