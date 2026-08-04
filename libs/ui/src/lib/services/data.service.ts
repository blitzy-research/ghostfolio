import {
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
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

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
 * ones that can: a manually maintained asset may legitimately carry `/` or `#`
 * in its symbol, which until now produced a malformed request path.
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

  public fetchBenchmarks() {
    return this.http.get<BenchmarkResponse>('/api/v1/benchmarks');
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

    return this.http
      .get<any>('/api/v1/portfolio/details', {
        params
      })
      .pipe(
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

    return this.http
      .get<PortfolioHoldingsResponse>('/api/v1/portfolio/holdings', {
        params
      })
      .pipe(
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

    return this.http
      .get<any>(`/api/v2/portfolio/performance`, {
        params
      })
      .pipe(
        map((response) => {
          if (response.firstOrderDate) {
            response.firstOrderDate = parseISO(response.firstOrderDate);
          }

          return response;
        })
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

  public updateInfo() {
    this.http.get<InfoItem>('/api/v1/info').subscribe((info) => {
      const utmSource = window.localStorage.getItem('utm_source') as
        | 'ios'
        | 'trusted-web-activity';

      info.globalPermissions = filterGlobalPermissions(
        info.globalPermissions,
        utmSource
      );

      (window as any).info = info;
    });
  }
}
