import { Global, Module, OnApplicationShutdown } from '@nestjs/common';
import { Pool } from 'pg';

export const PG_POOL = 'PG_POOL';

/**
 * Global pg Pool against Neon (pooled connection string).
 * The schema is hand-written SQL, so services use parameterized queries
 * through this pool rather than an ORM.
 */
@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      useFactory: () =>
        new Pool({
          connectionString: process.env.DATABASE_URL,
          ssl: { rejectUnauthorized: false },
          max: 10,
          idleTimeoutMillis: 30_000,
          connectionTimeoutMillis: 10_000,
        }),
    },
  ],
  exports: [PG_POOL],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor() {}
  async onApplicationShutdown() {
    // pool is closed by process exit; explicit close hook wired in main if needed
  }
}
