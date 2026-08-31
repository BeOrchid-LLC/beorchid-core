import type { Config } from 'drizzle-kit';

export default {
  schema: './src/db/schema/index.ts',
  out: './migrations',
  dialect: 'postgresql',
  schemaFilter: ['core'],
  dbCredentials: {
    url: process.env.DATABASE_URL_MIGRATE ?? '',
  },
  verbose: true,
  strict: true,
} satisfies Config;
