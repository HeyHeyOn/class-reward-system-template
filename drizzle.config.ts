import { defineConfig } from 'drizzle-kit';

const migrationDatabaseUrl = process.env.DIRECT_DATABASE_URL?.trim()
  || process.env.DATABASE_URL?.trim()
  || '';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/server/db/schema/**/*.ts',
  out: './src/server/db/migrations',
  dbCredentials: {
    url: migrationDatabaseUrl,
  },
});
