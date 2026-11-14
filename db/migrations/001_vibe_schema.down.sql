-- Drops the vibe schema and everything in it.
-- Does not touch wordfactory.*, public.*, or any other database.
-- Refuses to run unless the migrator is passed --down (see src/migrate.mjs).

DROP SCHEMA IF EXISTS vibe CASCADE;
