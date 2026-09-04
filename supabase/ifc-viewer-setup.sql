-- Spustiť ručne v Supabase SQL Editore, PRED testovaním IFC viewer tlačidla v appke.
-- Cache nájdeného IFC súboru (20_KOORDINACIA/ARCHITEKTURA/*.ifc) per projekt,
-- rovnaký princíp ako koordinacia_url v project_folders.
alter table project_folders add column if not exists ifc_file_id text;
alter table project_folders add column if not exists ifc_file_name text;
