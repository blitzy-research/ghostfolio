import { ConfigurationService } from '@ghostfolio/api/services/configuration/configuration.service';
import { getAssetProfileIdentifier } from '@ghostfolio/common/helper';
import { AssetProfileIdentifier, Filter } from '@ghostfolio/common/interfaces';

import { CACHE_MANAGER, Cache } from '@nestjs/cache-manager';
import { Inject, Injectable, Logger } from '@nestjs/common';
import Keyv from 'keyv';
import ms from 'ms';
import { createHash, randomUUID } from 'node:crypto';

/**
 * The stable event identifiers this service reports faults under.
 *
 * Fixed strings, because a log line is read by everyone who can read the log,
 * is captured verbatim by log shipping and outlives the incident that produced
 * it. An identifier is what makes a fault searchable and correlatable; the
 * category beside it is what makes it actionable. Neither describes the
 * deployment.
 */
const REDIS_CLIENT_ERROR_EVENT = 'GF-REDIS-CLIENT-ERROR';

const REDIS_HEALTH_CHECK_FAILED_EVENT = 'GF-REDIS-HEALTH-CHECK-FAILED';

/**
 * The internal fault vocabulary every store fault is reduced to before it is
 * reported.
 *
 * This exists because the alternative - reporting what the store client said -
 * cannot be made safe. A store client's error text routinely carries the host,
 * the port, the resolved address, the failing command and, on an authentication
 * fault, a hint about the credential; its stack additionally maps out the
 * application. None of that helps an operator decide what to do, and all of it
 * is disclosure. A closed vocabulary carries the whole of the decision - is the
 * store refusing, unreachable, rejecting the credential, read-only, out of
 * memory, still loading - and none of the detail.
 *
 * `UNCLASSIFIED` is a real answer rather than a gap: it says the store failed in
 * a way this build has no category for, which is a signal to look at the store's
 * own logs, where the detail belongs and is protected.
 */
const REDIS_FAULT_CATEGORIES = {
  authenticationRejected: 'AUTHENTICATION_REJECTED',
  authenticationRequired: 'AUTHENTICATION_REQUIRED',
  connectionRefused: 'CONNECTION_REFUSED',
  connectionReset: 'CONNECTION_RESET',
  connectionTimedOut: 'CONNECTION_TIMED_OUT',
  hostNotFound: 'HOST_NOT_FOUND',
  hostUnreachable: 'HOST_UNREACHABLE',
  loadingDataset: 'LOADING_DATASET',
  maxClientsReached: 'MAX_CLIENTS_REACHED',
  outOfMemory: 'OUT_OF_MEMORY',
  probeTimedOut: 'PROBE_TIMED_OUT',
  readOnlyReplica: 'READ_ONLY_REPLICA',
  socketClosed: 'SOCKET_CLOSED',
  unclassified: 'UNCLASSIFIED',
  valueMismatch: 'VALUE_MISMATCH'
} as const;

type RedisFaultCategory =
  (typeof REDIS_FAULT_CATEGORIES)[keyof typeof REDIS_FAULT_CATEGORIES];

/**
 * How a store fault is recognised, in the order it is tried.
 *
 * Matched against the fault's own code first and its text second, because a
 * connection fault carries an errno code while a server reply carries only a
 * leading error word - and both have to reach a category or two genuinely
 * different faults would collapse into one and the second would be reported as a
 * repeat of the first. The matched text is used to CHOOSE a category and is
 * never emitted, which is the whole point of matching rather than forwarding.
 */
