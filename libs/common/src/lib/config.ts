import { AssetClass, AssetSubClass, DataSource, Type } from '@prisma/client';
// `import type`, and not merely as a style: both names are used only in type
// positions, and a value import of them puts the queue library - which exists
// only for the server - into the browser bundle of every client that reaches this
// module. The type-only form is erased at compile time instead.
import type { JobOptions, JobStatus } from 'bull';
import ms from 'ms';

export const ghostfolioPrefix = 'GF';
export const ghostfolioScraperApiSymbolPrefix = `_${ghostfolioPrefix}_`;
export const ghostfolioFearAndGreedIndexDataSourceCryptocurrencies =
  DataSource.MANUAL;
export const ghostfolioFearAndGreedIndexDataSourceStocks = DataSource.RAPID_API;
export const ghostfolioFearAndGreedIndexSymbol = `${ghostfolioScraperApiSymbolPrefix}FEAR_AND_GREED_INDEX`;
export const ghostfolioFearAndGreedIndexSymbolCryptocurrencies = `${ghostfolioPrefix}_FEAR_AND_GREED_INDEX_CRYPTOCURRENCIES`;
export const ghostfolioFearAndGreedIndexSymbolStocks = `${ghostfolioPrefix}_FEAR_AND_GREED_INDEX_STOCKS`;

export const locale = 'en-US';

export const primaryColorHex = '#36cfcc';
export const primaryColorRgb = {
  r: 54,
  g: 207,
  b: 204
};

export const secondaryColorHex = '#3686cf';
export const secondaryColorRgb = {
  r: 54,
  g: 134,
  b: 207
};

export const warnColorHex = '#dc3545';
export const warnColorRgb = {
  r: 220,
  g: 53,
  b: 69
};

export const ASSET_CLASS_MAPPING = new Map<AssetClass, AssetSubClass[]>([
  [AssetClass.ALTERNATIVE_INVESTMENT, [AssetSubClass.COLLECTIBLE]],
  [AssetClass.COMMODITY, [AssetSubClass.PRECIOUS_METAL]],
  [
    AssetClass.EQUITY,
    [
      AssetSubClass.ETF,
      AssetSubClass.MUTUALFUND,
      AssetSubClass.PRIVATE_EQUITY,
      AssetSubClass.STOCK
    ]
  ],
  [AssetClass.FIXED_INCOME, [AssetSubClass.BOND, AssetSubClass.LOAN]],
  [AssetClass.LIQUIDITY, [AssetSubClass.CRYPTOCURRENCY]],
  [AssetClass.REAL_ESTATE, []]
]);

export const BULL_BOARD_COOKIE_NAME = 'bull_board_token';

/**
 * WARNING: This route is mirrored in `apps/client/proxy.conf.json`.
 * If you update this value, you must also update the proxy configuration.
 */
export const BULL_BOARD_ROUTE = '/admin/queues';

export const CACHE_TTL_NO_CACHE = 1;
export const CACHE_TTL_INFINITE = 0;

export const DATA_GATHERING_QUEUE = 'DATA_GATHERING_QUEUE';
export const DATA_GATHERING_QUEUE_PRIORITY_HIGH = 1;
export const DATA_GATHERING_QUEUE_PRIORITY_LOW = Number.MAX_SAFE_INTEGER;
export const DATA_GATHERING_QUEUE_PRIORITY_MEDIUM = Math.round(
  DATA_GATHERING_QUEUE_PRIORITY_LOW / 2
);

export const PORTFOLIO_SNAPSHOT_COMPUTATION_QUEUE =
  'PORTFOLIO_SNAPSHOT_COMPUTATION_QUEUE';
export const PORTFOLIO_SNAPSHOT_COMPUTATION_QUEUE_PRIORITY_HIGH = 1;
export const PORTFOLIO_SNAPSHOT_COMPUTATION_QUEUE_PRIORITY_LOW =
  Number.MAX_SAFE_INTEGER;

