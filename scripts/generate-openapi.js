#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Writes the OpenAPI document to doc/apidoc.json.
 *
 * Boots the Nest application context WITHOUT listening on a port, so the spec
 * can be regenerated in CI or on a machine with no database reachable — the
 * document is built from decorator metadata, not from live routes.
 *
 * Usage: npm run build && node scripts/generate-openapi.js
 */
const fs = require('fs');
const path = require('path');

// Swagger's DocumentBuilder does not touch the database, but module providers
// are still instantiated; point at .env so the pg Pool constructs cleanly.
(function loadEnv() {
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
})();

const DIST = path.join(__dirname, '..', 'dist');
if (!fs.existsSync(DIST)) {
  console.error('dist/ not found — run `npm run build` first.');
  process.exit(1);
}

const { NestFactory } = require('@nestjs/core');
const { SwaggerModule } = require('@nestjs/swagger');
const { AppModule } = require(path.join(DIST, 'app.module'));
const { buildSwaggerConfig } = require(path.join(DIST, 'swagger-config'));

const OUT = path.join(__dirname, '..', 'doc', 'apidoc.json');

(async () => {
  // logger:false keeps the 100+ route-mapping lines out of the output.
  const app = await NestFactory.create(AppModule, { logger: false });
  const prefix = `${process.env.API_PREFIX ?? 'api'}/${process.env.API_VERSION ?? 'v1'}`;
  app.setGlobalPrefix(prefix, { exclude: ['health'] });

  const doc = SwaggerModule.createDocument(app, buildSwaggerConfig());

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `${JSON.stringify(doc, null, 2)}\n`);

  console.log(`Wrote ${path.relative(process.cwd(), OUT)}`);
  console.log(`  paths   : ${Object.keys(doc.paths ?? {}).length}`);
  console.log(`  schemas : ${Object.keys(doc.components?.schemas ?? {}).length}`);

  await app.close();
  // The pg pool and Redis client hold the loop open even after close().
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
