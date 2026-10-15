import { defineConfig } from 'drizzle-kit';

/**
 * Drizzle Kit configuration.
 *
 *   npm run db:generate   # write SQL migrations into ./drizzle
 *   npm run db:migrate    # apply pending migrations
 *   npm run db:push       # (dev only) push schema directly, no migration files
 *   npm run db:studio     # browse the database in Drizzle Studio
 */
export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  strict: true,
  verbose: true,
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgresql://platematch:platematch@localhost:5432/platematch',
  },
  migrations: {
    table: '__drizzle_migrations',
  },
});
