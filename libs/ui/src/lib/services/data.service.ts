import {
  KEY_STORAGE_AUTHORIZATION_TOKEN,
  KEY_STORAGE_IMPERSONATION_ID
} from '@ghostfolio/common/config';
// `import type`, and not merely as a style: every one of these is used only in a
// parameter or return position here, while a value import pulls the whole DTO
// barrel - and the validation decorators every DTO carries - into the bundle of
// anything that reaches this facade. Since this facade is reached on first paint,
// that meant shipping all of it to every visitor.
import type {
  CreateAccessDto,
  CreateAccountBalanceDto,
  CreateAccountDto,
  CreateOrderDto,
  CreateTagDto,
  CreateWatchlistItemDto,
  DeleteOwnUserDto,
  TransferBalanceDto,
  UpdateAccessDto,
  UpdateAccountDto,
  UpdateBulkMarketDataDto,
  UpdateOrderDto,
  UpdateOwnAccessTokenDto,
  UpdatePropertyDto,
  UpdateTagDto,
  UpdateUserDashboardLayoutDto,
  UpdateUserSettingDto
} from '@ghostfolio/common/dtos';
import { DATE_FORMAT } from '@ghostfolio/common/helper';
import {
  Access,
  AccessTokenResponse,
  AccountBalancesResponse,
  AccountResponse,
  AccountsResponse,
  ActivitiesResponse,
  ActivityResponse,
  AiPromptResponse,
  ApiKeyResponse,
  AssetProfileIdentifier,
  AssetResponse,
  BenchmarkMarketDataDetailsResponse,
  BenchmarkResponse,
  CreateStripeCheckoutSessionResponse,
  DataProviderHealthResponse,
  DataProviderHistoricalResponse,
  ExportResponse,
  Filter,
  ImportResponse,
  InfoItem,
  LookupResponse,
  MarketDataDetailsResponse,
  MarketDataOfMarketsResponse,
  OAuthResponse,
  PlatformsResponse,
  PortfolioDetails,
  PortfolioDividendsResponse,
  PortfolioHoldingResponse,
  PortfolioHoldingsResponse,
  PortfolioInvestmentsResponse,
  PortfolioPerformanceResponse,
  PortfolioReportResponse,
  PublicPortfolioResponse,
  SymbolItem,
  User,
  UserDashboardLayout,
  UserItem,
  WatchlistResponse
} from '@ghostfolio/common/interfaces';
import { filterGlobalPermissions } from '@ghostfolio/common/permissions';
import type {
  AiPromptMode,
  DateRange,
  GroupBy
} from '@ghostfolio/common/types';
import { translate } from '@ghostfolio/ui/i18n';

import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { SortDirection } from '@angular/material/sort';
import { utc } from '@date-fns/utc';
import {
  Access as AccessModel,
  Account,
  AccountBalance,
  DataSource,
  MarketData,
  Order,
  SymbolProfile,
  Tag,
  User as UserModel
} from '@prisma/client';
import { format, parseISO } from 'date-fns';
import { cloneDeep, groupBy, isNumber } from 'lodash';
import { EMPTY, Observable } from 'rxjs';
import { catchError, finalize, map, shareReplay } from 'rxjs/operators';

/**
 * The spellings a URL parser treats as a relative path segment rather than as a
 * name, per the WHATWG URL standard.
 *
 * Percent-encoding is not a defence here, which is the whole reason this set
 * exists: a parser decodes a segment before deciding whether it is relative, so
 * `%2e%2e` is resolved away exactly as `..` is, and substituting `%2E` for the
 * dot would read as a fix while changing nothing.
 *
 * The percent spellings are nonetheless listed. Today they are unreachable,
 * because the membership test below runs on the *encoded* value and
 * `encodeURIComponent` turns the literal `%` into `%25` — so a raw `%2e`
 * arrives at the parser as `%252e`, which is not a dot segment at all and is
 * therefore correctly let through. Listing them makes this a statement about
 * the parser's vocabulary rather than about the current encoding step, so the
 * boundary still holds if that step is ever changed or relaxed.
 */
const DOT_SEGMENTS = new Set(['.', '..', '.%2e', '%2e', '%2e.', '%2e%2e']);

