import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import Redis from 'ioredis';
import { Pool } from 'pg';
import { PG_POOL } from '../database/database.module';
import { REDIS } from '../redis/redis.module';

const COMPLETED_TTL_SECONDS = 6 * 3600; // inactive-match eviction: 6h after completion
const BALL_STREAM_LENGTH = 60;          // last N ball events for instant UI load

/**
 * Redis-backed live state.
 *   match:{id}:state    JSON snapshot (score, batters, bowler, this_over, seq…)
 *   match:{id}:balls    list of recent ball events (newest first, capped)
 *   match:{id}:viewers  presence set (socket ids), 'scorer:{userId}' members for scorers
 *   channel live:match:{id}  pub/sub → WebSocket gateway fan-out
 *
 * Postgres (matches.live_state / live_state_seq) stays the durable checkpoint:
 * writes go PG-first inside the scoring transaction, then Redis post-commit.
 * Reads are Redis-first with a PG fallback that re-warms the cache.
 */
@Injectable()
export class LiveStateService {
  private readonly logger = new Logger(LiveStateService.name);

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  private stateKey(id: string) { return `match:${id}:state`; }
  private ballsKey(id: string) { return `match:${id}:balls`; }
  private viewersKey(id: string) { return `match:${id}:viewers`; }
  channel(id: string) { return `live:match:${id}`; }

  /** Redis-first read; on miss, rebuild from the Postgres checkpoint and re-warm. */
  async getState(matchId: string): Promise<any> {
    try {
      const cached = await this.redis.get(this.stateKey(matchId));
      if (cached) return { ...JSON.parse(cached), source: 'redis' };
    } catch (err) {
      this.logger.warn(`Redis read failed, serving from Postgres: ${(err as Error).message}`);
    }
    const snapshot = await this.loadFromDb(matchId);
    void this.warm(matchId, snapshot).catch(() => {});
    return { ...snapshot, source: 'db' };
  }

  /** Post-commit sync: snapshot PG row → Redis, then publish an event to the match channel. */
  async syncAndPublish(matchId: string, event: string, extra: Record<string, any> = {}): Promise<void> {
    try {
      const snapshot = await this.loadFromDb(matchId);
      await this.warm(matchId, snapshot);
      await this.redis.publish(
        this.channel(matchId),
        JSON.stringify({ event, data: { ...extra, state: snapshot } }),
      );
    } catch (err) {
      // Real-time is best-effort; Postgres already holds the truth.
      this.logger.error(`Redis sync failed for ${matchId}: ${(err as Error).message}`);
    }
  }

  /** Append a ball event to the capped per-match stream (newest first). */
  async pushBall(matchId: string, ball: Record<string, any>): Promise<void> {
    try {
      await this.redis
        .multi()
        .lpush(this.ballsKey(matchId), JSON.stringify(ball))
        .ltrim(this.ballsKey(matchId), 0, BALL_STREAM_LENGTH - 1)
        .exec();
    } catch (err) {
      this.logger.warn(`ball stream push failed: ${(err as Error).message}`);
    }
  }

  /** Last N ball events for instant UI hydration. */
  async recentBalls(matchId: string, limit = 30): Promise<any[]> {
    try {
      const raw = await this.redis.lrange(this.ballsKey(matchId), 0, Math.min(limit, BALL_STREAM_LENGTH) - 1);
      return raw.map((r) => JSON.parse(r));
    } catch {
      return [];
    }
  }

  /** Completed/abandoned matches: let Redis evict after the TTL window. */
  async expireMatch(matchId: string): Promise<void> {
    try {
      await this.redis
        .multi()
        .expire(this.stateKey(matchId), COMPLETED_TTL_SECONDS)
        .expire(this.ballsKey(matchId), COMPLETED_TTL_SECONDS)
        .expire(this.viewersKey(matchId), COMPLETED_TTL_SECONDS)
        .exec();
    } catch { /* best effort */ }
  }

  // ---------- presence ----------
  async presenceJoin(matchId: string, member: string): Promise<number> {
    await this.redis.sadd(this.viewersKey(matchId), member);
    return this.redis.scard(this.viewersKey(matchId));
  }

  async presenceLeave(matchId: string, member: string): Promise<number> {
    await this.redis.srem(this.viewersKey(matchId), member);
    return this.redis.scard(this.viewersKey(matchId));
  }

  async presence(matchId: string): Promise<{ viewers: number; scorers: number }> {
    const members = await this.redis.smembers(this.viewersKey(matchId));
    const scorers = members.filter((m) => m.startsWith('scorer:')).length;
    return { viewers: members.length, scorers };
  }

  // ---------- internals ----------
  private async loadFromDb(matchId: string): Promise<any> {
    const res = await this.pool.query(
      `SELECT status, live_state, live_state_seq, result_summary FROM matches WHERE id = $1`,
      [matchId],
    );
    if (res.rowCount === 0) throw new NotFoundException('Match not found');
    const row = res.rows[0];
    return {
      status: row.status,
      seq: Number(row.live_state_seq),
      result_summary: row.result_summary,
      ...(row.live_state ?? {}),
    };
  }

  private async warm(matchId: string, snapshot: any): Promise<void> {
    const isFinished = ['completed', 'abandoned', 'no_result', 'cancelled'].includes(snapshot.status);
    const payload = JSON.stringify(snapshot);
    if (isFinished) {
      await this.redis.set(this.stateKey(matchId), payload, 'EX', COMPLETED_TTL_SECONDS);
    } else {
      await this.redis.set(this.stateKey(matchId), payload);
    }
  }
}
