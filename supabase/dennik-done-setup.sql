-- Spustiť ručne v Supabase SQL Editore.
-- Pridáva príznak "vybavené/vyriešené" pre záznamy denníka (odškrtávanie poznámok
-- v detaile projektu aj v Zápiskoch).
alter table dennik add column if not exists done boolean default false;
