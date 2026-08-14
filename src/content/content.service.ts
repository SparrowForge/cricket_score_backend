import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Pool } from 'pg';
import { CONTACT_INBOX } from '../common/contact-details';
import { PG_POOL } from '../database/database.module';
import { MailService } from '../mail/mail.service';

const CONTACT_SUBJECTS: Record<string, string> = {
  contact: 'Website enquiry',
  demo_request: 'Demo request',
  schedule_request: 'Schedule request',
  pricing: 'Pricing enquiry',
  support: 'Support request',
};

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

@Injectable()
export class ContentService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly mail: MailService,
  ) {}

  // ================= News =================
  async publicNews(filter: { tournament?: string; tag?: string; limit?: number }) {
    return (
      await this.pool.query(
        `SELECT n.id, n.title, n.slug, n.excerpt, n.tags, n.published_at, n.tournament_id, n.match_id,
                u.full_name AS author, ma.cdn_url AS cover_url
         FROM news_articles n
         JOIN users u ON u.id = n.author_id
         LEFT JOIN media_assets ma ON ma.id = n.cover_asset_id
         WHERE n.status = 'published'
           AND ($1::uuid IS NULL OR n.tournament_id = $1)
           AND ($2::text IS NULL OR $2 = ANY(n.tags))
         ORDER BY n.published_at DESC LIMIT $3`,
        [filter.tournament ?? null, filter.tag ?? null, Math.min(filter.limit ?? 20, 100)],
      )
    ).rows;
  }

  /** Org admin list — every status, for the news manager UI. */
  async orgNews(orgId: string) {
    return (
      await this.pool.query(
        `SELECT n.id, n.title, n.slug, n.excerpt, n.tags, n.status, n.published_at, n.created_at,
                n.tournament_id, n.match_id, u.full_name AS author, ma.cdn_url AS cover_url, n.cover_asset_id
         FROM news_articles n
         JOIN users u ON u.id = n.author_id
         LEFT JOIN media_assets ma ON ma.id = n.cover_asset_id
         WHERE n.organization_id = $1
         ORDER BY n.created_at DESC LIMIT 100`,
        [orgId],
      )
    ).rows;
  }

  async newsArticle(slug: string) {
    const res = await this.pool.query(
      `SELECT n.*, u.full_name AS author, ma.cdn_url AS cover_url
       FROM news_articles n
       JOIN users u ON u.id = n.author_id
       LEFT JOIN media_assets ma ON ma.id = n.cover_asset_id
       WHERE n.slug = $1 AND n.status = 'published'`,
      [slug],
    );
    if (res.rowCount === 0) throw new NotFoundException('Article not found');
    return res.rows[0];
  }

  async createNews(orgId: string, authorId: string, dto: any) {
    const res = await this.pool.query(
      `INSERT INTO news_articles (organization_id, tournament_id, match_id, author_id, title, slug,
                                  excerpt, body, cover_asset_id, tags, status)
       -- Both coalesce branches need the cast: untyped, Postgres resolves the
       -- expression to text and the text[] column rejects it, so every insert
       -- fails regardless of what tags holds.
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, coalesce($10::text[],'{}'::text[]), 'draft')
       ON CONFLICT (slug) DO NOTHING RETURNING *`,
      [orgId, dto.tournament_id ?? null, dto.match_id ?? null, authorId, dto.title, dto.slug,
       dto.excerpt ?? null, JSON.stringify(dto.body ?? {}), dto.cover_asset_id ?? null, dto.tags],
    );
    if (res.rowCount === 0) throw new ConflictException('Slug already used');
    return res.rows[0];
  }

  async updateNews(id: string, dto: any) {
    const res = await this.pool.query(
      `UPDATE news_articles SET title = coalesce($2,title), excerpt = coalesce($3,excerpt),
              body = coalesce($4,body), cover_asset_id = coalesce($5,cover_asset_id),
              tags = coalesce($6,tags), tournament_id = coalesce($7,tournament_id), match_id = coalesce($8,match_id)
       WHERE id = $1 RETURNING *`,
      [id, dto.title ?? null, dto.excerpt ?? null, dto.body ? JSON.stringify(dto.body) : null,
       dto.cover_asset_id ?? null, dto.tags ?? null, dto.tournament_id ?? null, dto.match_id ?? null],
    );
    if (res.rowCount === 0) throw new NotFoundException('Article not found');
    return res.rows[0];
  }

  async publishNews(id: string, publish: boolean) {
    const res = await this.pool.query(
      // $2 is both assigned to the page_status column and compared to a text
      // literal; without the cast on both uses Postgres deduces conflicting
      // types for the one parameter and the statement never runs.
      `UPDATE news_articles SET status = $2::page_status,
              published_at = CASE WHEN $2::page_status = 'published' THEN now() ELSE published_at END
       WHERE id = $1 RETURNING id, status, published_at`,
      [id, publish ? 'published' : 'unpublished'],
    );
    if (res.rowCount === 0) throw new NotFoundException('Article not found');
    return res.rows[0];
  }

  async newsOrg(id: string): Promise<string | null> {
    const r = await this.pool.query(`SELECT organization_id FROM news_articles WHERE id = $1`, [id]);
    if (r.rowCount === 0) throw new NotFoundException('Article not found');
    return r.rows[0].organization_id;
  }

  // ================= CMS =================
  async publishedPage(slug: string) {
    const res = await this.pool.query(
      `SELECT slug, title, blocks, seo, published_at FROM cms_pages WHERE slug = $1 AND status = 'published'`,
      [slug],
    );
    if (res.rowCount === 0) throw new NotFoundException('Page not found');
    return res.rows[0];
  }

  async allPages() {
    return (
      await this.pool.query(
        `SELECT id, slug, title, status, published_at, updated_at,
                (SELECT count(*)::int FROM cms_page_revisions r WHERE r.page_id = p.id) AS revisions
         FROM cms_pages p ORDER BY slug`,
      )
    ).rows;
  }

  async pageDetail(id: string) {
    const res = await this.pool.query(`SELECT * FROM cms_pages WHERE id = $1`, [id]);
    if (res.rowCount === 0) throw new NotFoundException('Page not found');
    return res.rows[0];
  }

  async createPage(dto: { slug: string; title: string; blocks?: object[]; seo?: object }) {
    const res = await this.pool.query(
      `INSERT INTO cms_pages (slug, title, blocks, seo, status)
       VALUES ($1,$2, coalesce($3,'[]'::jsonb), coalesce($4,'{}'::jsonb), 'draft')
       ON CONFLICT (slug) DO NOTHING RETURNING *`,
      [dto.slug, dto.title, dto.blocks ? JSON.stringify(dto.blocks) : null, dto.seo ? JSON.stringify(dto.seo) : null],
    );
    if (res.rowCount === 0) throw new ConflictException('Page slug already exists');
    return res.rows[0];
  }

  async updatePage(id: string, dto: { title?: string; blocks?: object[]; seo?: object }) {
    const res = await this.pool.query(
      `UPDATE cms_pages SET title = coalesce($2,title), blocks = coalesce($3,blocks), seo = coalesce($4,seo)
       WHERE id = $1 RETURNING *`,
      [id, dto.title ?? null, dto.blocks ? JSON.stringify(dto.blocks) : null, dto.seo ? JSON.stringify(dto.seo) : null],
    );
    if (res.rowCount === 0) throw new NotFoundException('Page not found');
    return res.rows[0];
  }

  /** Publish snapshots a revision (rollback = restore + republish). */
  async publishPage(id: string, userId: string, publish: boolean) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const page = (await client.query(`SELECT * FROM cms_pages WHERE id = $1 FOR UPDATE`, [id])).rows[0];
      if (!page) throw new NotFoundException('Page not found');
      if (publish) {
        const rev = (
          await client.query(
            `SELECT coalesce(max(revision_number),0) + 1 AS n FROM cms_page_revisions WHERE page_id = $1`,
            [id],
          )
        ).rows[0].n;
        await client.query(
          `INSERT INTO cms_page_revisions (page_id, revision_number, title, blocks, seo, created_by)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [id, rev, page.title, JSON.stringify(page.blocks), JSON.stringify(page.seo), userId],
        );
      }
      const updated = (
        await client.query(
          `UPDATE cms_pages SET status = $2, published_at = CASE WHEN $2 = 'published' THEN now() ELSE published_at END,
                  published_by = $3 WHERE id = $1 RETURNING id, slug, status, published_at`,
          [id, publish ? 'published' : 'unpublished', userId],
        )
      ).rows[0];
      await client.query('COMMIT');
      return updated;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async pageRevisions(id: string) {
    return (
      await this.pool.query(
        `SELECT revision_number, title, created_by, created_at FROM cms_page_revisions
         WHERE page_id = $1 ORDER BY revision_number DESC`,
        [id],
      )
    ).rows;
  }

  async restoreRevision(id: string, revision: number) {
    const res = await this.pool.query(
      `UPDATE cms_pages p SET title = r.title, blocks = r.blocks, seo = r.seo
       FROM cms_page_revisions r
       WHERE p.id = $1 AND r.page_id = $1 AND r.revision_number = $2
       RETURNING p.id, p.title`,
      [id, revision],
    );
    if (res.rowCount === 0) throw new NotFoundException('Revision not found');
    return { restored: true, revision };
  }

  // ---------- site settings / feature toggles ----------
  async siteSettings() {
    const rows = (await this.pool.query(`SELECT key, value FROM site_settings ORDER BY key`)).rows;
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }

  async setSetting(key: string, value: any, userId: string) {
    await this.pool.query(
      `INSERT INTO site_settings (key, value, updated_by, updated_at) VALUES ($1,$2,$3, now())
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_by = $3, updated_at = now()`,
      [key, JSON.stringify(value), userId],
    );
    return { key, value };
  }

  // ---------- contact ----------
  async submitContact(dto: {
    kind?: string; name: string; email: string; phone?: string;
    organization?: string; preferred_date?: string; message?: string; website?: string;
  }) {
    // Bots fill every field they can see. Answer as if it went through — telling
    // a scraper it was filtered only teaches it which field to leave alone.
    if (dto.website?.trim()) return { id: null, created_at: new Date().toISOString() };

    const res = await this.pool.query(
      `INSERT INTO contact_submissions (kind, name, email, phone, organization, preferred_date, message)
       VALUES (coalesce($1,'contact'),$2,$3,$4,$5,$6,$7) RETURNING id, created_at`,
      [dto.kind ?? null, dto.name, dto.email, dto.phone ?? null,
       dto.organization ?? null, dto.preferred_date ?? null, dto.message ?? null],
    );

    const rows: [string, string | undefined][] = [
      ['Email', dto.email],
      ['Phone', dto.phone],
      ['Club / league', dto.organization],
      ['Preferred dates', dto.preferred_date],
    ];
    // Notify the public inbox; never blocks the response, and the row above is
    // the durable record either way — a failed send loses the alert, not the
    // enquiry (it stays in Admin → Contact submissions).
    void this.mail.send(
      CONTACT_INBOX,
      `[CricLive] ${CONTACT_SUBJECTS[dto.kind ?? 'contact'] ?? 'Website enquiry'} — ${dto.name}`,
      `<h2>${esc(CONTACT_SUBJECTS[dto.kind ?? 'contact'] ?? 'Website enquiry')}</h2>
       <p><b>${esc(dto.name)}</b></p>
       <table style="border-collapse:collapse;font-size:14px">
         ${rows.filter(([, v]) => v).map(([k, v]) =>
           `<tr><td style="padding:4px 12px 4px 0;color:#666">${k}</td>
                <td style="padding:4px 0;font-weight:600">${esc(v!)}</td></tr>`).join('')}
       </table>
       <p style="white-space:pre-wrap;margin-top:16px">${esc(dto.message ?? '')}</p>`,
      [...rows.filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`), '', dto.message ?? ''].join('\n'),
      // Reply-to is the enquirer: the envelope sender has to stay the
      // authenticated FROM_EMAIL or SPF/DMARC rejects the message, so Reply
      // would otherwise go to the no-reply mailbox.
      dto.email,
    );

    // Autoresponder to the sender. Also fire-and-forget: an enquiry that
    // reached us but whose receipt bounced is a far better outcome than a 500
    // in front of someone who typed out their whole request.
    void this.mail.sendContactAck(
      dto.email,
      dto.name,
      CONTACT_SUBJECTS[dto.kind ?? 'contact'] ?? 'enquiry',
      dto.message,
    );
    return res.rows[0];
  }

  async contactSubmissions() {
    return (
      await this.pool.query(`SELECT * FROM contact_submissions ORDER BY created_at DESC LIMIT 200`)
    ).rows;
  }
}
