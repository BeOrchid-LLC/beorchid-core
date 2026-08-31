-- Extensions required by the core schema (Section 5.2).
-- Must run before any table using citext or gen_random_uuid().
--
-- Installed into the default schema so both core and app schemas can use them.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";  --> gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS "citext";    --> case-insensitive email / slug
