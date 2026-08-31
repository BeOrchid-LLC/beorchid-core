-- Section 13, step 2: connecting a new app creates its schema. The migration
-- role performs that, so it needs CREATE on the database itself — a
-- database-level privilege, which 0003 could not express without hardcoding a
-- database name that differs per environment.
--
-- Added as a new migration rather than by editing 0003. Migrations are
-- forward-only; an applied migration is never edited (Section 9.3).

DO $$
BEGIN
  EXECUTE format('GRANT CREATE ON DATABASE %I TO beorchid_migrate', current_database());
END
$$;