/**
 * The single encoder every request URL in this workspace is built with.
 *
 * Used as a template tag — ``encodeApiPath`/api/v1/account/${aId}` `` — it
 * percent-encodes every interpolated value and leaves the surrounding literal
 * untouched, so an identifier can only ever contribute one path segment. A tag
 * rather than a per-argument call is deliberate: within a tagged literal there
 * is no way to interpolate a value and bypass the encoding, whereas a helper
 * invoked by hand can be forgotten at exactly the one call site that matters.
 *
 * This is a security boundary, not cosmetics. Identifiers reaching these URLs
 * include values taken from the address bar, and a raw value carrying dot
 * segments plus a query delimiter is normalized by the browser before the
 * request leaves it — turning a read of one resource into a request for an
 * entirely different endpoint, issued with the signed-in viewer's own
 * credentials. Encoding strips the reserved meaning from `/`, `?`, `#` and `%`,
 * which is what keeps a value from delimiting its way into extra segments.
 *
 * Encoding alone is not sufficient, and assuming otherwise is the subtle half of
 * this boundary: the dot is an *unreserved* character, so an interpolated value
 * that is exactly `.` or `..` survives `encodeURIComponent` untouched and is
 * still resolved away by the parser. Those values are therefore refused outright
 * (see `DOT_SEGMENTS`) instead of encoded, which is the only handling that
 * actually prevents the request from being re-addressed.
 *
 * Legitimate identifiers are unaffected, because the values used here are
 * uuids, enum members, ISO dates and asset symbols, none of which contains a
 * reserved character. Encoding additionally repairs a latent defect for the
 * ones that can: `CreateAssetProfileDto.symbol` is validated only as a string,
 * so a manually maintained asset may legitimately carry `/` or `#` in its
 * symbol, which until now produced a malformed request path.
 *
 * That repair was verified on the wire rather than reasoned about, because a
 * `/` in a value becomes `%2F` and an encoded slash is handled inconsistently
 * across HTTP intermediaries. Against a symbol of `BLITZY/F27`, every endpoint
 * carrying a symbol in its path — `/api/v1/asset/:dataSource/:symbol`,
 * `/api/v1/benchmarks/:dataSource/:symbol[/:startDateString]`,
 * `/api/v1/watchlist/:dataSource/:symbol` and
 * `/api/v1/portfolio/holding/:dataSource/:symbol[/tags]` — matched its route
 * and received the value decoded exactly once, whereas the unencoded form this
 * tag replaced missed the route entirely and answered `404` on all four.
 * Requesting the doubly encoded `BLITZY%252FF27` returned a genuinely different
 * asset whose symbol is the literal text `BLITZY%2FF27`, which is what confirms
 * one level of decoding rather than none or two.
 *
 * The one place this can still break is outside the application: a reverse
 * proxy that normalizes the request line before forwarding it collapses `%2F`
 * back into a separator and the route stops matching. With nginx that
 * distinction is exactly whether `proxy_pass` carries a URI part —
 * `proxy_pass http://host:port;` forwards the request line unparsed and works,
 * whereas `proxy_pass http://host:port/;` substitutes the normalized URI and
 * does not. Operators who need a URI part should re-attach `$request_uri`
 * verbatim. This is a deployment condition rather than something this workspace
 * can encode, and it applies to every percent-encoded segment the API accepts.
 *
 * Exported as a function rather than held on the service because it depends on
 * no instance state, which lets `AdminService` reach the very same encoder
 * without a second definition.
 *
 * @param aStrings the literal chunks of the tagged template. They are authored
 * in this workspace and are therefore trusted verbatim.
 * @param aValues the interpolated identifiers, each encoded as one segment.
 * @throws if an interpolated value is exactly a relative path segment, because
 * no legitimate identifier is and the alternative is a request addressed
 * somewhere the caller never asked for.
 */
export function encodeApiPath(
  aStrings: TemplateStringsArray,
  ...aValues: (number | string)[]
): string {
  return aStrings.reduce((path, literalChunk, index) => {
    const encodedValue =
      index < aValues.length ? encodeURIComponent(`${aValues[index]}`) : '';

    // Encoding alone cannot close this gap, because the dot is an *unreserved*
    // character: `encodeURIComponent` returns `.` and `..` verbatim. Such a value
    // is resolved away by the parser before the request leaves the browser, which
    // silently drops a segment of the intended path and re-addresses the request
    // at an endpoint the caller never named — carrying the viewer's credentials.
    // There is no legitimate identifier that is exactly a dot segment, so the
    // only correct handling is to refuse it rather than to reshape it into
    // something that would still address the wrong resource.
    if (DOT_SEGMENTS.has(encodedValue.toLowerCase())) {
      throw new Error(
        `encodeApiPath refused '${aValues[index]}' because it is a relative path segment and would re-address the request`
      );
    }

    return `${path}${literalChunk}${encodedValue}`;
  }, '');
}

@Injectable({
  providedIn: 'root'
})
export class DataService {
  private readonly http = inject(HttpClient);

  /**
   * How many times the account a request would be made as has changed in this
   * document, used to keep the register below partitioned by it.
   *
   * An integer rather than the authorization context itself, deliberately: the
   * context is derived from a bearer token, and a token has no business being a
   * key in a long-lived map where it would be reachable from anything holding a
   * reference to this service. The number is meaningless on its own and is exactly
   * enough to tell one context from another.
   */
  private authorizationContextGeneration = 0;

  /**
   * The reads that are currently on the wire, keyed by the exact request they
   * represent *and* by the account it would be made as.
   *
   * An entry lives only for as long as its request does. It is removed the
   * moment the response arrives, the request errors, or the last subscriber
   * walks away - so this is a register of work in progress, never a cache of
   * results, and no caller can ever be handed a value fetched before something
   * it did. See `coalesceInFlightGet`.
   */
  private readonly inFlightGetRequests = new Map<string, Observable<unknown>>();

  /**
   * The authorization context the register was last observed under.
   *
   * Held so a change can be *detected*, which is what makes the partitioning
   * automatic rather than something every sign-in, sign-out and impersonation site
   * has to remember to announce. Private and never emitted.
   */
  private lastObservedAuthorizationContext: string;

