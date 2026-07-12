import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../database/database.module';
import { MailService } from '../mail/mail.service';

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
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, coalesce($10,'{}'), 'draft')
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
      `UPDATE news_articles SET status = $2, published_at = CASE WHEN $2 = 'published' THEN now() ELSE published_at END
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
  async submitContact(dto: { kind?: string; name: string; email: string; organization?: string; message?: string }) {
    const res = await this.pool.query(
      `INSERT INTO contact_submissions (kind, name, email, organization, message)
       VALUES (coalesce($1,'contact'),$2,$3,$4,$5) RETURNING id, created_at`,
      [dto.kind ?? null, dto.name, dto.email, dto.organization ?? null, dto.message ?? null],
    );
    // Notify the platform inbox; never blocks the response
    void this.mail.send(
      process.env.FROM_EMAIL!,
      `New ${dto.kind === 'demo_request' ? 'demo request' : 'contact message'} — ${dto.name}`,
      `<p><b>${dto.name}</b> (${dto.email}${dto.organization ? ', ' + dto.organization : ''})</p><p>${dto.message ?? ''}</p>`,
    );
    return res.rows[0];
  }

  async contactSubmissions() {
    return (
      await this.pool.query(`SELECT * FROM contact_submissions ORDER BY created_at DESC LIMIT 200`)
    ).rows;
  }
}
