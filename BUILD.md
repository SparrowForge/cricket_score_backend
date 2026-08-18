# Building & deploying the backend

Live target is **cPanel shared hosting** (LiteSpeed + Phusion Passenger), not
Render or Vercel — the `render.yaml` in this repo and the "Deploy" section of
`README.md` describe an older plan and are not how the API runs today.

```sh
npm run release
```

That is the whole build. It compiles, sanity-checks, and stages an upload-ready
bundle in `release/`.

---

## Why there is a bundle at all

`dist/` is gitignored, so **the server cannot get built code from git**. The
backend is deployed by uploading compiled output, which makes it easy to upload
the wrong set of files:

| Mistake | Symptom |
|---|---|
| Forgot `app.js` | Passenger has no entry point; LiteSpeed serves its own 404 |
| Forgot `package.json` | cPanel cannot install dependencies |
| Uploaded `.env` | your local secrets overwrite the server's live ones |
| Left the old `dist/` in place | deleted source files linger as stale `.js` and still load |

`npm run release` removes all four. It refuses to include `.env`, and fails the
build if `app.js` has stopped requiring `dist/main.js`.

## What ends up in `release/`

| Path | Why |
|---|---|
| `dist/` | the compiled application |
| `app.js` | Passenger entry point — **hand-written, never generated** |
| `package.json` | so cPanel can install dependencies |
| `package-lock.json` | pins the dependency tree |
| `migrations/` | only needed if you run `db:migrate` on the server |
| `MANIFEST.txt` | what was built, from which commit, and when |

Deliberately **not** included: `.env`, `node_modules/`, `src/`.

## Deploying

1. `npm run release`
2. Upload the **contents** of `release/` into the cPanel application root.
   Delete the old `dist/` first — see the stale-file trap above.
3. Only if `package.json` changed: `npm install` in the app's Node terminal.
4. cPanel → Setup Node.js App → **Restart** (or `touch tmp/restart.txt`).
5. Verify: `curl https://api.criclive-score.com/health`

### If the web app then reports CORS or "failed to fetch"

Read `https://api.criclive-score.com/stderr.log` **first**. It is almost never
CORS: when the Node app fails to boot, LiteSpeed serves its own HTML 404 with no
CORS headers, and the browser reports that as a CORS error.

## Database migrations

Migrations are **not** applied by a deploy. Run them explicitly, and run them
*before* uploading code that depends on them:

```sh
npm run db:migrate     # idempotent, tracked in schema_migrations
```

Canonical SQL lives in `../../database/` and is mirrored into `migrations/` —
update both together.

## Checks you can run before releasing

```sh
npm run lint           # ESLint over src/
npm run test:rules     # pure rules-engine fixtures, no DB or server needed
npm run smoke          # verifies Neon / Cloudinary / SMTP credentials
```

`scripts/e2e-*.js` are full end-to-end suites. They run against a **locally
started backend on the production database**, create a throwaway `e2e-club-*`
org, and must be followed by `node scripts/cleanup-e2e.js`.
