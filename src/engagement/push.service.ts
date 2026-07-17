import { Inject, Injectable, Logger } from '@nestjs/common';
import { App, cert, getApps, initializeApp } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
import { Pool } from 'pg';
import { PG_POOL } from '../database/database.module';

/**
 * FCM push delivery. Disabled (no-op with a startup warning) until the
 * FIREBASE_SERVICE_ACCOUNT env var holds the service-account JSON from
 * Firebase Console → Project settings → Service accounts → Generate new
 * private key. Device tokens come from user_devices (POST /me/devices);
 * tokens FCM reports as dead are pruned on send.
 */
@Injectable()
export class PushService {
  private readonly logger = new Logger(PushService.name);
  private app: App | null = null;

  constructor(@Inject(PG_POOL) private readonly pool: Pool) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!raw) {
      this.logger.warn('FIREBASE_SERVICE_ACCOUNT not set — push notifications disabled');
      return;
    }
    try {
      this.app = getApps()[0] ?? initializeApp({ credential: cert(JSON.parse(raw)) });
      this.logger.log('Firebase Admin initialised — push notifications enabled');
    } catch (err) {
      this.logger.error(`Firebase Admin init failed: ${(err as Error).message} — push disabled`);
    }
  }

  get enabled(): boolean {
    return this.app !== null;
  }

  /**
   * Push to every registered device of the given users. `data` values must be
   * strings (FCM requirement). Best-effort: failures are logged, never thrown.
   */
  async sendToUsers(userIds: string[], payload: { title: string; body: string; data?: Record<string, string> }) {
    if (!this.app || userIds.length === 0) return;
    const devices = (
      await this.pool.query(
        `SELECT id, push_token FROM user_devices WHERE user_id = ANY($1::uuid[])`,
        [userIds],
      )
    ).rows;
    if (devices.length === 0) return;

    try {
      const res = await getMessaging(this.app).sendEachForMulticast({
        tokens: devices.map((d) => d.push_token),
        notification: { title: payload.title, body: payload.body },
        data: payload.data ?? {},
        webpush: {
          fcmOptions: payload.data?.match_id
            ? { link: `${(process.env.FRONTEND_URL ?? '').replace(/\/$/, '')}/matches/${payload.data.match_id}` }
            : undefined,
        },
      });

      // Prune tokens FCM says are gone (uninstalled / expired registrations)
      const dead = devices
        .filter((_, i) => {
          const code = (res.responses[i].error as any)?.code;
          return code === 'messaging/registration-token-not-registered'
            || code === 'messaging/invalid-registration-token';
        })
        .map((d) => d.id);
      if (dead.length) {
        await this.pool.query(`DELETE FROM user_devices WHERE id = ANY($1::uuid[])`, [dead]);
        this.logger.log(`Pruned ${dead.length} dead push token(s)`);
      }
      this.logger.log(`Push "${payload.title}": ${res.successCount} sent, ${res.failureCount} failed`);
    } catch (err) {
      this.logger.error(`Push send failed: ${(err as Error).message}`);
    }
  }

  /** Push the final result to everyone following the match, either team, or its tournament. */
  async sendMatchResult(matchId: string) {
    if (!this.app) return;
    const match = (
      await this.pool.query(
        `SELECT m.id, m.tournament_id, m.result_summary, ta.name AS team_a, tb.name AS team_b
         FROM matches m JOIN teams ta ON ta.id = m.team_a_id JOIN teams tb ON tb.id = m.team_b_id
         WHERE m.id = $1`,
        [matchId],
      )
    ).rows[0];
    if (!match) return;

    const followers = (
      await this.pool.query(
        `SELECT DISTINCT uf.user_id FROM user_follows uf
         JOIN matches m ON m.id = $1
         WHERE (uf.entity_type = 'match' AND uf.entity_id = m.id)
            OR (uf.entity_type = 'team' AND uf.entity_id IN (m.team_a_id, m.team_b_id))
            OR (uf.entity_type = 'tournament' AND m.tournament_id IS NOT NULL AND uf.entity_id = m.tournament_id)`,
        [matchId],
      )
    ).rows.map((r) => r.user_id);

    await this.sendToUsers(followers, {
      title: `${match.team_a} vs ${match.team_b} — result`,
      body: match.result_summary ?? 'Match completed',
      data: { match_id: match.id, event_type: 'match.result' },
    });
  }
}