  public buildFiltersAsQueryParams({ filters }: { filters?: Filter[] }) {
    let params = new HttpParams();

    if (filters && filters.length > 0) {
      const {
        ACCOUNT: filtersByAccount,
        ASSET_CLASS: filtersByAssetClass,
        ASSET_SUB_CLASS: filtersByAssetSubClass,
        DATA_SOURCE: [filterByDataSource] = [],
        HOLDING_TYPE: filtersByHoldingType,
        PRESET_ID: filtersByPresetId,
        SEARCH_QUERY: filtersBySearchQuery,
        SYMBOL: [filterBySymbol] = [],
        TAG: filtersByTag
      } = groupBy(filters, (filter) => {
        return filter.type;
      });

      if (filterByDataSource) {
        params = params.append('dataSource', filterByDataSource.id);
      }

      if (filterBySymbol) {
        params = params.append('symbol', filterBySymbol.id);
      }

      if (filtersByAccount) {
        params = params.append(
          'accounts',
          filtersByAccount
            .map(({ id }) => {
              return id;
            })
            .join(',')
        );
      }

      if (filtersByAssetClass) {
        params = params.append(
          'assetClasses',
          filtersByAssetClass
            .map(({ id }) => {
              return id;
            })
            .join(',')
        );
      }

      if (filtersByAssetSubClass) {
        params = params.append(
          'assetSubClasses',
          filtersByAssetSubClass
            .map(({ id }) => {
              return id;
            })
            .join(',')
        );
      }

      if (filtersByHoldingType) {
        params = params.append('holdingType', filtersByHoldingType[0].id);
      }

      if (filtersByPresetId) {
        params = params.append('presetId', filtersByPresetId[0].id);
      }

      if (filtersBySearchQuery) {
        params = params.append('query', filtersBySearchQuery[0].id);
      }

      if (filtersByTag) {
        params = params.append(
          'tags',
          filtersByTag
            .map(({ id }) => {
              return id;
            })
            .join(',')
        );
      }
    }

    return params;
  }

  public createStripeCheckoutSession({
    couponId,
    priceId
  }: {
    couponId?: string;
    priceId: string;
  }) {
    return this.http.post<CreateStripeCheckoutSessionResponse>(
      '/api/v1/subscription/stripe/checkout-session',
      {
        couponId,
        priceId
      }
    );
  }

  public fetchAccount(aAccountId: string) {
    return this.http.get<AccountResponse>(
      encodeApiPath`/api/v1/account/${aAccountId}`
    );
  }

  public fetchAccountBalances(aAccountId: string) {
    return this.http.get<AccountBalancesResponse>(
      encodeApiPath`/api/v1/account/${aAccountId}/balances`
    );
  }

  public fetchAccounts({ filters }: { filters?: Filter[] } = {}) {
    const params = this.buildFiltersAsQueryParams({ filters });

    return this.http.get<AccountsResponse>('/api/v1/account', { params });
  }

  public fetchActivities({
    activityTypes,
    filters,
    range,
    skip,
    sortColumn,
    sortDirection,
    take
  }: {
    activityTypes?: string[];
    filters?: Filter[];
    range?: DateRange;
    skip?: number;
    sortColumn?: string;
    sortDirection?: SortDirection;
    take?: number;
  }): Observable<ActivitiesResponse> {
    let params = this.buildFiltersAsQueryParams({ filters });

    if (activityTypes?.length) {
      params = params.append('activityTypes', activityTypes.join(','));
    }

    if (range) {
      params = params.append('range', range);
    }

    if (skip) {
      params = params.append('skip', skip);
    }

    if (sortColumn) {
      params = params.append('sortColumn', sortColumn);
    }

    if (sortDirection) {
      params = params.append('sortDirection', sortDirection);
    }

    if (take) {
      params = params.append('take', take);
    }

    return this.http.get<any>('/api/v1/activities', { params }).pipe(
      map(({ activities, count }) => {
        for (const activity of activities) {
          activity.createdAt = parseISO(activity.createdAt);
          activity.date = parseISO(activity.date);
        }
        return { activities, count };
      })
    );
  }

  public fetchActivity(aActivityId: string) {
    return this.http
      .get<ActivityResponse>(encodeApiPath`/api/v1/activities/${aActivityId}`)
      .pipe(
        map((activity) => {
          activity.createdAt = parseISO(
            activity.createdAt as unknown as string
          );
          activity.date = parseISO(activity.date as unknown as string);

          return activity;
        })
      );
  }

  public fetchDividends({
    filters,
    groupBy = 'month',
    range
  }: {
    filters?: Filter[];
    groupBy?: GroupBy;
    range: DateRange;
  }) {
    let params = this.buildFiltersAsQueryParams({ filters });
    params = params.append('groupBy', groupBy);
    params = params.append('range', range);

    return this.http.get<PortfolioDividendsResponse>(
      '/api/v1/portfolio/dividends',
      {
        params
      }
    );
  }

  public fetchDividendsImport({ dataSource, symbol }: AssetProfileIdentifier) {
    return this.http.get<ImportResponse>(
      encodeApiPath`/api/v1/import/dividends/${dataSource}/${symbol}`
    );
  }

  public fetchExchangeRateForDate({
    date,
    symbol
  }: {
    date: Date;
    symbol: string;
  }) {
    return this.http.get<DataProviderHistoricalResponse>(
      encodeApiPath`/api/v1/exchange-rate/${symbol}/${format(date, DATE_FORMAT, { in: utc })}`
    );
  }

  public deleteAccess(aId: string) {
    return this.http.delete<AccessModel>(encodeApiPath`/api/v1/access/${aId}`);
  }

  public deleteAccount(aId: string) {
    return this.http.delete<Account>(encodeApiPath`/api/v1/account/${aId}`);
  }

  public deleteAccountBalance(aId: string) {
    return this.http.delete<AccountBalance>(
      encodeApiPath`/api/v1/account-balance/${aId}`
    );
  }

  public deleteActivities({ filters }: { filters?: Filter[] }) {
    const params = this.buildFiltersAsQueryParams({ filters });

    return this.http.delete<number>('/api/v1/activities', { params });
  }

  public deleteActivity(aId: string) {
    return this.http.delete<Order>(encodeApiPath`/api/v1/activities/${aId}`);
  }