export const STATISTICS_GATHERING_QUEUE = 'STATISTICS_GATHERING_QUEUE';

export const DEFAULT_CURRENCY = 'USD';

/**
 * How long, in milliseconds, a request may spend obtaining a database
 * connection - both establishing a new one and waiting for a pooled one to come
 * free.
 *
 * A bound has to exist because the alternative is not a slow request but an
 * unbounded one. `pg` leaves both halves off by default: with no
 * `connectionTimeoutMillis` it derives a libpq `connect_timeout` of `0`, and a
 * pool waiter with no ceiling simply queues until a connection is released,
 * however long that takes. A database that has become unresponsive rather than
 * unreachable therefore converts every request behind it into one that never
 * answers - which is strictly worse than a failure, because a caller can retry a
 * failure and cannot retry a hang.
 *
 * Thirty seconds is chosen to be unmistakably outside normal operation and
 * unmistakably inside "something is wrong": it is two orders of magnitude above
 * the dashboard layout read's own stated budget and well above the slowest
 * observed request in this application, so nothing that works today starts
 * failing, while a stalled connection is now reported instead of waited on.
 * Override with `DATABASE_CONNECTION_TIMEOUT`; `0` restores the unbounded
 * behaviour for an operator who genuinely wants it.
 */
export const DEFAULT_DATABASE_CONNECTION_TIMEOUT = 30000;

/**
 * How long, in milliseconds, a single statement may run before it is abandoned.
 *
 * Applied as three separate settings because each covers a failure the others
 * cannot, and only together do they bound the whole path:
 *
 * - `statement_timeout` is enforced by PostgreSQL, so it ends a query that is
 *   genuinely slow - and it is the only one of the three that also releases the
 *   server-side resources the query held.
 * - `query_timeout` is enforced by the client, which is what makes it the half
 *   that matters when the *server* stops answering: a frozen or wedged backend
 *   cannot apply its own `statement_timeout`, so without a client-side ceiling
 *   the driver waits on a socket that will never reply.
 * - `idle_in_transaction_session_timeout` closes a transaction that was opened
 *   and then abandoned, which would otherwise hold its locks indefinitely and
 *   block unrelated writers.
 *
 * The value is deliberately the same as the connection ceiling and is chosen the
 * same way: far above every statement this application issues in normal
 * operation - the dashboard layout read is a single primary-key lookup costing
 * well under a millisecond server-side - and far below "forever". Override with
 * `DATABASE_QUERY_TIMEOUT`; `0` disables all three.
 */
export const DEFAULT_DATABASE_QUERY_TIMEOUT = 30000;

export const DEFAULT_DATE_FORMAT_MONTH_YEAR = 'MMM yyyy';
export const DEFAULT_HOST = '0.0.0.0';
export const DEFAULT_LANGUAGE_CODE = 'en';
export const DEFAULT_PAGE_SIZE = 50;
export const DEFAULT_PORT = 3333;
export const DEFAULT_PROCESSOR_GATHER_ASSET_PROFILE_CONCURRENCY = 1;
export const DEFAULT_PROCESSOR_GATHER_HISTORICAL_MARKET_DATA_CONCURRENCY = 1;
export const DEFAULT_PROCESSOR_PORTFOLIO_SNAPSHOT_COMPUTATION_CONCURRENCY = 1;
export const DEFAULT_PROCESSOR_PORTFOLIO_SNAPSHOT_COMPUTATION_TIMEOUT = 30000;

