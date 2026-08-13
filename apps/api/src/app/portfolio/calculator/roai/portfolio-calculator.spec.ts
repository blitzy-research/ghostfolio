import { userDummyData } from '@ghostfolio/api/app/portfolio/calculator/portfolio-calculator-test-utils';
import { PortfolioCalculatorFactory } from '@ghostfolio/api/app/portfolio/calculator/portfolio-calculator.factory';
import { PerformanceCalculationType } from '@ghostfolio/common/types/performance-calculation-type.type';

import { MwrPortfolioCalculator } from '../mwr/portfolio-calculator';
import { RoiPortfolioCalculator } from '../roi/portfolio-calculator';
import { TwrPortfolioCalculator } from '../twr/portfolio-calculator';
import { RoaiPortfolioCalculator } from './portfolio-calculator';

/**
 * Which calculator a requested performance calculation gets, and what that
 * calculator afterwards says it is.
 *
 * This file previously held a single skipped no-op (`test.skip('Skip empty test',
 * () => 1)`), a leftover of the split into the per-scenario specs beside it. It
 * asserted nothing, covered nothing, and its only effect was a permanently skipped
 * test in every run - which reads as coverage that exists and does not.
 *
 * What it asserts now is the one thing the twenty scenario specs cannot: that the
 * four calculators are told apart. Each scenario spec exercises a single
 * calculation type in depth; none of them checks that asking for a different type
 * produces a different calculator, or that a calculator reports the type it
 * actually implements. That second half is not cosmetic - the reported type is
 * what scopes the calculator's cached snapshot (it is passed to
 * `RedisCacheService.getPortfolioSnapshotKey`), so two calculators agreeing on a
 * type would let one calculation's result be served for another, for the same user
 * and the same activities, with nothing in the output to show for it.
 *
 * Deliberately free of financial assertions. The arithmetic belongs to the
 * scenario specs, and this file needs no opinion about it: no activities are
 * supplied and no snapshot is computed, so nothing here can break when a
 * calculation changes.
 */
describe('PortfolioCalculator', () => {
  let portfolioCalculatorFactory: PortfolioCalculatorFactory;

  const createCalculator = (calculationType: PerformanceCalculationType) => {
    return portfolioCalculatorFactory.createCalculator({
      calculationType,
      activities: [],
      currency: 'CHF',
      userId: userDummyData.id
    });
  };

  /**
   * Reaches the type the calculator reports about itself, which is `protected`.
   *
   * Kept protected on purpose - it is an implementation detail for the base class,
   * not API - so the cast is how a test observes it without widening the class's
   * surface for everyone else.
   */
  const getReportedCalculationType = (calculator: unknown) => {
    return (
      calculator as {
        getPerformanceCalculationType: () => PerformanceCalculationType;
      }
    ).getPerformanceCalculationType();
  };

  beforeEach(() => {
    // The services are never reached: the factory only forwards them to the
    // calculator, which stores them, and no snapshot is computed here.
    portfolioCalculatorFactory = new PortfolioCalculatorFactory(
      null,
      null,
      null,
      null,
      null
    );
  });

  describe.each([
    {
      calculationType: PerformanceCalculationType.MWR,
      expectedCalculator: MwrPortfolioCalculator
    },
    {
      calculationType: PerformanceCalculationType.ROAI,
      expectedCalculator: RoaiPortfolioCalculator
    },
    {
      calculationType: PerformanceCalculationType.ROI,
      expectedCalculator: RoiPortfolioCalculator
    },
    {
      calculationType: PerformanceCalculationType.TWR,
      expectedCalculator: TwrPortfolioCalculator
    }
  ])(
    'with $calculationType requested',
    ({ calculationType, expectedCalculator }) => {
      it('creates the calculator that implements it', () => {
        expect(createCalculator(calculationType)).toBeInstanceOf(
          expectedCalculator
        );
      });

      it('creates a calculator that reports the requested type back', () => {
        // The round trip is the point: a calculator that answered with a
        // neighbour's type would read that neighbour's cached snapshot.
        expect(
          getReportedCalculationType(createCalculator(calculationType))
        ).toBe(calculationType);
      });
    }
  );

  it('gives every calculation type its own calculator and its own identity', () => {
    const calculationTypes = [
      PerformanceCalculationType.MWR,
      PerformanceCalculationType.ROAI,
      PerformanceCalculationType.ROI,
      PerformanceCalculationType.TWR
    ];

    const calculators = calculationTypes.map(createCalculator);

    const constructorNames = new Set(
      calculators.map(({ constructor }) => {
        return constructor.name;
      })
    );

    const reportedTypes = new Set(calculators.map(getReportedCalculationType));

    // Stated as counts rather than pairwise, so adding a fifth calculation type
    // that reuses an existing calculator or an existing identity fails here.
    expect(constructorNames.size).toBe(calculationTypes.length);
    expect(reportedTypes.size).toBe(calculationTypes.length);
  });

  it('refuses a calculation type it does not implement', () => {
    // A silent fallback to a default calculator would answer with numbers computed
    // by a method the caller did not ask for, which is worse than no answer.
    expect(() => {
      createCalculator('UNSUPPORTED' as PerformanceCalculationType);
    }).toThrow('Invalid calculation type');
  });
});
