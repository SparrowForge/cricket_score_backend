import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { parseCorsOrigins } from './common/cors-origins';
import { buildSwaggerConfig } from './swagger-config';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  const prefix = `${process.env.API_PREFIX ?? 'api'}/${process.env.API_VERSION ?? 'v1'}`;
  app.setGlobalPrefix(prefix, { exclude: ['health'] });

  app.use(helmet({ contentSecurityPolicy: false })); // CSP off so Swagger UI assets load

  SwaggerModule.setup('api/docs', app, SwaggerModule.createDocument(app, buildSwaggerConfig()), {
    swaggerOptions: { persistAuthorization: true, docExpansion: 'none' },
  });
  app.enableCors({
    origin: parseCorsOrigins(process.env.CORS_ORIGINS),
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
