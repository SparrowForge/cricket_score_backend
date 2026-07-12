import { Global, Module, OnApplicationShutdown } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import Redis from 'ioredis';

export const REDIS = 'REDIS';          // commands + publish
export const REDIS_SUB = 'REDIS_SUB';  // dedicated subscriber connection (required by Redis protocol)

function createClient(): Redis {
  return new Redis(process.env.REDIS_URL!, {
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    // Upstash requires TLS (rediss://); ioredis picks that up from the URL scheme.
    retryStrategy: (times) => Math.min(times * 200, 5000),
  });
}

@Global()
@Module({
  providers: [
    { provide: REDIS, useFactory: createClient },
    { provide: REDIS_SUB, useFactory: createClient },
  ],
  exports: [REDIS, REDIS_SUB],
})
export class RedisModule implements OnApplicationShutdown {
  constructor(private readonly moduleRef: ModuleRef) {}

  async onApplicationShutdown() {
    for (const token of [REDIS, REDIS_SUB]) {
      const client = this.moduleRef.get<Redis>(token, { strict: false });
      await client?.quit().catch(() => {});
    }
  }
}
