-- Spustiť ručne v Supabase SQL Editore, PRED testovaním kopírovania cesty priečinka v appke.
-- Cache presného názvu projektového priečinka na Drive (pre kopírovanie lokálnej cesty
-- do schránky - Windows Search nevie indexovať Google Drive Stream disk, viď CLAUDE.md).
alter table project_folders add column if not exists folder_name text;
