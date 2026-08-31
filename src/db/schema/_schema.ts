import { customType, pgSchema } from 'drizzle-orm/pg-core';

/**
 * The shared identity schema. Naming is locked by contract (Section 5.1):
 * `core` for shared identity, one schema per app, no exceptions without
 * written sign-off.
 */
export const core = pgSchema('core');

/** Case-insensitive text. Used for email and slugs so that
 *  `Alice@BeOrchid.com` and `alice@beorchid.com` cannot become two accounts. */
export const citext = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'citext';
  },
});
