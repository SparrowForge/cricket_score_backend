#!/usr/bin/env node

/**
 * Publishes a news article from a JSON file, optionally uploading its cover.
 *
 *   node scripts/publish-news.js article.json --cover cover.png --apply
 *
 * Without --apply it prints what it would do and writes nothing: the .env here
 * is production, so a dry run is the default and the write is the opt-in.
 *
 * Article JSON:
 * {
 *   "slug": "mvp-standings-...",         // lowercase, hyphens; UNIQUE in the table
 *   "title": "...",                       // <= 200 chars
 *   "excerpt": "...",                     // <= 500 chars, shown on the feed card
 *   "tags": ["mvp","standings"],
 *   "author_email": "najmuzzaman@sprwforge.com",
 *   "org_slug": "CLICK ERP Sport Team",   // or "org_id"
 *   "cover_alt": "...",                   // alt text for the uploaded cover
 *   "body": { "text": "flat text for mobile", "blocks": [ ... ] }
 * }
 *
 * `body.blocks` is what the web renders (frontend/src/components/news-blocks.tsx);
 * `body.text` is the flat fallback the mobile app reads. Write both — an article
 * with only blocks renders as an empty page in the app.
 *
 * Re-running with the same slug UPDATES the existing article rather than
 * failing, so a correction is a re-run of the same command.
 */

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

(function loadEnv() {
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
})();

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const coverPath = args[args.indexOf('--cover') + 1] && args.includes('--cover')
  ? args[args.indexOf('--cover') + 1]
  : null;
const articlePath = args.find((a) => !a.startsWith('--') && a !== coverPath);

if (!articlePath) {
  console.error('usage: node scripts/publish-news.js <article.json> [--cover <png>] [--apply]');
  process.exit(1);
}

const article = JSON.parse(fs.readFileSync(articlePath, 'utf8'));
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: true, max: 2 });

/** PNG header read: width/height are the media_assets columns the feed uses for layout. */
function pngSize(buf) {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return {};
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

async function uploadCover(file) {
  const { v2: cloudinary } = require('cloudinary');
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
    secure: true,
  });
  const buf = fs.readFileSync(file);
  const folder = [process.env.CLOUDINARY_FOLDER, 'news'].filter(Boolean).join('/');
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder, resource_type: 'image', unique_filename: true, overwrite: false },
      (err, res) => (err || !res ? reject(err || new Error('upload failed')) : resolve({ ...res, bytes: buf.length })),
    );
    stream.end(buf);
  });
}

(async () => {
  const author = (
    await pool.query('SELECT id, full_name FROM users WHERE email = $1', [article.author_email])
  ).rows[0];
  if (!author) throw new Error(`No user with email ${article.author_email}`);

  const org = article.org_id
    ? { id: article.org_id }
    : (await pool.query('SELECT id, name FROM organizations WHERE slug = $1', [article.org_slug])).rows[0];
  if (!org) throw new Error(`No organization matching ${article.org_slug ?? article.org_id}`);

  const existing = (await pool.query('SELECT id, status FROM news_articles WHERE slug = $1', [article.slug])).rows[0];

  console.log(`article : ${article.title}`);
  console.log(`slug    : ${article.slug}  ${existing ? `(EXISTS — will update, status ${existing.status})` : '(new)'}`);
  console.log(`author  : ${author.full_name}`);
  console.log(`blocks  : ${(article.body.blocks || []).map((b) => b.type).join(', ')}`);
  console.log(`cover   : ${coverPath ?? '(none)'}`);
  if (!APPLY) {
    console.log('\nDry run — nothing written. Re-run with --apply.');
    await pool.end();
    return;
  }

  let coverAssetId = null;
  if (coverPath) {
    const up = await uploadCover(coverPath);
    const size = pngSize(fs.readFileSync(coverPath));
    coverAssetId = (
      await pool.query(
        `INSERT INTO media_assets (uploader_id, kind, storage_key, cdn_url, mime_type, size_bytes,
                                   width, height, alt_text)
         VALUES ($1,'image',$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [author.id, up.public_id, up.secure_url, 'image/png', up.bytes,
         size.width ?? up.width, size.height ?? up.height, article.cover_alt ?? null],
      )
    ).rows[0].id;
    console.log(`uploaded: ${up.secure_url}`);
  }

  const body = JSON.stringify(article.body);
  const row = existing
    ? (
        await pool.query(
          `UPDATE news_articles
              SET title = $2, excerpt = $3, body = $4::jsonb,
                  tags = $5::text[],
                  cover_asset_id = coalesce($6, cover_asset_id)
            WHERE id = $1 RETURNING id, slug`,
          [existing.id, article.title, article.excerpt, body, article.tags, coverAssetId],
        )
      ).rows[0]
    : (
        await pool.query(
          // Casts are required on both coalesce branches and on the enum — see
          // ContentService.createNews for the same trap.
          `INSERT INTO news_articles (organization_id, author_id, title, slug, excerpt, body,
                                      cover_asset_id, tags, status)
           VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7, coalesce($8::text[],'{}'::text[]), 'draft')
           RETURNING id, slug`,
          [org.id, author.id, article.title, article.slug, article.excerpt, body, coverAssetId, article.tags],
        )
      ).rows[0];

  await pool.query(
    `UPDATE news_articles
        SET status = 'published'::page_status,
            published_at = coalesce(published_at, now())
      WHERE id = $1`,
    [row.id],
  );

  console.log(`\npublished: https://criclive-score.com/news/${row.slug}`);
  await pool.end();
})().catch((e) => { console.error(e.message); pool.end(); process.exit(1); });