  public deleteBenchmark({ dataSource, symbol }: AssetProfileIdentifier) {
    return this.http.delete<Partial<SymbolProfile>>(
      encodeApiPath`/api/v1/benchmarks/${dataSource}/${symbol}`
    );
  }

  public deleteOwnUser(aData: DeleteOwnUserDto) {
    return this.http.delete<UserModel>(`/api/v1/user`, { body: aData });
  }

  public deleteTag(aId: string) {
    return this.http.delete<Tag>(encodeApiPath`/api/v1/tags/${aId}`);
  }

  /**
   * Discards the signed-in user's saved dashboard arrangement.
   *
   * Typed `void` because the endpoint answers 204 with no body. It is deliberately
   * NOT a layout write: it stores no arrangement, which is what lets a dashboard
   * the client cannot interpret be recovered without giving the error state that
   * reports it the ability to overwrite the stored document.
   */
  public deleteUserDashboardLayout() {
    return this.http.delete<void>('/api/v1/user/layout');
  }

  public deleteUser(aId: string) {
    return this.http.delete<UserModel>(encodeApiPath`/api/v1/user/${aId}`);
  }

  public deleteWatchlistItem({ dataSource, symbol }: AssetProfileIdentifier) {
    return this.http.delete<void>(
      encodeApiPath`/api/v1/watchlist/${dataSource}/${symbol}`
    );
  }

  public fetchAccesses() {
    return this.http.get<Access[]>('/api/v1/access');
  }

  public fetchAsset({
    dataSource,
    symbol
  }: AssetProfileIdentifier): Observable<AssetResponse> {
    return this.http
      .get<any>(encodeApiPath`/api/v1/asset/${dataSource}/${symbol}`)
      .pipe(
        map((data) => {
          for (const item of data.marketData) {
            item.date = parseISO(item.date);
          }
          return data;
        })
      );
  }

  public fetchBenchmarkForUser({
    dataSource,
    filters,
    range,
    startDate,
    symbol,
    withExcludedAccounts
  }: {
    filters?: Filter[];
    range: DateRange;
    startDate: Date;
    withExcludedAccounts?: boolean;
  } & AssetProfileIdentifier) {
    let params = this.buildFiltersAsQueryParams({ filters });

    params = params.append('range', range);

    if (withExcludedAccounts) {
      params = params.append('withExcludedAccounts', withExcludedAccounts);
    }

    return this.http.get<BenchmarkMarketDataDetailsResponse>(
      encodeApiPath`/api/v1/benchmarks/${dataSource}/${symbol}/${format(startDate, DATE_FORMAT, { in: utc })}`,
      { params }
    );
  }

  /**
   * Reads the benchmark list.
   *
   * Coalesced for the same structural reason as the environment description: two
   * separate modules read it, the free markets module and the premium one, and a
   * viewer entitled to both can have both on screen - at which point the two ask
   * for a parameterless document at the same moment and previously got two
   * requests for it.
   *
   * Safe to share despite the two readers holding the response rather than
   * consuming it: each hands the array to a table of its own, which orders a copy
   * rather than sorting in place, so neither can disturb what the other is
   * rendering.
   */
  public fetchBenchmarks() {
    const url = '/api/v1/benchmarks';

    return this.coalesceInFlightGet<BenchmarkResponse>(
      this.buildInFlightGetKey(url, new HttpParams()),
      () => this.http.get<BenchmarkResponse>(url)
    );
  }

  public fetchDataProviderHealth(dataSource: DataSource) {
    return this.http.get<DataProviderHealthResponse>(
      encodeApiPath`/api/v1/health/data-provider/${dataSource}`
    );
  }

  public fetchExport({
    activityIds,
    activityTypes,
    filters
  }: {
    activityIds?: string[];
    activityTypes?: string[];
    filters?: Filter[];
  } = {}) {
    let params = this.buildFiltersAsQueryParams({ filters });

    if (activityIds) {
      params = params.append('activityIds', activityIds.join(','));
    }

    if (activityTypes?.length) {
      params = params.append('activityTypes', activityTypes.join(','));
    }

    return this.http.get<ExportResponse>('/api/v1/export', {
      params
    });
  }

  public fetchHoldingDetail({
    dataSource,
    symbol
  }: {
    dataSource: DataSource;
    symbol: string;
  }) {
    return this.http.get<PortfolioHoldingResponse>(
      encodeApiPath`/api/v1/portfolio/holding/${dataSource}/${symbol}`
    );
  }

  /**
   * Whether the published public configuration is the offline fallback rather
   * than the server's own answer.
   *
   * Read from the same global the configuration itself is published on, because
   * it is a property of that publication: `main.ts` sets it when the pre-bootstrap
   * read failed, and {@link updateInfo} clears it the moment a later read
   * succeeds. That is what makes the degraded state recoverable without a reload -
   * a caller can ask again, and the answer changes.
   */
  public isPublicInfoUnavailable(): boolean {
    return (window as any).isPublicInfoUnavailable === true;
  }

  public fetchInfo(): InfoItem {
    const info = cloneDeep((window as any).info);
    const utmSource = window.localStorage.getItem('utm_source') as
      | 'ios'
      | 'trusted-web-activity';

    info.globalPermissions = filterGlobalPermissions(
      info.globalPermissions,
      utmSource
    );

    return info;
  }

  public fetchInvestments({
    filters,
    groupBy = 'month',
    range
  }: {
    filters?: Filter[];
    groupBy?: GroupBy;
    range: DateRange;
  }) {
    let params = this.buildFiltersAsQueryParams({ filters });
    params = params.append('groupBy', groupBy);
    params = params.append('range', range);

    return this.http.get<PortfolioInvestmentsResponse>(
      '/api/v1/portfolio/investments',
      { params }
    );
  }

