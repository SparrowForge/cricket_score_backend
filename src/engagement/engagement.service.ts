import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../database/database.module';

@Injectable()
export class EngagementService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  // ---------- follows ----------
  async follows(userId: string) {
    return (
      await this.pool.query(`SELECT entity_type, entity_id, created_at FROM user_follows WHERE user_id = $1`, [userId])
    ).rows;
  }

  async follow(userId: string, entityType: string, entityId: string) {
    await this.pool.query(
      `INSERT INTO user_follows (user_id, entity_type, entity_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
      [userId, entityType, entityId],
    );
    return { following: true };
  }

  async unfollow(userId: string, entityType: string, entityId: string) {
    await this.pool.query(
      `DELETE FROM user_follows WHERE user_id = $1 AND entity_type = $2 AND entity_id = $3`,
      [userId, entityType, entityId],
    );
    return { following: false };
  }

  // ---------- devices (push tokens, FCM-ready) ----------
  async registerDevice(userId: string, dto: { platform: string; push_token: string; app_version?: string }) {
    await this.pool.query(
      `INSERT INTO user_devices (user_id, platform, push_token, app_version, last_seen_at)
       VALUES ($1,$2,$3,$4, now())
       ON CONFLICT (user_id, push_token) DO UPDATE SET last_seen_at = now(), app_version = $4`,
      [userId, dto.platform, dto.push_token, dto.app_version ?? null],
    );
    return { registered: true };
  }

  // ---------- notification preferences ----------
  async preferences(userId: string) {
    const res = await this.pool.query(`SELECT preferences, quiet_hours FROM notification_preferences WHERE user_id = $1`, [userId]);
    return res.rows[0] ?? { preferences: {}, quiet_hours: null };
  }

  async setPreferences(userId: string, preferences: object, quietHours?: object) {
    await this.pool.query(
      `INSERT INTO notification_preferences (user_id, preferences, quiet_hours, updated_at)
       VALUES ($1,$2,$3, now())
       ON CONFLICT (user_id) DO UPDATE SET preferences = $2, quiet_hours = coalesce($3, notification_preferences.quiet_hours), updated_at = now()`,
      [userId, JSON.stringify(preferences), quietHours ? JSON.stringify(quietHours) : null],
    );
    return this.preferences(userId);
  }

  // ---------- in-app inbox ----------
  async inbox(userId: string, unreadOnly: boolean) {
    return (
      await this.pool.query(
        `SELECT id, event_type, title, body, data, read_at, created_at
         FROM notifications WHERE user_id = $1 AND channel = 'in_app'
           AND (NOT $2 OR read_at IS NULL)
         ORDER BY created_at DESC LIMIT 100`,
        [userId, unreadOnly],
      )
    ).rows;
  }

  async markRead(userId: string, id: string) {
    await this.pool.query(`UPDATE notifications SET read_at = now() WHERE id = $1 AND user_id = $2`, [id, userId]);
    return { read: true };
  }

  async markAllRead(userId: string) {
    const res = await this.pool.query(
      `UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL`,
      [userId],
    );
    return { read: res.rowCount };
  }
}
