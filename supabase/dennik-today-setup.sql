-- Spustiť ručne v Supabase SQL Editore.
-- Pridáva príznak "vybaviť ešte dnes" pre záznamy denníka (samostatný
-- zoznam v Zápiskoch, nezávislý od "done").
alter table dennik add column if not exists today boolean default false;
