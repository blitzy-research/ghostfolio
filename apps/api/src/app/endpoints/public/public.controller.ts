import { AccessService } from '@ghostfolio/api/app/access/access.service';
import { ActivitiesService } from '@ghostfolio/api/app/activities/activities.service';
import { PortfolioService } from '@ghostfolio/api/app/portfolio/portfolio.service';
import { UserService } from '@ghostfolio/api/app/user/user.service';
import { RedactValuesInResponseInterceptor } from '@ghostfolio/api/interceptors/redact-values-in-response/redact-values-in-response.interceptor';
import { TransformDataSourceInResponseInterceptor } from '@ghostfolio/api/interceptors/transform-data-source-in-response/transform-data-source-in-response.interceptor';
import { ConfigurationService } from '@ghostfolio/api/services/configuration/configuration.service';
import { ExchangeRateDataService } from '@ghostfolio/api/services/exchange-rate-data/exchange-rate-data.service';
import { DEFAULT_CURRENCY } from '@ghostfolio/common/config';
import { SubscriptionType } from '@ghostfolio/common/enums';
import { getSum } from '@ghostfolio/common/helper';
import { PublicPortfolioResponse } from '@ghostfolio/common/interfaces';
import type { RequestWithUser } from '@ghostfolio/common/types';

import {
  Controller,
  Get,
  HttpException,
  Inject,
  Param,
  UseInterceptors
} from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { AccessPermission, Type as ActivityType } from '@prisma/client';
import { Big } from 'big.js';
import { StatusCodes, getReasonPhrase } from 'http-status-codes';

@Controller('public')
export class PublicController {
  public constructor(
    private readonly accessService: AccessService,
    private readonly activitiesService: ActivitiesService,
    private readonly configurationService: ConfigurationService,
    private readonly exchangeRateDataService: ExchangeRateDataService,
    private readonly portfolioService: PortfolioService,
    @Inject(REQUEST) private readonly request: RequestWithUser,
    private readonly userService: UserService
  ) {}