  public fetchMarketDataBySymbol({
    dataSource,
    symbol
  }: {
    dataSource: DataSource;
    symbol: string;
  }): Observable<MarketDataDetailsResponse> {
    return this.http
      .get<any>(encodeApiPath`/api/v1/market-data/${dataSource}/${symbol}`)
      .pipe(
        map((data) => {
          for (const item of data.marketData) {
            item.date = parseISO(item.date);
          }
          return data;
        })
      );
  }

  public fetchMarketDataOfMarkets({
    includeHistoricalData
  }: {
    includeHistoricalData?: number;
  }): Observable<MarketDataOfMarketsResponse> {
    let params = new HttpParams();

    if (includeHistoricalData) {
      params = params.append('includeHistoricalData', includeHistoricalData);
    }

    return this.http.get<any>('/api/v1/market-data/markets', { params }).pipe(
      map((data) => {
        for (const item of data.fearAndGreedIndex.CRYPTOCURRENCIES
          ?.historicalData ?? []) {
          item.date = parseISO(item.date);
        }

        for (const item of data.fearAndGreedIndex.STOCKS?.historicalData ??
          []) {
          item.date = parseISO(item.date);
        }

        return data;
      })
    );
  }

  public fetchPlatforms() {
    return this.http.get<PlatformsResponse>('/api/v1/platforms');
  }

  public fetchPortfolioDetails({
    filters,
    withMarkets = false
  }: {
    filters?: Filter[];
    withMarkets?: boolean;
  } = {}): Observable<PortfolioDetails> {
    let params = this.buildFiltersAsQueryParams({ filters });

    if (withMarkets) {
      params = params.append('withMarkets', withMarkets);
    }

    const url = '/api/v1/portfolio/details';

    return this.coalesceInFlightGet(this.buildInFlightGetKey(url, params), () =>
      this.http.get<any>(url, { params }).pipe(
        map((response) => {
          if (response.holdings) {
            for (const symbol of Object.keys(response.holdings)) {
              response.holdings[symbol].assetClassLabel = translate(
                response.holdings[symbol].assetClass
              );

              response.holdings[symbol].assetSubClassLabel = translate(
                response.holdings[symbol].assetSubClass
              );

              response.holdings[symbol].dateOfFirstActivity = response.holdings[
                symbol
              ].dateOfFirstActivity
                ? parseISO(response.holdings[symbol].dateOfFirstActivity)
                : undefined;

              response.holdings[symbol].value = isNumber(
                response.holdings[symbol].value
              )
                ? response.holdings[symbol].value
                : response.holdings[symbol].valueInPercentage;
            }
          }

          if (response.summary?.dateOfFirstActivity) {
            response.summary.dateOfFirstActivity = parseISO(
              response.summary.dateOfFirstActivity
            );
          }

          return response;
        })
      )
    );
  }

  public fetchPortfolioHoldings({
    filters,
    range
  }: {
    filters?: Filter[];
    range?: DateRange;
  } = {}) {
    let params = this.buildFiltersAsQueryParams({ filters });

    if (range) {
      params = params.append('range', range);
    }

    const url = '/api/v1/portfolio/holdings';

    return this.coalesceInFlightGet(this.buildInFlightGetKey(url, params), () =>
      this.http.get<PortfolioHoldingsResponse>(url, { params }).pipe(
        map((response) => {
          if (response.holdings) {
            for (const symbol of Object.keys(response.holdings)) {
              response.holdings[symbol].assetClassLabel = translate(
                response.holdings[symbol].assetClass
              );

              response.holdings[symbol].assetSubClassLabel = translate(
                response.holdings[symbol].assetSubClass
              );

              response.holdings[symbol].dateOfFirstActivity = response.holdings[
                symbol
              ].dateOfFirstActivity
                ? parseISO(response.holdings[symbol].dateOfFirstActivity)
                : undefined;

              response.holdings[symbol].value = isNumber(
                response.holdings[symbol].value
              )
                ? response.holdings[symbol].value
                : response.holdings[symbol].valueInPercentage;
            }
          }

          return response;
        })
      )
    );
  }

  public fetchPortfolioPerformance({
    filters,
    range,
    withExcludedAccounts = false,
    withItems = false
  }: {
    filters?: Filter[];
    range: DateRange;
    withExcludedAccounts?: boolean;
    withItems?: boolean;
  }): Observable<PortfolioPerformanceResponse> {
    let params = this.buildFiltersAsQueryParams({ filters });
    params = params.append('range', range);

    if (withExcludedAccounts) {
      params = params.append('withExcludedAccounts', withExcludedAccounts);
    }

    if (withItems) {
      params = params.append('withItems', withItems);
    }

    const url = `/api/v2/portfolio/performance`;

    return this.coalesceInFlightGet(this.buildInFlightGetKey(url, params), () =>
      this.http.get<any>(url, { params }).pipe(
        map((response) => {
          if (response.firstOrderDate) {
            response.firstOrderDate = parseISO(response.firstOrderDate);
          }

          return response;
        })
      )
    );
  }

  public fetchPortfolioReport() {
    return this.http.get<PortfolioReportResponse>('/api/v1/portfolio/report');
  }

  public fetchPrompt({
    filters,
    mode
  }: {
    filters?: Filter[];
    mode: AiPromptMode;
  }) {
    const params = this.buildFiltersAsQueryParams({ filters });

    return this.http.get<AiPromptResponse>(
      encodeApiPath`/api/v1/ai/prompt/${mode}`,
      {
        params
      }
    );
  }

