import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import Redis from 'ioredis';
import { Pool } from 'pg';
import { PG_POOL } from '../database/database.module';
import { ballLabelFromRow, RECENT_BALL_WINDOW } from './ball-label';
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
  /**
   * GET /matches/:id's cached payload. Defined here, not in MatchesService,
   * because this service is the one place a match row changes post-commit and
   * therefore the only place that can reliably drop the cache.
   */
  detailKey(id: string) { return `match:${id}:detail`; }
  channel(id: string) { return `live:match:${id}`; }

  /** Redis-first read; on miss, rebuild from the Postgres checkpoint and re-warm. */
  async getState(matchId: string): Promise<any> {
    try {
      const cached = await this.redis.get(this.stateKey(matchId));
      if (cached) {
        const snapshot = { ...JSON.parse(cached), source: 'redis' };
        // A snapshot cached before recent_ball_labels existed is missing it too.
        if (snapshot.innings_id && !Array.isArray(snapshot.recent_ball_labels)) {
          const rules = (await this.pool.query(
            `SELECT rules_snapshot FROM matches WHERE id = $1`, [matchId],
          )).rows[0]?.rules_snapshot ?? {};
          await this.fillRecentBallLabels(snapshot, rules);
        }
        return snapshot;
      }
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
      // Drop the match-detail cache in the same breath. A status transition —
      // scheduled → live above all — changes the match row without changing the
      // live-state seq, so a key derived from that seq stayed "valid" and the
      // API kept serving the pre-start snapshot for the whole TTL. Starting a
      // gully match and being told it is still 'scheduled' was that bug.
      await this.redis.del(this.detailKey(matchId));
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
      `SELECT status, live_state, live_state_seq, result_summary, rules_snapshot
         FROM matches WHERE id = $1`,
      [matchId],
    );
    if (res.rowCount === 0) throw new NotFoundException('Match not found');
    const row = res.rows[0];
    const snapshot = {
      status: row.status,
      seq: Number(row.live_state_seq),
      result_summary: row.result_summary,
      ...(row.live_state ?? {}),
    };
    await this.fillRecentBallLabels(snapshot, row.rules_snapshot ?? {});
    return snapshot;
  }

  /**
   * Matches scored before recent_ball_labels existed have no rolling window in
   * their stored live_state, so the scoreboard would fall back to the current
   * over alone. Derive it from the ball stream on read instead of backfilling
   * every match row; the result is cached in Redis with the rest of the
   * snapshot, so it costs one query per cold load of such a match. Scoring
   * writes the field itself, so live matches never take this path.
   */
  private async fillRecentBallLabels(snapshot: any, rules: Record<string, any>): Promise<void> {
    if (!snapshot.innings_id || Array.isArray(snapshot.recent_ball_labels)) return;
    try {
      const balls = await this.pool.query(
        `SELECT runs_batter, runs_extras, extra_type, secondary_extra_type,
                is_wicket, is_boundary_four, is_boundary_six
           FROM balls WHERE innings_id = $1 AND NOT is_superseded
          ORDER BY seq DESC LIMIT $2`,
        [snapshot.innings_id, RECENT_BALL_WINDOW],
      );
      snapshot.recent_ball_labels = balls.rows.reverse().map((b) => ballLabelFromRow(b, rules));
    } catch (err) {
      // Cosmetic — the client falls back to this_over.
      this.logger.warn(`recent_ball_labels backfill failed: ${(err as Error).message}`);
    }
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
