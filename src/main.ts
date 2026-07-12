import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  const prefix = `${process.env.API_PREFIX ?? 'api'}/${process.env.API_VERSION ?? 'v1'}`;
  app.setGlobalPrefix(prefix, { exclude: ['health'] });

  app.use(helmet({ contentSecurityPolicy: false })); // CSP off so Swagger UI assets load

  const swaggerConfig = new DocumentBuilder()
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
  SwaggerModule.setup('api/docs', app, SwaggerModule.createDocument(app, swaggerConfig), {
    swaggerOptions: { persistAuthorization: true, docExpansion: 'none' },
  });
  app.enableCors({
    origin: (process.env.CORS_ORIGINS ?? '')
      .split(',')
      .map((o) => o.trim().replace(/\/$/, ''))
      .filter(Boolean),
    credentials: true,
  });

  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
  );

  const port = Number(process.env.PORT ?? 3001);
  await app.listen(port);
  console.log(`CricLive API listening on :${port} (prefix /${prefix})`);
}
bootstrap();