const REDIS_FAULT_PATTERNS: {
  category: RedisFaultCategory;
  pattern: RegExp;
}[] = [
  {
    category: REDIS_FAULT_CATEGORIES.connectionRefused,
    pattern: /ECONNREFUSED/
  },
  { category: REDIS_FAULT_CATEGORIES.connectionReset, pattern: /ECONNRESET/ },
  {
    category: REDIS_FAULT_CATEGORIES.connectionTimedOut,
    pattern: /ETIMEDOUT|ESOCKETTIMEDOUT/
  },
  {
    category: REDIS_FAULT_CATEGORIES.hostUnreachable,
    pattern: /EHOSTUNREACH|ENETUNREACH/
  },
  {
    category: REDIS_FAULT_CATEGORIES.hostNotFound,
    pattern: /ENOTFOUND|EAI_AGAIN/
  },
  {
    category: REDIS_FAULT_CATEGORIES.socketClosed,
    pattern: /EPIPE|ECONNABORTED|socket closed|closed unexpectedly/i
  },
  {
    category: REDIS_FAULT_CATEGORIES.authenticationRequired,
    pattern: /NOAUTH/
  },
  {
    category: REDIS_FAULT_CATEGORIES.authenticationRejected,
    pattern: /WRONGPASS|invalid password|without any password/i
  },
  { category: REDIS_FAULT_CATEGORIES.readOnlyReplica, pattern: /READONLY/ },
  { category: REDIS_FAULT_CATEGORIES.outOfMemory, pattern: /\bOOM\b/ },
  { category: REDIS_FAULT_CATEGORIES.loadingDataset, pattern: /\bLOADING\b/ },
  {
    category: REDIS_FAULT_CATEGORIES.maxClientsReached,
    pattern: /max number of clients/i
  }
];

@Injectable()
export class RedisCacheService {
  /**
   * Shortest interval between two log entries for one store-client fault that
   * keeps repeating. Long enough that a multi-minute outage leaves a handful of
   * lines instead of thousands, short enough that an operator watching the log
   * can still see the fault is ongoing.
   */
  private static readonly CLIENT_ERROR_LOG_INTERVAL = ms('1 minute');

  private client: Keyv;

  /**
   * The store probe that is currently running, if any.
   *
   * Held so concurrent callers of {@link isHealthy} share one probe rather than
   * each queuing their own commands against a store that may be unreachable. Reset
   * the moment the probe settles, so this bounds concurrent work without ever
   * caching a verdict.
   */
  private inFlightHealthCheck: Promise<boolean>;

  private lastClientErrorCategory: RedisFaultCategory;
  private lastClientErrorLoggedAt = 0;
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

