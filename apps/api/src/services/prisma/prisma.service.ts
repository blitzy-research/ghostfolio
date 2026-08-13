import {
  DEFAULT_DATABASE_CONNECTION_TIMEOUT,
  DEFAULT_DATABASE_QUERY_TIMEOUT
} from '@ghostfolio/common/config';

import {
  Injectable,
  Logger,
  LogLevel,
  OnModuleDestroy,
  OnModuleInit
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '@prisma/client';

/**
 * Reads a millisecond duration from the environment, falling back to the given
 * default when it is absent or unusable.
 *
 * Unusable rather than merely absent is the case worth stating: a value that
 * cannot be read as a number - an empty string, a typo, a unit suffix - falls
 * back to the default instead of reaching `pg` as `NaN`, which every one of the
 * settings below treats as falsy and therefore as "no limit". Silently removing
 * the ceiling is the one outcome a misconfiguration must not produce here, since
 * it is indistinguishable from the unbounded behaviour these settings exist to
 * end. A deliberate `0` is preserved, because `0` is how an operator asks for no
 * limit on purpose.
 */
function getDurationInMilliseconds(
  configService: ConfigService,
  key: string,
  defaultValue: number
): number {
  const value = parseInt(configService.get<string>(key), 10);

  return Number.isFinite(value) && value >= 0 ? value : defaultValue;
}

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  public constructor(configService: ConfigService) {
    const connectionTimeout = getDurationInMilliseconds(
      configService,
      'DATABASE_CONNECTION_TIMEOUT',
      DEFAULT_DATABASE_CONNECTION_TIMEOUT
    );

    const queryTimeout = getDurationInMilliseconds(
      configService,
      'DATABASE_QUERY_TIMEOUT',
      DEFAULT_DATABASE_QUERY_TIMEOUT
    );

    // Every one of these settings is off by default in `pg`, and the effect of
    // leaving them off is not a slow request but one that never finishes: an
    // unresponsive database - as opposed to an unreachable one, which fails
    // immediately - leaves each request waiting on a socket or on a pooled
    // connection with no ceiling at all. Bounding them turns that into a failure
    // the caller can see, report and retry.
    //
    // These are DEFAULTS rather than final values, and deliberately so. `pg`
    // merges the parsed connection string over the configuration object, so any
    // of them can still be overridden per deployment as a `DATABASE_URL` query
    // parameter without touching this file.
    const adapter = new PrismaPg(
      {
        connectionString: configService.get<string>('DATABASE_URL'),
        connectionTimeoutMillis: connectionTimeout,
        idle_in_transaction_session_timeout: queryTimeout,
        query_timeout: queryTimeout,
        statement_timeout: queryTimeout
      },
      {
        // Reported rather than swallowed. Both events fire outside any request,
        // so nothing else in the application is in a position to surface them,
        // and the driver's own handling of them is a `debug` line that a
        // production logger does not emit. Only the message is logged: the
        // configuration these errors carry includes the connection string, and
        // therefore the database credentials.
        onConnectionError: (error: Error) => {
          Logger.warn(
            `Database connection error: ${error.message}`,
            'PrismaService'
          );
        },
        onPoolError: (error: Error) => {
          Logger.warn(`Database pool error: ${error.message}`, 'PrismaService');
        }
      }
    );

    let customLogLevels: LogLevel[];

    try {
      customLogLevels = JSON.parse(
        configService.get<string>('LOG_LEVELS')
      ) as LogLevel[];
    } catch {}

    const log: Prisma.LogDefinition[] =
      customLogLevels?.includes('debug') || customLogLevels?.includes('verbose')
        ? [{ emit: 'stdout', level: 'query' }]
        : [];

    super({
      adapter,
      log,
      errorFormat: 'colorless'
    });
  }

  public async onModuleInit() {
    try {
      await this.$connect();
    } catch (error) {
      Logger.error(error, 'PrismaService');
    }
  }

  public async onModuleDestroy() {
    await this.$disconnect();
  }
}