export const DEFAULT_REDACTED_PATHS = [
  'accounts[*].balance',
  'accounts[*].balanceInBaseCurrency',
  'accounts[*].comment',
  'accounts[*].dividendInBaseCurrency',
  'accounts[*].interestInBaseCurrency',
  'accounts[*].value',
  'accounts[*].valueInBaseCurrency',
  'activities[*].account.balance',
  'activities[*].account.comment',
  'activities[*].comment',
  'activities[*].fee',
  'activities[*].feeInAssetProfileCurrency',
  'activities[*].feeInBaseCurrency',
  'activities[*].quantity',
  'activities[*].SymbolProfile.symbolMapping',
  'activities[*].SymbolProfile.watchedByCount',
  'activities[*].value',
  'activities[*].valueInBaseCurrency',
  'balance',
  'balanceInBaseCurrency',
  'balances[*].account.balance',
  'balances[*].account.comment',
  'balances[*].value',
  'balances[*].valueInBaseCurrency',
  'comment',
  'dividendInBaseCurrency',
  'feeInBaseCurrency',
  'grossPerformance',
  'grossPerformanceWithCurrencyEffect',
  'historicalData[*].quantity',
  'holdings[*].dividend',
  'holdings[*].grossPerformance',
  'holdings[*].grossPerformanceWithCurrencyEffect',
  'holdings[*].holdings[*].valueInBaseCurrency',
  'holdings[*].investment',
  'holdings[*].netPerformance',
  'holdings[*].netPerformanceWithCurrencyEffect',
  'holdings[*].quantity',
  'holdings[*].valueInBaseCurrency',
  'interestInBaseCurrency',
  // Deliberately no `latestActivities[*]` entry here, and the reason is worth
  // recording because adding one looks like an improvement. This list is applied
  // by `RedactValuesInResponseInterceptor`, which redacts whenever
  // `isRestrictedView` holds - and that returns `true` when there is no viewer at
  // all. A public share request has no viewer, so an entry here would redact on
  // *every* share request and would therefore overrule the grant, stripping the
  // figures from a link whose owner deliberately granted unrestricted read. The
  // capability is the only authority a public request carries, so the share route
  // reads `Access.permissions` and decides there instead; see
  // `apps/api/src/app/endpoints/public/public.controller.ts`.
  'investmentInBaseCurrencyWithCurrencyEffect',
  'netPerformance',
  'netPerformanceWithCurrencyEffect',
  'platforms[*].balance',
  'platforms[*].valueInBaseCurrency',
  'quantity',
  'SymbolProfile.symbolMapping',
  'SymbolProfile.watchedByCount',
  'totalBalanceInBaseCurrency',
  'totalDividendInBaseCurrency',
  'totalInterestInBaseCurrency',
  'totalValueInBaseCurrency',
  'value',
  'valueInBaseCurrency'
];

// USX is handled separately
export const DERIVED_CURRENCIES = [
  {
    currency: 'GBp',
    factor: 100,
    rootCurrency: 'GBP'
  },
  {
    currency: 'ILA',
    factor: 100,
    rootCurrency: 'ILS'
  },
  {
    currency: 'ZAc',
    factor: 100,
    rootCurrency: 'ZAR'
  }
];

export const GATHER_ASSET_PROFILE_PROCESS_JOB_NAME = 'GATHER_ASSET_PROFILE';
export const GATHER_ASSET_PROFILE_PROCESS_JOB_OPTIONS: JobOptions = {
  attempts: 12,
  backoff: {
    delay: ms('1 minute'),
    type: 'exponential'
  },
  removeOnComplete: true
};

export const GATHER_HISTORICAL_MARKET_DATA_PROCESS_JOB_NAME =
  'GATHER_HISTORICAL_MARKET_DATA';
export const GATHER_HISTORICAL_MARKET_DATA_PROCESS_JOB_OPTIONS: JobOptions = {
  attempts: 12,
  backoff: {
    delay: ms('1 minute'),
    type: 'exponential'
  },
  removeOnComplete: true
};

export const GATHER_STATISTICS_PROCESS_JOB_OPTIONS: JobOptions = {
  attempts: 5,
  backoff: {
    delay: ms('1 minute'),
    type: 'exponential'
  },
  removeOnComplete: true
};

export const GATHER_STATISTICS_DOCKER_HUB_PULLS_PROCESS_JOB_NAME =
  'GATHER_STATISTICS_DOCKER_HUB_PULLS';

