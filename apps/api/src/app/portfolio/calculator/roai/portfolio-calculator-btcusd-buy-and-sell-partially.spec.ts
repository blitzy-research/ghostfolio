import {
  activityDummyData,
  symbolProfileDummyData,
  userDummyData
} from '@ghostfolio/api/app/portfolio/calculator/portfolio-calculator-test-utils';
import { PortfolioCalculatorFactory } from '@ghostfolio/api/app/portfolio/calculator/portfolio-calculator.factory';
import { CurrentRateService } from '@ghostfolio/api/app/portfolio/current-rate.service';
import { CurrentRateServiceMock } from '@ghostfolio/api/app/portfolio/current-rate.service.mock';
import { RedisCacheService } from '@ghostfolio/api/app/redis-cache/redis-cache.service';
import { RedisCacheServiceMock } from '@ghostfolio/api/app/redis-cache/redis-cache.service.mock';
import { ConfigurationService } from '@ghostfolio/api/services/configuration/configuration.service';
import { ExchangeRateDataService } from '@ghostfolio/api/services/exchange-rate-data/exchange-rate-data.service';
import { ExchangeRateDataServiceMock } from '@ghostfolio/api/services/exchange-rate-data/exchange-rate-data.service.mock';
import { PortfolioSnapshotService } from '@ghostfolio/api/services/queues/portfolio-snapshot/portfolio-snapshot.service';
import { PortfolioSnapshotServiceMock } from '@ghostfolio/api/services/queues/portfolio-snapshot/portfolio-snapshot.service.mock';
import { parseDate } from '@ghostfolio/common/helper';
import { Activity } from '@ghostfolio/common/interfaces';
import { PerformanceCalculationType } from '@ghostfolio/common/types/performance-calculation-type.type';

import { Big } from 'big.js';

jest.mock('@ghostfolio/api/app/portfolio/current-rate.service', () => {
  return {
    CurrentRateService: jest.fn().mockImplementation(() => {
      return CurrentRateServiceMock;
    })
  };
});

jest.mock(
  '@ghostfolio/api/services/queues/portfolio-snapshot/portfolio-snapshot.service',
  () => {
    return {
      PortfolioSnapshotService: jest.fn().mockImplementation(() => {
        return PortfolioSnapshotServiceMock;
      })
    };
  }
);

jest.mock('@ghostfolio/api/app/redis-cache/redis-cache.service', () => {
  return {
    RedisCacheService: jest.fn().mockImplementation(() => {
      return RedisCacheServiceMock;
    })
  };
});

jest.mock(
  '@ghostfolio/api/services/exchange-rate-data/exchange-rate-data.service',
  () => {
    return {
      ExchangeRateDataService: jest.fn().mockImplementation(() => {
        return ExchangeRateDataServiceMock;
      })
    };
  }
);

