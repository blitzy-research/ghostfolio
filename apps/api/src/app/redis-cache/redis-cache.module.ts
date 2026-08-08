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
            createKeyv({
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
            })
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