export const GATHER_STATISTICS_GITHUB_CONTRIBUTORS_PROCESS_JOB_NAME =
  'GATHER_STATISTICS_GITHUB_CONTRIBUTORS';

export const GATHER_STATISTICS_GITHUB_STARGAZERS_PROCESS_JOB_NAME =
  'GATHER_STATISTICS_GITHUB_STARGAZERS';

export const GATHER_STATISTICS_UPTIME_PROCESS_JOB_NAME =
  'GATHER_STATISTICS_UPTIME';

export const INVESTMENT_ACTIVITY_TYPES = [
  Type.BUY,
  Type.DIVIDEND,
  Type.SELL
] as Type[];

export const PORTFOLIO_SNAPSHOT_PROCESS_JOB_NAME = 'PORTFOLIO';
export const PORTFOLIO_SNAPSHOT_PROCESS_JOB_OPTIONS: JobOptions = {
  removeOnComplete: true,
  // A failed job has to be discarded for the same reason a completed one does,
  // and here the consequence of keeping it is more serious. These jobs are
  // enqueued under a job id derived from the user, which is what makes several
  // concurrent requests for one user share a single computation - and it also
  // means a job left behind in the failed state keeps that id occupied. Every
  // later request then deduplicates onto the settled failure and is answered
  // with it verbatim, so one transient failure - a computation the queue
  // declared stalled, say - becomes a permanent one that no amount of retrying,
  // and not even a restart, recovers from: it outlives the process, because it
  // lives in the queue's store. Discarding it leaves the id free, so the next
  // request enqueues a new computation and the failure lasts exactly as long as
  // whatever caused it.
  removeOnFail: true
};

/**
 * The most module entries one persisted dashboard layout may hold.
 *
 * 300 is the canvas capacity: a 12-column by 100-row grid holds 1200 cells and
 * the smallest legal module occupies 4 of them.
 *
 * Shared deliberately, because the ceiling has to hold on the way OUT as well as
 * on the way in and the two are enforced in different places - a request body by
 * the write DTO, a stored document by the read path. A document can reach the
 * column without passing the DTO at all: written by direct database access,
 * carried in by a migration, or left by an older build. Two independent literals
 * would let the halves drift apart, and the half that drifts silently is the
 * read one, since nothing rejects a document that is already stored.
 */
export const MAX_USER_DASHBOARD_LAYOUT_ITEMS = 300;

export const HEADER_KEY_IMPERSONATION = 'Impersonation-Id';
export const HEADER_KEY_TIMEZONE = 'Timezone';
export const HEADER_KEY_TOKEN = 'Authorization';
export const HEADER_KEY_SKIP_INTERCEPTOR = 'X-Skip-Interceptor';

/**
 * The browser storage keys that together determine which account a request is
 * made as.
 *
 * They live here, beside the request headers they end up producing, because two
 * layers now need them and they must not drift apart: the client's outgoing
 * request interceptor reads them to set `HEADER_KEY_TOKEN` and
 * `HEADER_KEY_IMPERSONATION`, and the shared data facade reads them to decide
 * whether two overlapping reads were issued as the same account and may therefore
 * share one request. Duplicating the literals would let a rename in one layer
 * silently un-partition the other - and it would fail *open*, by making every
 * caller look identical, which is precisely the direction that must not be
 * possible.
 *
 * The values are unchanged from where they were first declared, so nothing already
 * in a browser's storage is orphaned.
 */
export const KEY_STORAGE_AUTHORIZATION_TOKEN = 'auth-token';
export const KEY_STORAGE_IMPERSONATION_ID = 'impersonationId';

export const MAX_TOP_HOLDINGS = 50;

export const NUMERICAL_PRECISION_THRESHOLD_3_FIGURES = 100;
export const NUMERICAL_PRECISION_THRESHOLD_5_FIGURES = 10000;
export const NUMERICAL_PRECISION_THRESHOLD_6_FIGURES = 100000;

