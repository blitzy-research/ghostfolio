import { ConfigurationModule } from '@ghostfolio/api/services/configuration/configuration.module';
import { ConfigurationService } from '@ghostfolio/api/services/configuration/configuration.service';

import { createKeyv } from '@keyv/redis';
import { CacheModule } from '@nestjs/cache-manager';
import { Module } from '@nestjs/common';

import { RedisCacheService } from './redis-cache.service';

@Module({
  exports: [RedisCacheService],
  imports: [
    CacheModule.registerAsync({
      imports: [ConfigurationModule],
      inject: [ConfigurationService],
      useFactory: async (configurationService: ConfigurationService) => {
        const redisPassword = encodeURIComponent(
          configurationService.get('REDIS_PASSWORD')
        );

        return {
          stores: [
            createKeyv(
              {
                // A finite ceiling on the store client's command queue.
                //
                // While the store is unreachable the client does not fail commands,
                // it queues them until it reconnects - so without a ceiling a long
                // outage lets the queue, and the pending promises behind it, grow
                // with every request the application serves, and the process runs out
                // of memory before the store comes back. Past the ceiling a command
                // is rejected instead, which the callers already handle as a cache
                // miss.
                //
                // Bounded rather than disabled: `disableOfflineQueue` would reject
                // every command the instant a reconnect began, turning a momentary
                // blip into failed reads on paths that today simply wait a beat.
                commandsQueueMaxLength: 10_000,
                url: `redis://${redisPassword ? `:${redisPassword}` : ''}@${configurationService.get('REDIS_HOST')}:${configurationService.get('REDIS_PORT')}/${configurationService.get('REDIS_DB')}`
              },
              {
                // Every cache key is written under this namespace, and that is what
                // makes the cache safely CLEARABLE. Without a namespace the store
                // implements `clear()` as `FLUSHDB`, so flushing the cache from the
                // administration screen erased everything in the Redis database -
                // including the job queue's own bookkeeping, which shares it, whose
                // loss silently resets queue identifiers and drops queued work.
                //
                // With a namespace the same call deletes only keys carrying this
                // prefix, and the store's iterator is scoped the same way, so the
                // portfolio-snapshot sweep that lists and removes keys by prefix
                // keeps working unchanged - the prefix is added and stripped inside
                // the store, so every caller still uses its own key names.
                //
                // The namespace deliberately does not encode the deployment or the
                // release: it separates this application's cache from its neighbours
                // in the same database, and nothing else. A first run after this
                // change sees a cold cache, which is what a cache is for.
                namespace: 'gf-cache'
              }
            )
          ],
          ttl: configurationService.get('CACHE_TTL')
        };
      }
    }),
    ConfigurationModule
  ],
  providers: [RedisCacheService]
})
export class RedisCacheModule {}