  public fetchPublicPortfolio(aAccessId: string) {
    // Encoded rather than interpolated raw. The identifier reaches this method
    // from a URL a visitor can edit, and an unencoded separator or query
    // delimiter in it would change which path this same-origin request actually
    // addresses. Encoding is a no-op for the generated identifiers this endpoint
    // expects, so it costs nothing and removes the possibility.
    return this.http
      .get<PublicPortfolioResponse>(
        encodeApiPath`/api/v1/public/${aAccessId}/portfolio`
      )
      .pipe(
        map((response) => {
          if (response.holdings) {
            for (const symbol of Object.keys(response.holdings)) {
              response.holdings[symbol].valueInBaseCurrency = isNumber(
                response.holdings[symbol].valueInBaseCurrency
              )
                ? response.holdings[symbol].valueInBaseCurrency
                : response.holdings[symbol].valueInPercentage;
            }
          }

          return response;
        })
      );
  }

  public fetchSymbolItem({
    dataSource,
    includeHistoricalData,
    symbol
  }: {
    dataSource: DataSource | string;
    includeHistoricalData?: number;
    symbol: string;
  }) {
    let params = new HttpParams();

    if (includeHistoricalData) {
      params = params.append('includeHistoricalData', includeHistoricalData);
    }

    return this.http.get<SymbolItem>(
      encodeApiPath`/api/v1/symbol/${dataSource}/${symbol}`,
      {
        params
      }
    );
  }

  public fetchSymbols({
    includeIndices = false,
    query
  }: {
    includeIndices?: boolean;
    query: string;
  }) {
    let params = new HttpParams().set('query', query);

    if (includeIndices) {
      params = params.append('includeIndices', includeIndices);
    }

    return this.http
      .get<LookupResponse>('/api/v1/symbol/lookup', { params })
      .pipe(
        map(({ items }) => {
          return items;
        })
      );
  }

  public fetchTags() {
    return this.http.get<Tag[]>('/api/v1/tags');
  }

  public fetchUserDashboardLayout() {
    return this.http.get<UserDashboardLayout | null>('/api/v1/user/layout');
  }

  public fetchWatchlist() {
    return this.http.get<WatchlistResponse>('/api/v1/watchlist');
  }

  public loginAnonymous(accessToken: string) {
    return this.http.post<OAuthResponse>('/api/v1/auth/anonymous', {
      accessToken
    });
  }

  public patchUserDashboardLayout(aData: UpdateUserDashboardLayoutDto) {
    return this.http.patch<UserDashboardLayout>('/api/v1/user/layout', aData);
  }

  public postAccess(aAccess: CreateAccessDto) {
    return this.http.post<Access>('/api/v1/access', aAccess);
  }

  public postAccount(aAccount: CreateAccountDto) {
    return this.http.post<Account>('/api/v1/account', aAccount);
  }

  public postAccountBalance(aAccountBalance: CreateAccountBalanceDto) {
    return this.http.post<AccountBalance>(
      '/api/v1/account-balance',
      aAccountBalance
    );
  }

  public postActivity(aOrder: CreateOrderDto) {
    return this.http.post<Order>('/api/v1/activities', aOrder);
  }

  public postApiKey() {
    return this.http.post<ApiKeyResponse>('/api/v1/api-keys', {});
  }

  public postBenchmark(benchmark: AssetProfileIdentifier) {
    return this.http.post('/api/v1/benchmarks', benchmark);
  }

  public postMarketData({
    dataSource,
    marketData,
    symbol
  }: {
    dataSource: DataSource;
    marketData: UpdateBulkMarketDataDto;
    symbol: string;
  }) {
    const url = encodeApiPath`/api/v1/market-data/${dataSource}/${symbol}`;

    return this.http.post<MarketData>(url, marketData);
  }

  public postTag(aTag: CreateTagDto) {
    return this.http.post<Tag>(`/api/v1/tags`, aTag);
  }

  public postUser() {
    return this.http.post<UserItem>('/api/v1/user', {});
  }

  public postWatchlistItem(watchlistItem: CreateWatchlistItemDto) {
    return this.http.post('/api/v1/watchlist', watchlistItem);
  }

  public putAccess(aAccess: UpdateAccessDto) {
    return this.http.put<Access>(
      encodeApiPath`/api/v1/access/${aAccess.id}`,
      aAccess
    );
  }

  public putAccount(aAccount: UpdateAccountDto) {
    return this.http.put<UserItem>(
      encodeApiPath`/api/v1/account/${aAccount.id}`,
      aAccount
    );
  }

  public putActivity(aOrder: UpdateOrderDto) {
    return this.http.put<UserItem>(
      encodeApiPath`/api/v1/activities/${aOrder.id}`,
      aOrder
    );
  }

  public putAdminSetting(key: string, aData: UpdatePropertyDto) {
    return this.http.put<void>(
      encodeApiPath`/api/v1/admin/settings/${key}`,
      aData
    );
  }

  public putHoldingTags({
    dataSource,
    symbol,
    tags
  }: { tags: Tag[] } & AssetProfileIdentifier) {
    return this.http.put<void>(
      encodeApiPath`/api/v1/portfolio/holding/${dataSource}/${symbol}/tags`,
      { tags }
    );
  }

  public putTag(aTag: UpdateTagDto) {
    return this.http.put<Tag>(encodeApiPath`/api/v1/tags/${aTag.id}`, aTag);
  }

  public putUserSetting(aData: UpdateUserSettingDto) {
    return this.http.put<User>('/api/v1/user/setting', aData);
  }