export const PROPERTY_API_KEY_GHOSTFOLIO = 'API_KEY_GHOSTFOLIO';
export const PROPERTY_API_KEY_OPENROUTER = 'API_KEY_OPENROUTER';
export const PROPERTY_BENCHMARKS = 'BENCHMARKS';
export const PROPERTY_BETTER_UPTIME_MONITOR_ID = 'BETTER_UPTIME_MONITOR_ID';
export const PROPERTY_DOCKER_HUB_PULLS = 'DOCKER_HUB_PULLS';
export const PROPERTY_GITHUB_CONTRIBUTORS = 'GITHUB_CONTRIBUTORS';
export const PROPERTY_GITHUB_STARGAZERS = 'GITHUB_STARGAZERS';
export const PROPERTY_COUNTRIES_OF_SUBSCRIBERS = 'COUNTRIES_OF_SUBSCRIBERS';
export const PROPERTY_COUPONS = 'COUPONS';
export const PROPERTY_CURRENCIES = 'CURRENCIES';
export const PROPERTY_CUSTOM_CRYPTOCURRENCIES = 'CUSTOM_CRYPTOCURRENCIES';
export const PROPERTY_DATA_SOURCE_MAPPING = 'DATA_SOURCE_MAPPING';
export const PROPERTY_DATA_SOURCES_GHOSTFOLIO_DATA_PROVIDER_MAX_REQUESTS =
  'DATA_SOURCES_GHOSTFOLIO_DATA_PROVIDER_MAX_REQUESTS';
export const PROPERTY_DEMO_ACCOUNT_ID = 'DEMO_ACCOUNT_ID';
export const PROPERTY_DEMO_USER_ID = 'DEMO_USER_ID';
export const PROPERTY_IS_DATA_GATHERING_ENABLED = 'IS_DATA_GATHERING_ENABLED';
export const PROPERTY_IS_READ_ONLY_MODE = 'IS_READ_ONLY_MODE';
export const PROPERTY_IS_USER_SIGNUP_ENABLED = 'IS_USER_SIGNUP_ENABLED';
export const PROPERTY_OPENROUTER_MODEL = 'OPENROUTER_MODEL';
export const PROPERTY_SLACK_COMMUNITY_USERS = 'SLACK_COMMUNITY_USERS';
export const PROPERTY_STRIPE_CONFIG = 'STRIPE_CONFIG';
export const PROPERTY_SYSTEM_MESSAGE = 'SYSTEM_MESSAGE';
export const PROPERTY_UPTIME = 'UPTIME';

export const QUEUE_JOB_STATUS_LIST = [
  'active',
  'completed',
  'delayed',
  'failed',
  'paused',
  'waiting'
] as JobStatus[];

export const REPLACE_NAME_PARTS = [
  'Amundi Index Solutions -',
  'iShares ETF (CH) -',
  'iShares III Public Limited Company -',
  'iShares V PLC -',
  'iShares VI Public Limited Company -',
  'iShares VII PLC -',
  'Multi Units Luxembourg -',
  'VanEck ETFs N.V. -',
  'Vaneck Vectors Ucits Etfs Plc -',
  'Vanguard Funds Public Limited Company -',
  'Vanguard Index Funds -',
  'Xtrackers (IE) Plc -'
];

export const STORYBOOK_PATH = '/development/storybook';

export const SUPPORTED_LANGUAGE_CODES = [
  'ca',
  'de',
  'en',
  'es',
  'fr',
  'it',
  'ko',
  'nl',
  'pl',
  'pt',
  'tr',
  'uk',
  'zh'
];

export const TAG_ID_EMERGENCY_FUND = '4452656d-9fa4-4bd0-ba38-70492e31d180';
export const TAG_ID_EXCLUDE_FROM_ANALYSIS =
  'f2e868af-8333-459f-b161-cbc6544c24bd';
export const TAG_ID_DEMO = 'efa08cb3-9b9d-4974-ac68-db13a19c4874';

export const UNKNOWN_KEY = 'UNKNOWN';