  /**
   * Whether the store is reachable and answers correctly.
   *
   * Single-flight, and that is a resource-consumption safeguard rather than an
   * optimisation. This is reached from the **public** health endpoint, which is
   * also polled by container orchestration, so during an outage it is called
   * repeatedly and concurrently - and while the store is unreachable its client
   * holds every command in an offline queue until it reconnects. One probe per
   * outage window instead of one per caller is what keeps that queue, and the
   * pending promises behind it, bounded no matter how often the endpoint is hit.
   *
   * Every concurrent caller is handed the same answer, which is correct as well as
   * cheap: they are all asking about the same store at the same moment and cannot
   * be told apart by the answer. The memo is released as soon as the probe settles,
   * so this never becomes a cache of a stale verdict - the next caller after it
   * settles probes again.
   */
  public async isHealthy(): Promise<boolean> {
    this.inFlightHealthCheck ??= this.probeStore().finally(() => {
      this.inFlightHealthCheck = undefined;
    });

    return this.inFlightHealthCheck;
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
   * Performs one store probe: write, read back, compare.
   *
   * Separated from {@link isHealthy} so the single-flight memo has something to
   * wrap; everything in here runs at most once per outage window.
   */
  private async probeStore() {
    const HEALTH_CHECK_TIMEOUT = ms('5 seconds');

    const testKey = `__health_check__${randomUUID().replace(/-/g, '')}`;
    const testValue = Date.now().toString();

    let healthCheckTimeout: NodeJS.Timeout;

    // Whether the probe's own write reached the store, which decides below whether
    // there is anything to clean up. Without it the cleanup was dispatched
    // unconditionally, so a probe that timed out because the store was unreachable
    // added a *second* command to the very offline queue that had just failed to
    // drain the first.
    let hasWrittenTestKey = false;

    // Set at the two points this probe diagnoses itself, so the outcome is
    // reported from what happened rather than from what the failure was called.
    // Anything else that surfaces here came out of the store and is categorised
    // through the shared vocabulary instead.
    let probeCategory: RedisFaultCategory;

    try {
      await Promise.race([
        (async () => {
          await this.set(testKey, testValue, HEALTH_CHECK_TIMEOUT);

          hasWrittenTestKey = true;

          const result = await this.get(testKey);

          if (result !== testValue) {
            probeCategory = REDIS_FAULT_CATEGORIES.valueMismatch;

            throw new Error('Redis health check failed: value mismatch');
          }
        })(),
        new Promise((_, reject) => {
          healthCheckTimeout = setTimeout(() => {
            probeCategory = REDIS_FAULT_CATEGORIES.probeTimedOut;

            reject(new Error('Redis health check failed: timeout'));
          }, HEALTH_CHECK_TIMEOUT);
        })
      ]);

      return true;
    } catch (error) {
      // The category and nothing else. The store's own message would name the
      // host and port it could not reach, and the answer an operator needs -
      // which way this probe failed - is exactly what the category carries.
      Logger.error(
        `${REDIS_HEALTH_CHECK_FAILED_EVENT} (category ${
          probeCategory ?? this.categorizeFault(error)
        })`,
        'RedisCacheService'
      );

      return false;
    } finally {
      // Released as soon as the outcome is known, so a probe that answers in
      // milliseconds does not leave a pending timer behind for the remainder of
      // the window.
      clearTimeout(healthCheckTimeout);

      // Only when the write actually landed. A probe that timed out because the
      // store was unreachable has nothing to remove, and enqueuing a removal
      // anyway would add work to the same offline queue that had just failed to
      // drain the write - turning every repeated probe during an outage into two
      // queued commands instead of none.
      if (hasWrittenTestKey) {
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
  }

  /**
   * Reduces a store fault to one of the internal categories.
   *
   * The fault's own code is preferred, because a connection fault carries a
   * stable errno there, and its text is consulted only to select a category for
   * the faults that have no code - a server reply such as `READONLY` or
   * `NOAUTH`. In neither case does the text leave this method: it is matched, and
   * what is returned is a member of a closed vocabulary declared in this file.
   *
   * A fault this build has no pattern for is `UNCLASSIFIED` rather than
   * described, so an unfamiliar failure mode is still reported, still grouped
   * separately from the ones that are recognised, and still carries nothing.
   */
  private categorizeFault(aFault: unknown): RedisFaultCategory {
    const { code, message } = (aFault ?? {}) as {
      code?: unknown;
      message?: unknown;
    };

    const candidate = [
      typeof code === 'string' ? code : '',
      typeof message === 'string' ? message : ''
    ]
      .filter(Boolean)
      .join(' ');

    if (!candidate) {
      return REDIS_FAULT_CATEGORIES.unclassified;
    }

    return (
      REDIS_FAULT_PATTERNS.find(({ pattern }) => pattern.test(candidate))
        ?.category ?? REDIS_FAULT_CATEGORIES.unclassified
    );
  }

  /**
   * Records a store-client fault without letting one persistent fault flood the
   * log, and without letting the store describe the deployment in it.
   *
   * Grouping is by internal category rather than by the client's message, and
   * that is deliberate on both counts: the message is never emitted, so it cannot
   * be what an operator reads a repeat count against, and a category is the
   * stable key a reconnect loop re-emitting slightly different text still groups
   * under. A category that has not just been seen is always reported
   * immediately, so a new failure mode is never masked by an ongoing one.
   * Repeats of the category already reported are counted instead, and released as
   * a single summary at most once per `CLIENT_ERROR_LOG_INTERVAL` - which keeps
   * the fact that the dependency is still down visible while leaving the
   * surrounding entries, such as the health check's own diagnosis, readable.
   */
  private logClientError(error: Error) {
    const category = this.categorizeFault(error);
    const now = Date.now();

    if (category !== this.lastClientErrorCategory) {
      this.lastClientErrorCategory = category;
      this.lastClientErrorLoggedAt = now;
      this.suppressedClientErrorCount = 0;

      // The event and the category, and nothing the client handed over. A raw
      // `Error` here would carry its stack and its message - and a store client's
      // message is where the host, the port and the failing command live.
      Logger.error(
        `${REDIS_CLIENT_ERROR_EVENT} (category ${category})`,
        'RedisCacheService'
      );

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

    // A count and an elapsed time are measures rather than values: together they
    // tell an operator the dependency is still down and how hard it is failing,
    // which is the reason suppression is not simply silence.
    Logger.error(
      `${REDIS_CLIENT_ERROR_EVENT} (category ${category}, repeated ${suppressedCount} times in the last ${elapsedSeconds} seconds)`,
      'RedisCacheService'
    );
  }
}
