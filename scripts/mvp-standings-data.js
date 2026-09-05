#!/usr/bin/env node

/**
 * Builds the data half of an MVP standings article: the current top N with
 * movement and point deltas measured against the last PUBLISHED standings
 * article, plus a summary of the matches played since it went out.
 *
 *   node scripts/mvp-standings-data.js [--limit 15] [--out data.json] [--baseline <slug>]
 *
 * `--baseline` names the article to measure against. Without it the most recent
 * published standings article is used — which is wrong the moment you are
 * CORRECTING one, because by then the piece you are fixing is itself the most
 * recent, and every delta comes out as +0.00. Pass the article before it.
 *
 * Read-only. Prints ready-to-paste `podium` and `standings` blocks (the shapes
 * frontend/src/components/news-blocks.tsx renders) alongside the raw round
 * figures you need for the prose.
 *
 * The previous table is taken from the article itself, not recomputed: the
 * published number is what readers saw, so a delta against anything else would
 * disagree with the last piece.
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
const LIMIT = args.includes('--limit') ? Number(args[args.indexOf('--limit') + 1]) : 15;
const OUT = args.includes('--out') ? args[args.indexOf('--out') + 1] : null;
const BASELINE = args.includes('--baseline') ? args[args.indexOf('--baseline') + 1] : null;

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: true, max: 2 });

(async () => {
  // 1. The last published standings table — the baseline every delta is against.
  const prevArticle = (
    await pool.query(
      `SELECT slug, published_at, body FROM news_articles
        WHERE status = 'published' AND 'standings' = ANY(tags)
          AND ($1::text IS NULL OR slug = $1)
        ORDER BY published_at DESC LIMIT 1`,
      [BASELINE],
    )
  ).rows[0];
  if (BASELINE && !prevArticle) throw new Error(`No published standings article with slug ${BASELINE}`);
  const prevBlock = prevArticle && (prevArticle.body.blocks || []).find((b) => b.type === 'standings');
  const prev = new Map((prevBlock?.rows ?? []).map((r) => [r.name, r]));

  // 2. The live board. Mirrors CatalogService.playerLeaders() so the article and
  //    the /stats page can never disagree — including its appearance count,
  //    which comes from the team sheet (`match_players`) and not from
  //    `player_match_stats`: a stats row only exists for a player who batted,
  //    bowled or fielded a dismissal, so a quiet game would go uncounted.
  const current = (
    await pool.query(
      `SELECT p.id AS player_id, p.full_name, p.photo_url,
              count(*)::int AS matches_played,
              count(*) FILTER (WHERE m.player_of_match_id = mp.player_id)::int AS awards,
              round(greatest(coalesce(sum(pms.mvp_points), 0), 0), 2)::text AS mvp_points
         FROM match_players mp
         JOIN players p ON p.id = mp.player_id
         JOIN matches m ON m.id = mp.match_id
         LEFT JOIN player_match_stats pms
                ON pms.match_id = mp.match_id AND pms.player_id = mp.player_id
        WHERE p.deleted_at IS NULL AND mp.is_playing_xi
          AND m.status IN ('completed','abandoned','no_result')
        GROUP BY p.id, p.full_name, p.photo_url
       HAVING sum(pms.mvp_points) > 0
        ORDER BY sum(pms.mvp_points) DESC LIMIT $1`,
      [LIMIT],
    )
  ).rows;

  const rows = current.map((r, i) => {
    const rank = i + 1;
    const was = prev.get(r.full_name);
    const movement = !was ? 'new' : was.rank > rank ? 'up' : was.rank < rank ? 'down' : 'same';
    const places = movement === 'up' || movement === 'down' ? Math.abs(was.rank - rank) : null;
    const delta = was ? `+${(Number(r.mvp_points) - Number(was.rating)).toFixed(2)}` : null;
    return {
      rank,
      player_id: r.player_id,
      name: r.full_name,
      photo_url: r.photo_url,
      matches: r.matches_played,
      rating: Number(r.mvp_points).toFixed(2),
      movement,
      places,
      // A player who lost points shows the real sign; DeltaTag colours it.
      delta: delta && delta.startsWith('+-') ? delta.slice(1) : delta,
    };
  });

  // 3. What happened in between.
  const since = prevArticle ? prevArticle.published_at : new Date(0);
  // Appearances from the team sheet here too, so "played three of the five" in
  // the prose means the same thing as the matches column in the table.
  const round = (
    await pool.query(
      `SELECT p.full_name, count(*)::int AS matches,
              round(coalesce(sum(pms.mvp_points), 0), 2)::text AS points,
              coalesce(sum(pms.runs_scored), 0)::int AS runs,
              coalesce(sum(pms.wickets_taken), 0)::int AS wickets,
              count(*) FILTER (WHERE m.player_of_match_id = mp.player_id)::int AS awards
         FROM match_players mp
         JOIN matches m ON m.id = mp.match_id
         JOIN players p ON p.id = mp.player_id
         LEFT JOIN player_match_stats pms
                ON pms.match_id = mp.match_id AND pms.player_id = mp.player_id
        WHERE mp.is_playing_xi AND m.status = 'completed' AND m.completed_at > $1
        GROUP BY p.full_name ORDER BY sum(pms.mvp_points) DESC NULLS LAST`,
      [since],
    )
  ).rows;

  const matches = (
    await pool.query(
      `SELECT coalesce(tn.name,'(friendly)') AS tournament, m.match_number, m.result_summary,
              m.completed_at, pm.full_name AS player_of_match
         FROM matches m
         LEFT JOIN tournaments tn ON tn.id = m.tournament_id
         LEFT JOIN players pm ON pm.id = m.player_of_match_id
        WHERE m.status = 'completed' AND m.completed_at > $1
        ORDER BY m.completed_at`,
      [since],
    )
  ).rows;

  const totals = (
    await pool.query(`SELECT count(*)::int AS completed FROM matches WHERE status = 'completed'`)
  ).rows[0];

  const out = {
    previous_article: prevArticle ? { slug: prevArticle.slug, published_at: prevArticle.published_at } : null,
    completed_matches: totals.completed,
    matches_this_round: matches,
    round_gains: round,
    podium: rows.slice(0, 3),
    blocks: {
      podium: { type: 'podium', caption: `The top three after ${totals.completed} matches`, entries: rows.slice(0, 3) },
      standings: {
        type: 'standings',
        caption: `MVP standings after ${totals.completed} completed matches`,
        ratingLabel: 'MVP points',
        rows,
      },
    },
  };

  const json = JSON.stringify(out, null, 2);
  if (OUT) { fs.writeFileSync(OUT, json); console.log(`wrote ${OUT}`); } else { console.log(json); }
  await pool.end();
})().catch((e) => { console.error(e.message); pool.end(); process.exit(1); });