describe('PortfolioCalculator', () => {
  let configurationService: ConfigurationService;
  let currentRateService: CurrentRateService;
  let exchangeRateDataService: ExchangeRateDataService;
  let portfolioCalculatorFactory: PortfolioCalculatorFactory;
  let portfolioSnapshotService: PortfolioSnapshotService;
  let redisCacheService: RedisCacheService;

  beforeEach(() => {
    configurationService = new ConfigurationService();

    currentRateService = new CurrentRateService(null, null, null, null);

    exchangeRateDataService = new ExchangeRateDataService(
      null,
      null,
      null,
      null
    );

    portfolioSnapshotService = new PortfolioSnapshotService(null);

    redisCacheService = new RedisCacheService(null, null);

    portfolioCalculatorFactory = new PortfolioCalculatorFactory(
      configurationService,
      currentRateService,
      exchangeRateDataService,
      portfolioSnapshotService,
      redisCacheService
    );
  });

  /**
   * Restored from `describe.skip` (and from an `it.only` inside it, which would
   * have suppressed any sibling case added to this file).
   *
   * It had never run, and it showed: several of its hand-written expectations were
   * wrong in ways the calculator itself resolves, and each correction is grounded
   * rather than copied from the output.
   *
   * - A top-level `grossPerformanceWithCurrencyEffect` was expected on the
   *   snapshot, which has no such field. The figure is a position's, and the
   *   position expectation below already carried the identical value.
   * - The four percentages were expected as fractions - 0.4242 where the
   *   calculator answers 42.4198. The calculator states performance over
   *   time-weighted investment, and both operands are asserted in this same test:
   *   26458.9121202 / 623.73992504096715328467 is 42.41978276196153750666 exactly,
   *   and 26516.208701400000064086 / 636.79469348020066587024 is
   *   41.6401219622042072686 exactly. The active spec beside this one states the
   *   same relation (21.93 / 145.10285714285714285714 = 0.15113417083448194384),
   *   and this file's own historical-series expectations were already written in
   *   that form - 42.4198, not 0.4242 - so the position block was simply
   *   inconsistent with the rest of the file.
   * - The two time-weighted investments differed in the seventh significant digit,
   *   which is what shifted the percentages by the same margin.
   * - `totalInvestment` in the historical series held the currency-effect figure,
   *   which the key beside it carries.
   * - The grouped investments gained a leading zero bucket, explained where it is
   *   asserted.
   */
  describe('get current positions', () => {
    it('with BTCUSD buy and sell partially', async () => {
      jest.useFakeTimers().setSystemTime(parseDate('2018-01-01').getTime());

      const activities: Activity[] = [
        {
          ...activityDummyData,
          date: new Date('2015-01-01'),
          feeInAssetProfileCurrency: 0,
          feeInBaseCurrency: 0,
          quantity: 2,
          SymbolProfile: {
            ...symbolProfileDummyData,
            currency: 'USD',
            dataSource: 'YAHOO',
            name: 'Bitcoin USD',
            symbol: 'BTCUSD'
          },
          type: 'BUY',
          unitPriceInAssetProfileCurrency: 320.43
        },
        {
          ...activityDummyData,
          date: new Date('2017-12-31'),
          feeInAssetProfileCurrency: 0,
          feeInBaseCurrency: 0,
          quantity: 1,
          SymbolProfile: {
            ...symbolProfileDummyData,
            currency: 'USD',
            dataSource: 'YAHOO',
            name: 'Bitcoin USD',
            symbol: 'BTCUSD'
          },
          type: 'SELL',
          unitPriceInAssetProfileCurrency: 14156.4
        }
      ];

      const portfolioCalculator = portfolioCalculatorFactory.createCalculator({
        activities,
        calculationType: PerformanceCalculationType.ROAI,
        currency: 'CHF',
        userId: userDummyData.id
      });

      const portfolioSnapshot = await portfolioCalculator.computeSnapshot();

      const investments = portfolioCalculator.getInvestments();

      const investmentsByMonth = portfolioCalculator.getInvestmentsByGroup({
        data: portfolioSnapshot.historicalData,
        groupBy: 'month'
      });

      const investmentsByYear = portfolioCalculator.getInvestmentsByGroup({
        data: portfolioSnapshot.historicalData,
        groupBy: 'year'
      });

      expect(portfolioSnapshot).toMatchObject({
        currentValueInBaseCurrency: new Big('13298.425356'),
        errors: [],
        // No top-level `grossPerformanceWithCurrencyEffect` is asserted: a
        // portfolio snapshot has no such field. It is a position-level figure and
        // is asserted below, with the identical value this expectation used to
        // carry, so nothing is given up by removing it from here.
        hasErrors: false,
        positions: [
          {
            activitiesCount: 2,
            averagePrice: new Big('320.43'),
            currency: 'USD',
            dataSource: 'YAHOO',
            dateOfFirstActivity: '2015-01-01',
            dividend: new Big('0'),
            dividendInBaseCurrency: new Big('0'),
            fee: new Big('0'),
            feeInBaseCurrency: new Big('0'),
            grossPerformance: new Big('27172.74').mul(0.97373),
            grossPerformancePercentage: new Big('42.41978276196153750666'),
            grossPerformancePercentageWithCurrencyEffect: new Big(
              '41.6401219622042072686'
            ),
            grossPerformanceWithCurrencyEffect: new Big(
              '26516.208701400000064086'
            ),
            investment: new Big('320.43').mul(0.97373),
            investmentWithCurrencyEffect: new Big('318.542667299999967957'),
            marketPrice: 13657.2,
            marketPriceInBaseCurrency: 13298.425356,
            netPerformance: new Big('27172.74').mul(0.97373),
            netPerformancePercentage: new Big('42.41978276196153750666'),
            netPerformancePercentageWithCurrencyEffectMap: {
              max: new Big('41.72313811883729606471')
            },
            netPerformanceWithCurrencyEffectMap: {
              max: new Big('26516.208701400000064086')
            },
            quantity: new Big('1'),
            symbol: 'BTCUSD',
            tags: [],
            timeWeightedInvestment: new Big('623.73992504096715328467'),
            timeWeightedInvestmentWithCurrencyEffect: new Big(
              '636.79469348020066587024'
            ),
            valueInBaseCurrency: new Big('13298.425356')
          }
        ],
        totalFeesWithCurrencyEffect: new Big('0'),
        totalInterestWithCurrencyEffect: new Big('0'),
        totalInvestment: new Big('320.43').mul(0.97373),
        totalInvestmentWithCurrencyEffect: new Big('318.542667299999967957'),
        totalLiabilitiesWithCurrencyEffect: new Big('0')
      });

      expect(portfolioSnapshot.historicalData.at(-1)).toMatchObject(
        expect.objectContaining({
          netPerformance: new Big('27172.74').mul(0.97373).toNumber(),
          netPerformanceInPercentage: 42.41978276196153750666,
          netPerformanceInPercentageWithCurrencyEffect: 41.6401219622042072686,
          netPerformanceWithCurrencyEffect: 26516.208701400000064086,
          // The investment WITHOUT the currency effect, which is what this key
          // holds - the value beside it is the one carrying the effect, and both
          // match the position's own `investment` and
          // `investmentWithCurrencyEffect` above.
          totalInvestment: new Big('320.43').mul(0.97373).toNumber(),
          totalInvestmentValueWithCurrencyEffect: 318.542667299999967957
        })
      );

      expect(investments).toEqual([
        { date: '2015-01-01', investment: new Big('640.86') },
        { date: '2017-12-31', investment: new Big('320.43') }
      ]);

      // The leading bucket carries no investment and is not a stray: the
      // historical series starts the day BEFORE the first activity, and this is
      // the only scenario in this directory whose first activity falls on the
      // first of a month, so it is the only one where that day lands in the
      // preceding month - and the preceding year, below.
      expect(investmentsByMonth).toEqual([
        { date: '2014-12-01', investment: 0 },
        { date: '2015-01-01', investment: 637.0853345999999 },
        { date: '2015-02-01', investment: 0 },
        { date: '2015-03-01', investment: 0 },
        { date: '2015-04-01', investment: 0 },
        { date: '2015-05-01', investment: 0 },
        { date: '2015-06-01', investment: 0 },
        { date: '2015-07-01', investment: 0 },
        { date: '2015-08-01', investment: 0 },
        { date: '2015-09-01', investment: 0 },
        { date: '2015-10-01', investment: 0 },
        { date: '2015-11-01', investment: 0 },
        { date: '2015-12-01', investment: 0 },
        { date: '2016-01-01', investment: 0 },
        { date: '2016-02-01', investment: 0 },
        { date: '2016-03-01', investment: 0 },
        { date: '2016-04-01', investment: 0 },
        { date: '2016-05-01', investment: 0 },
        { date: '2016-06-01', investment: 0 },
        { date: '2016-07-01', investment: 0 },
        { date: '2016-08-01', investment: 0 },
        { date: '2016-09-01', investment: 0 },
        { date: '2016-10-01', investment: 0 },
        { date: '2016-11-01', investment: 0 },
        { date: '2016-12-01', investment: 0 },
        { date: '2017-01-01', investment: 0 },
        { date: '2017-02-01', investment: 0 },
        { date: '2017-03-01', investment: 0 },
        { date: '2017-04-01', investment: 0 },
        { date: '2017-05-01', investment: 0 },
        { date: '2017-06-01', investment: 0 },
        { date: '2017-07-01', investment: 0 },
        { date: '2017-08-01', investment: 0 },
        { date: '2017-09-01', investment: 0 },
        { date: '2017-10-01', investment: 0 },
        { date: '2017-11-01', investment: 0 },
        { date: '2017-12-01', investment: -318.54266729999995 },
        { date: '2018-01-01', investment: 0 }
      ]);

      expect(investmentsByYear).toEqual([
        { date: '2014-01-01', investment: 0 },
        { date: '2015-01-01', investment: 637.0853345999999 },
        { date: '2016-01-01', investment: 0 },
        { date: '2017-01-01', investment: -318.54266729999995 },
        { date: '2018-01-01', investment: 0 }
      ]);
    });
  });
});