  public redeemCoupon(couponCode: string) {
    return this.http.post('/api/v1/subscription/redeem-coupon', {
      couponCode
    });
  }

  public transferAccountBalance({
    accountIdFrom,
    accountIdTo,
    balance
  }: TransferBalanceDto) {
    return this.http.post('/api/v1/account/transfer-balance', {
      accountIdFrom,
      accountIdTo,
      balance
    });
  }

  public updateOwnAccessToken(aAccessToken: UpdateOwnAccessTokenDto) {
    return this.http.post<AccessTokenResponse>(
      '/api/v1/user/access-token',
      aAccessToken
    );
  }

  public updateUserAccessToken(aUserId: string) {
    return this.http.post<AccessTokenResponse>(
      encodeApiPath`/api/v1/user/${aUserId}/access-token`,
      {}
    );
  }

  /**
   * Re-reads the deployment's own description and republishes it.
   *
   * Coalesced, because the callers overlap on first paint rather than only in
   * theory. The platform and tag administration components each refresh this
   * after loading their own list, and both are hosted by the administration
   * settings module - so on one canvas load they issued two identical reads
   * milliseconds apart. Sharing an in-flight read makes that one request while
   * leaving the refresh after a mutation untouched, which is the other reason
   * these callers exist: the register drops the entry as soon as the read
   * settles, so a later call always asks the server again. A cache with a
   * lifetime would have answered a post-mutation refresh from before the
   * mutation.
   *
   * The projection and the republish sit INSIDE the shared request rather than in
   * each subscriber, so they run exactly once per response no matter how many
   * callers joined. That matters here specifically: the permission filter is
   * applied to `info.globalPermissions` in place, and a second pass over the same
   * object would filter an already-filtered list. It is also why every caller
   * ignores the result: the answer is delivered by publication, not by return.
   */
  public updateInfo() {
    const url = '/api/v1/info';

    this.coalesceInFlightGet(
      this.buildInFlightGetKey(url, new HttpParams()),
      () =>
        this.http.get<InfoItem>(url).pipe(
          map((info) => {
            const utmSource = window.localStorage.getItem('utm_source') as
              | 'ios'
              | 'trusted-web-activity';

            info.globalPermissions = filterGlobalPermissions(
              info.globalPermissions,
              utmSource
            );

            (window as any).info = info;

            // Lowered only on a successful read, which is what makes this method
            // the recovery from a boot that had to run on the fallback: whatever
            // the shell says about missing features stops being said the moment
            // the real configuration arrives.
            (window as any).isPublicInfoUnavailable = false;

            return info;
          }),
          // A failed retry leaves the flag exactly as it was and terminates
          // quietly. It matters that it does not rethrow: the caller is a fire and
          // forget refresh with no error channel of its own, so an unhandled
          // rejection here would be reported as an application fault when the only
          // fact available is that the server is still unreachable.
          catchError(() => EMPTY)
        )
    ).subscribe();
  }

  /**
   * Issues a GET that joins an identical read already in flight, for a caller
   * outside this facade.
   *
   * The sibling admin facade reads endpoints of its own that co-mounted modules
   * ask for simultaneously, and it has no register to share - so without this it
   * either duplicates every such read or keeps a second, independent register,
   * which would partition by authorization context separately and could disagree
   * with this one about when an identity changed. Exposing the one register is the
   * narrower of the two, and it is the same reasoning that already makes
   * {@link buildFiltersAsQueryParams} public for that caller.
   *
   * Deliberately offers no response mapping. Everything about coalescing that
   * needs care - the key, the authorization partitioning, the register's
   * lifetime - stays private, and the one hazard a shared read carries is a
   * mapping that rewrites the response in place. A caller with such a mapping
   * belongs in this class, where it can be placed inside the request; a caller
   * with none, like a plain document read, is safe by construction.
   *
   * @param url the request path, which is also the key together with the
   * parameters and the current authorization context.
   * @param params the query parameters, in the order they were appended - two
   * callers that assemble the same parameters differently simply do not share.
   */
  public coalesceGet<T>(url: string, params = new HttpParams()): Observable<T> {
    return this.coalesceInFlightGet<T>(
      this.buildInFlightGetKey(url, params),
      () => this.http.get<T>(url, { params })
    );
  }

  /**
   * Builds the key that decides whether two reads are the same read.
   *
   * The key is the request line itself - path plus serialised query string -
   * prefixed with the generation of the authorization context the read is issued
   * under, so two callers collide only when the bytes they would each have put on
   * the wire are identical **and** the request would be made as the same account.
   *
   * The second half is not a refinement, it is what makes the sharing safe at all.
   * The request line is only part of what distinguishes these requests: the bearer
   * token, the impersonation identifier and the timezone are attached later, by the
   * application's outgoing request interceptor, and are invisible here. Without the
   * generation in the key, a read issued after an account change could join a
   * request that was created with the *previous* account's headers and be handed
   * that account's holdings, performance and values - a cross-account disclosure
   * produced by an optimisation.
   *
   * That direction of error matters in both halves: `HttpParams.toString()`
   * preserves append order, so two callers that assemble the same parameters in
   * a different order produce different keys and are simply not shared. Missing
   * a chance to share is harmless; sharing a response between callers that asked
   * different questions, or asked as different accounts, would not be, and this
   * key makes both impossible.
   */
  private buildInFlightGetKey(url: string, params: HttpParams): string {
    const queryString = params.toString();
    const requestLine = queryString ? `${url}?${queryString}` : url;

    return `${this.getAuthorizationContextGeneration()}\u0000${requestLine}`;
  }

