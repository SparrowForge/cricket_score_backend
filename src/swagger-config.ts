import { DocumentBuilder } from '@nestjs/swagger';

/**
 * Single source of truth for the OpenAPI document.
 *
 * Used by `main.ts` to serve Swagger UI at /api/docs, and by
 * `scripts/generate-openapi.js` to write `doc/apidoc.json`. Keeping one builder
 * means the committed spec cannot drift from what the running API advertises.
 */
export const buildSwaggerConfig = () =>
  new DocumentBuilder()
    .setTitle('CricLive API')
    .setDescription(
      'Cricket live scoring platform — auth, organizations, tournaments, ball-by-ball scoring, stats, SaaS plans, CMS. ' +
        'Authorize with the access_token from POST /auth/login.',
    )
    .setVersion('1.0')
    .addBearerAuth(
      { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: 'Paste access_token from /auth/login' },
      'JWT',
    )
    .addSecurityRequirements('JWT')
    .build();