  @Get(':accessId/portfolio')
  @UseInterceptors(RedactValuesInResponseInterceptor)
  @UseInterceptors(TransformDataSourceInResponseInterceptor)
  public async getPublicPortfolio(
    @Param('accessId') accessId: string
  ): Promise<PublicPortfolioResponse> {
    const access = await this.accessService.access({ id: accessId });

    if (!access) {
      throw new HttpException(
        getReasonPhrase(StatusCodes.NOT_FOUND),
        StatusCodes.NOT_FOUND
      );
    }

    let hasDetails = true;

    const user = await this.userService.user({
      id: access.userId
    });

    if (this.configurationService.get('ENABLE_FEATURE_SUBSCRIPTION')) {
      hasDetails = user.subscription.type === SubscriptionType.Premium;
    }

    const [
      { createdAt, holdings, markets },
      { performance: performance1d },
      { performance: performanceMax },
      { performance: performanceYtd }
    ] = await Promise.all([
      this.portfolioService.getDetails({
        impersonationId: access.userId,
        userId: user.id,
        withMarkets: true
      }),
      ...['1d', 'max', 'ytd'].map((dateRange) => {
        return this.portfolioService.getPerformance({
          dateRange,
          impersonationId: undefined,
          userId: user.id
        });
      })
    ]);

    const { activities } = await this.activitiesService.getActivities({
      sortColumn: 'date',
      sortDirection: 'desc',
      take: 10,
      types: [ActivityType.BUY, ActivityType.SELL],
      userCurrency: user.settings?.settings.baseCurrency ?? DEFAULT_CURRENCY,
      userId: user.id,
      withExcludedAccountsAndActivities: false
    });

    // Whether this link was granted unrestricted read, which is what decides
    // below whether exact figures may leave the server.
    //
    // Consulted here rather than left to `RedactValuesInResponseInterceptor`,
    // which cannot help on this route: it decides from the *requesting* viewer
    // and the impersonation header, and this endpoint is public, so it sees no
    // viewer at all and redacts nothing. The capability is the only authority
    // present in the request, so the capability is what has to be read.
    const hasUnrestrictedReadPermission =
      access.permissions?.includes(AccessPermission.READ) ?? false;

    // Experimental
    const latestActivities = this.configurationService.get(
      'ENABLE_FEATURE_SUBSCRIPTION'
    )
      ? []
      : activities.map(
          ({
            currency,
            date,
            fee,
            quantity,
            SymbolProfile,
            type,
            unitPrice,
            value,
            valueInBaseCurrency
          }) => {
            // What a share link discloses is its own decision, made once, on the
            // server. A restricted link is meant to show *what* was traded and
            // when - which is the showcase the feature exists for - and not the
            // exact fee, quantity, unit price or value, which together reconstruct
            // the size of somebody's position and what they paid for it. Those are
            // the most sensitive numbers in the payload, and a default
            // `READ_RESTRICTED` link that carried them would disclose all of them
            // for the ten most recent trades.
            //
            // Redacted to `null` rather than omitted, deliberately: `null` is this
            // application's established redaction marker, which the value component
            // renders as `*****`, whereas an absent field is indistinguishable from
            // one still loading and would leave the table showing skeletons for
            // ever. The distinction visible to the recipient is therefore
            // "withheld", not "broken".
            const isDisclosable = hasUnrestrictedReadPermission;

            return {
              currency,
              date,
              SymbolProfile,
              type,
              fee: isDisclosable ? fee : null,
              quantity: isDisclosable ? quantity : null,
              unitPrice: isDisclosable ? unitPrice : null,
              value: isDisclosable ? value : null,
              valueInBaseCurrency: isDisclosable ? valueInBaseCurrency : null
            };
          }
        );

    Object.values(markets ?? {}).forEach((market) => {
      delete market.valueInBaseCurrency;
    });

    const publicPortfolioResponse: PublicPortfolioResponse = {
      createdAt,
      hasDetails,
      latestActivities,
      markets,
      alias: access.alias,
      holdings: {},
      performance: {
        '1d': {
          relativeChange:
            performance1d.netPerformancePercentageWithCurrencyEffect
        },
        max: {
          relativeChange:
            performanceMax.netPerformancePercentageWithCurrencyEffect
        },
        ytd: {
          relativeChange:
            performanceYtd.netPerformancePercentageWithCurrencyEffect
        }
      }
    };

    const totalValue = getSum(
      Object.values(holdings).map(({ currency, marketPrice, quantity }) => {
        return new Big(
          this.exchangeRateDataService.toCurrency(
            quantity * marketPrice,
            currency,
            this.request.user?.settings?.settings.baseCurrency ??
              DEFAULT_CURRENCY
          )
        );
      })
    ).toNumber();

    for (const [symbol, portfolioPosition] of Object.entries(holdings)) {
      publicPortfolioResponse.holdings[symbol] = {
        allocationInPercentage:
          portfolioPosition.valueInBaseCurrency / totalValue,
        assetClass: hasDetails ? portfolioPosition.assetClass : undefined,
        assetProfile: hasDetails ? portfolioPosition.assetProfile : undefined,
        countries: hasDetails ? portfolioPosition.countries : [],
        currency: hasDetails ? portfolioPosition.currency : undefined,
        dataSource: portfolioPosition.dataSource,
        dateOfFirstActivity: portfolioPosition.dateOfFirstActivity,
        markets: hasDetails ? portfolioPosition.markets : undefined,
        name: portfolioPosition.name,
        netPerformancePercentWithCurrencyEffect:
          portfolioPosition.netPerformancePercentWithCurrencyEffect,
        sectors: hasDetails ? portfolioPosition.sectors : [],
        symbol: portfolioPosition.symbol,
        url: portfolioPosition.url,
        valueInPercentage: portfolioPosition.valueInBaseCurrency / totalValue
      };
    }

    return publicPortfolioResponse;
  }
}