  /**
   * The generation of the account the next request would be made as, dropping the
   * register whenever it changes.
   *
   * Derived on every coalescing decision rather than pushed in from the places
   * where identity changes, and that is a security property rather than a style
   * choice. Identity changes in this application at a sign-in hand-off, at an
   * access-token sign-in, at a sign-out, on a 401 from any request, and on every
   * impersonation change - and a pushed notification that any one of those sites
   * forgot to send would restore the very defect this closes, silently and with no
   * failing test. Reading the same three inputs the request interceptor reads means
   * there is no site that *can* forget.
   *
   * The three inputs are exactly what varies the request's authorization: the
   * bearer token, the impersonated account, and the timezone the server scopes
   * dates by. They are read from the same storage keys the interceptor reads,
   * shared through `@ghostfolio/common/config` so the two cannot drift apart.
   *
   * Dropping the register on a change does not disturb a request already in flight
   * or the caller waiting on it: that caller asked as the previous account and is
   * still answered correctly. What it prevents is a *later* caller joining it.
   *
   * Storage access is guarded because this facade is also constructed in
   * environments that have none - Storybook and the test runner among them - where
   * every read is anonymous and a single context is the correct answer.
   */
  private getAuthorizationContextGeneration(): number {
    const authorizationContext = this.readAuthorizationContext();

    if (authorizationContext !== this.lastObservedAuthorizationContext) {
      this.lastObservedAuthorizationContext = authorizationContext;
      this.authorizationContextGeneration += 1;

      // Every entry belonged to the previous context, and none of them may be
      // joined now. Clearing rather than filtering, because there is nothing in
      // here worth keeping: an entry is a request in progress, and one issued as
      // another account is exactly what must not be reused.
      this.inFlightGetRequests.clear();
    }

    return this.authorizationContextGeneration;
  }

  /**
   * Reads the authorization context as an opaque string.
   *
   * The value contains the bearer token and therefore never leaves this class: it
   * is compared, and what is published is the generation counter instead. The
   * separator is a NUL so no combination of the three inputs can be reassembled
   * into a different combination that compares equal.
   */
  private readAuthorizationContext(): string {
    const token =
      window.sessionStorage?.getItem(KEY_STORAGE_AUTHORIZATION_TOKEN) ??
      window.localStorage?.getItem(KEY_STORAGE_AUTHORIZATION_TOKEN) ??
      '';

    // Read only alongside a token, mirroring the request interceptor, which
    // attaches the impersonation header only when it is sending a bearer token.
    const impersonationId = token
      ? (window.localStorage?.getItem(KEY_STORAGE_IMPERSONATION_ID) ?? '')
      : '';

    const timeZone = Intl?.DateTimeFormat().resolvedOptions().timeZone ?? '';

    return `${token}\u0000${impersonationId}\u0000${timeZone}`;
  }

  /**
   * Serves every concurrent caller of an identical read from one request.
   *
   * The canvas mounts many modules at once and several of them legitimately want
   * the same figures, each asking through its own component. Measured on a
   * canvas holding Overview, Summary, Holdings, FIRE, Allocations and Analysis,
   * that produced 14 requests for 11 distinct URLs: `/api/v2/portfolio/
   * performance?range=max` was fetched twice (177,765 bytes each time) and
   * `/api/v1/portfolio/holdings?range=max` twice (15,788 bytes each), 185 kB of
   * a 449 kB API payload spent fetching bytes the page already had in flight.
   * The redundant call also made the first one slower, since both queued against
   * the same connection pool.
   *
   * Only genuinely overlapping reads are joined. There is no expiry and nothing
   * is retained: the entry is dropped when the request settles, so a caller can
   * only ever join a request that had not yet answered when it asked. Two
   * callers in that position are asking the same question of the same server
   * state and cannot be told apart by the answer they receive, which is why this
   * shares work without changing what any caller observes. A cache with a
   * lifetime, however short, would not have that property - a read issued just
   * after a write could be answered from before it.
   *
   * Cancellation still reaches the network. `refCount` releases the underlying
   * subscription once the last subscriber leaves, so a module destroyed while
   * its read is outstanding still aborts it - unless another module is waiting
   * on the same read, which is precisely when it should not be aborted.
   *
   * `createRequest` is invoked with the caller's own response mapping already
   * applied, and the sharing sits above it, so that mapping runs exactly once
   * per request no matter how many callers join. That is load-bearing rather
   * than incidental: these mappings rewrite the response in place - `parseISO`
   * over `dateOfFirstActivity`, for one - and are not safe to run twice over the
   * same object, because the second pass would be handed the `Date` the first
   * pass produced. Every consumer of the shared result reads it without
   * modifying it, which is what makes one mapped object safe to hand to all of
   * them.
   */
  private coalesceInFlightGet<T>(
    cacheKey: string,
    createRequest: () => Observable<T>
  ): Observable<T> {
    const inFlightRequest = this.inFlightGetRequests.get(cacheKey) as
      | Observable<T>
      | undefined;

    if (inFlightRequest) {
      return inFlightRequest;
    }

    const request = createRequest().pipe(
      // Placed above `shareReplay` so it observes the request itself rather than
      // any one subscriber, and therefore fires on all three ways a request can
      // end - answered, failed, or abandoned by everyone waiting. Leaving the
      // key behind on the abandoned path would be the damaging one: a request
      // nobody is subscribed to any more would still be handed out.
      finalize(() => {
        this.inFlightGetRequests.delete(cacheKey);
      }),
      shareReplay({ bufferSize: 1, refCount: true })
    );

    this.inFlightGetRequests.set(cacheKey, request);

    return request;
  }
}
