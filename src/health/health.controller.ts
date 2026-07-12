import { Controller, Get, Inject } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../database/database.module';

@Controller('health')
export class HealthController {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  @Get()
  async health() {
    const started = Date.now();
    let db = 'down';
    try {
      await this.pool.query('SELECT 1');
      db = 'up';
    } catch {
      /* reported below */
    }
    return {
      status: db === 'up' ? 'ok' : 'degraded',
      db,
      db_latency_ms: Date.now() - started,
      uptime_s: Math.round(process.uptime()),
    };
  }
}
