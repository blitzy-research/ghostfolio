import { ConfigurationService } from '@ghostfolio/api/services/configuration/configuration.service';
import { getAssetProfileIdentifier } from '@ghostfolio/common/helper';
import { AssetProfileIdentifier, Filter } from '@ghostfolio/common/interfaces';

import { CACHE_MANAGER, Cache } from '@nestjs/cache-manager';
import { Inject, Injectable, Logger } from '@nestjs/common';
import Keyv from 'keyv';
import ms from 'ms';
import { createHash, randomUUID } from 'node:crypto';

@Injectable()
export class RedisCacheService {
  /**
   * Shortest interval between two log entries for one store-client error that
   * keeps repeating. Long enough that a multi-minute outage leaves a handful of
   * lines instead of thousands, short enough that an operator watching the log
   * can still see the fault is ongoing.
   */
  private static readonly CLIENT_ERROR_LOG_INTERVAL = ms('1 minute');

  private client: Keyv;
  private lastClientErrorLoggedAt = 0;
  private lastClientErrorMessage: string;
  private suppressedClientErrorCount = 0;

  public constructor(
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
    private readonly configurationService: ConfigurationService
  ) {
    this.client = cache.stores[0];

    this.client.deserialize = (value) => {
      try {
        return JSON.parse(value);
      } catch {}

      return value;
    };

    // Reported through a rate limiter rather than written straight to the log.
    // The store client re-emits the identical connection error on every
    // reconnect attempt, so logging each one unconditionally turns a single
    // unreachable dependency into thousands of duplicate lines and buries the
    // entries that actually explain the incident.
    //
    // The listener parameter is annotated because the store client types it
    // loosely, and an untyped argument would be reported as an unsafe call into
    // the reporter.
    this.client.on('error', (error: Error) => {
      this.logClientError(error);
    });
  }

  public async get(key: string): Promise<string> {
    return this.cache.get(key);
  }

  public async getKeys(aPrefix?: string): Promise<string[]> {
    const keys: string[] = [];
    const prefix = aPrefix;

    try {
      for await (const [key] of this.client.iterator({})) {
        if ((prefix && key.startsWith(prefix)) || !prefix) {
          keys.push(key);
        }
      }
    } catch {}

    return keys;
  }

  public getPortfolioSnapshotKey({
    filters,
    userId
  }: {
    filters?: Filter[];
    userId: string;
  }) {
    let portfolioSnapshotKey = `portfolio-snapshot-${userId}`;

    if (filters?.length > 0) {
      const filtersHash = createHash('sha256')
        .update(JSON.stringify(filters))
        .digest('hex');

      portfolioSnapshotKey = `${portfolioSnapshotKey}-${filtersHash}`;
    }

    return portfolioSnapshotKey;
  }

  public getQuoteKey({ dataSource, symbol }: AssetProfileIdentifier) {
    return `quote-${getAssetProfileIdentifier({ dataSource, symbol })}`;
  }

  public async isHealthy() {
    const HEALTH_CHECK_TIMEOUT = ms('5 seconds');

    const testKey = `__health_check__${randomUUID().replace(/-/g, '')}`;
    const testValue = Date.now().toString();

    let healthCheckTimeout: NodeJS.Timeout;

    try {
      await Promise.race([
        (async () => {
          await this.set(testKey, testValue, HEALTH_CHECK_TIMEOUT);

          const result = await this.get(testKey);

          if (result !== testValue) {
            throw new Error('Redis health check failed: value mismatch');
          }
        })(),
        new Promise((_, reject) => {
          healthCheckTimeout = setTimeout(
            () => reject(new Error('Redis health check failed: timeout')),
            HEALTH_CHECK_TIMEOUT
          );
        })
      ]);

      return true;
    } catch (error) {
      Logger.error(error?.message, 'RedisCacheService');

      return false;
    } finally {
      // Released as soon as the outcome is known, so a probe that answers in
      // milliseconds does not leave a pending timer behind for the remainder of
      // the window.
      clearTimeout(healthCheckTimeout);

      // Detached on purpose: this method must resolve even when the store does
      // not. While the store is unreachable its client holds every command in
      // an offline queue until it reconnects, so awaiting the removal here would
      // hold `isHealthy()` open for as long as the outage lasts - the health
      // handler would then never write a response at all, and a liveness probe
      // would time out instead of receiving the 503 the outage warrants.
      // Losing the deletion costs nothing: the key was written with a TTL, so it
      // expires on its own.
      void this.remove(testKey).catch(() => {
        // Swallowed deliberately. A cleanup that cannot reach the store carries
        // no information the health result does not already convey, and the
        // client error handler above reports connection failures once per
        // window on its own.
      });
    }
  }

  public async remove(key: string) {
    return this.cache.del(key);
  }

  public async removePortfolioSnapshotsByUserId({
    userId
  }: {
    userId: string;
  }) {
    const keys = await this.getKeys(
      `${this.getPortfolioSnapshotKey({ userId })}`
    );

    return this.cache.mdel(keys);
  }

  public async reset() {
    return this.cache.clear();
  }

  public async set(key: string, value: string, ttl?: number) {
    return this.cache.set(
      key,
      value,
      ttl ?? this.configurationService.get('CACHE_TTL')
    );
  }

  /**
   * Records a store-client error without letting one persistent fault flood the
   * log.
   *
   * A message that has not just been seen is always reported immediately, so a
   * new failure mode is never masked by an ongoing one. Repeats of the message
   * already reported are counted instead, and released as a single summary at
   * most once per `CLIENT_ERROR_LOG_INTERVAL` - which keeps the fact that the
   * dependency is still down visible while leaving the surrounding entries, such
   * as the health check's own diagnosis, readable.
   */
  private logClientError(error: Error) {
    // The same defensive read `isHealthy()` uses: an emitted value without a
    // message must still group with its own repeats rather than with every other
    // messageless one, so it falls back to a fixed label instead of `undefined`.
    const message = error?.message ?? 'Unknown Redis client error';
    const now = Date.now();

    if (message !== this.lastClientErrorMessage) {
      this.lastClientErrorLoggedAt = now;
      this.lastClientErrorMessage = message;
      this.suppressedClientErrorCount = 0;

      // The error object rather than its message, so the first report of a fault
      // still carries the stack - exactly what the unconditional handler this
      // replaced used to log.
      Logger.error(error, 'RedisCacheService');

      return;
    }

    this.suppressedClientErrorCount++;

    if (
      now - this.lastClientErrorLoggedAt <
      RedisCacheService.CLIENT_ERROR_LOG_INTERVAL
    ) {
      return;
    }

    const suppressedCount = this.suppressedClientErrorCount;
    const elapsedSeconds = Math.round(
      (now - this.lastClientErrorLoggedAt) / 1000
    );

    this.lastClientErrorLoggedAt = now;
    this.suppressedClientErrorCount = 0;

    Logger.error(
      `${message} (repeated ${suppressedCount} times in the last ${elapsedSeconds} seconds)`,
      'RedisCacheService'
    );
  }
}
