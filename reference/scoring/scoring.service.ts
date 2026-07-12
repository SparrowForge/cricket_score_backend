import { ConflictException, ForbiddenException, Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { DataSource } from 'typeorm';
import { applyBall, BallEvent, SideEffect } from './rules-engine';
import { LiveStateRepository } from './live-state.repository';

/**
 * The scoring hot path. Budget: < 150ms server-side.
 * Single writer per match (Redis scorer lock) + optimistic seq check
 * + client_event_id idempotency = safe under retries, offline batches,
 * and duplicate taps.
 */
@Injectable()
export class ScoringService {
  constructor(
    private readonly db: DataSource,
    private readonly redis: Redis,
    private readonly liveState: LiveStateRepository,
    @InjectQueue('post-ball') private readonly postBallQueue: Queue,
  ) {}

  async scoreBall(matchId: string, userId: string, lockToken: string, dto: ScoreBallDto) {
    // 1. Single-writer guard --------------------------------------------------
    const heldToken = await this.redis.get(`match:${matchId}:scorer_lock`);
    if (heldToken !== lockToken) {
      throw new ForbiddenException({ code: 'NOT_LOCK_HOLDER', message: 'Scoring session expired or taken over' });
    }

    // 2. Idempotency ----------------------------------------------------------
    const dup = await this.db.query(
      `SELECT b.seq FROM balls b JOIN innings i ON i.id = b.innings_id
       WHERE i.match_id = $1 AND b.client_event_id = $2`,
      [matchId, dto.clientEventId],
    );
    if (dup.length > 0) {
      return { code: 'DUPLICATE', seq: dup[0].seq, state: await this.liveState.get(matchId) };
    }

    // 3. Load state + optimistic concurrency ----------------------------------
    const state = await this.liveState.get(matchId);
    if (state.seq !== dto.expectedSeq) {
      throw new ConflictException({ code: 'SEQ_CONFLICT', currentSeq: state.seq, state });
    }

    // 4. Rules validation (pure) ----------------------------------------------
    const match = await this.liveState.getMatchMeta(matchId); // cached: rules_snapshot, current innings id
    const result = applyBall(state.innings, this.toBallEvent(dto), match.rulesSnapshot);
    if (!result.ok) {
      throw new ConflictException({ code: result.code, message: result.message });
    }

    // 5. Persist atomically ---------------------------------------------------
    const ball = await this.db.transaction(async (tx) => {
      const inserted = await tx.query(
        `INSERT INTO balls (innings_id, seq, over_number, ball_in_over, striker_id, non_striker_id,
                            bowler_id, is_legal, runs_batter, runs_extras, extra_type,
                            is_boundary_four, is_boundary_six, is_free_hit, is_wicket, wicket_type,
                            dismissed_player_id, fielder_id, wagon, pitch, shot_type,
                            client_event_id, scored_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
         RETURNING id`,
        this.toBallRow(match.currentInningsId, result.next, dto, state, userId),
      );

      await tx.query(
        `UPDATE innings SET total_runs=$2, total_wickets=$3, legal_balls=$4,
                extras_wides = extras_wides + $5, extras_no_balls = extras_no_balls + $6,
                extras_byes = extras_byes + $7, extras_leg_byes = extras_leg_byes + $8
         WHERE id=$1`,
        this.toInningsCounters(match.currentInningsId, result.next, dto),
      );

      await this.upsertOverSummary(tx, match.currentInningsId, result.next, dto);
      return inserted[0];
    });

    // 6. Write-through Redis + broadcast (atomic MULTI) ------------------------
    const delta = this.buildDelta(result.next, dto, result.effects);
    await this.liveState.commitAndPublish(matchId, result.next, delta);

    // 7. Slow side-effects off the hot path ------------------------------------
    await this.postBallQueue.add('post-ball', {
      matchId, ballId: ball.id, effects: result.effects, seq: result.next.seq,
    }, { removeOnComplete: true });

    // Innings/match transitions are effects too, but state-critical ones are
    // handled synchronously so the returned state is already correct:
    await this.applyCriticalEffects(matchId, result.effects);

    return { seq: result.next.seq, state: await this.liveState.get(matchId) };
  }

  /** Offline batch sync: apply in order, report per item. */
  async scoreBatch(matchId: string, userId: string, lockToken: string, items: ScoreBallDto[]) {
    const results = [];
    for (const item of items) {
      try {
        const r = await this.scoreBall(matchId, userId, lockToken, {
          ...item,
          // batch items trust server seq: rebase expectedSeq onto current
          expectedSeq: (await this.liveState.get(matchId)).seq,
        });
        results.push({ clientEventId: item.clientEventId, status: r.code === 'DUPLICATE' ? 'duplicate' : 'applied' });
      } catch (e) {
        results.push({ clientEventId: item.clientEventId, status: 'conflict', error: e.response ?? e.message });
        break; // stop on first conflict; device rebases the rest
      }
    }
    return { results, state: await this.liveState.get(matchId) };
  }

  private async applyCriticalEffects(matchId: string, effects: SideEffect[]) {
    for (const ef of effects) {
      if (ef.kind === 'innings_complete') await this.closeInnings(matchId, ef.reason);
      if (ef.kind === 'match_complete') await this.markAwaitingFinalize(matchId, ef.result);
      if (ef.kind === 'super_over_required') await this.flagSuperOver(matchId);
    }
  }

  // toBallEvent / toBallRow / toInningsCounters / upsertOverSummary /
  // buildDelta / closeInnings / markAwaitingFinalize / flagSuperOver …
}
