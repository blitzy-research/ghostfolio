import type { PortfolioSummary } from '@ghostfolio/common/interfaces';
import { NotificationService } from '@ghostfolio/ui/notifications';

import { ComponentFixture, TestBed } from '@angular/core/testing';

import { GfPortfolioSummaryComponent } from './portfolio-summary.component';

/**
 * How the summary renders its numbers.
 *
 * Every figure on this screen is a number, so the way they are formatted *is* the
 * screen. Three defects are pinned here, and each of them showed the viewer something
 * that was not true of their portfolio:
 *
 * 1. **The precision latch.** Reduced precision was applied in one direction only. On a
 *    single canvas this module is never rebuilt - it outlives every filter, date range
 *    and impersonation switch that re-feeds it - so a total that crossed the threshold
 *    once left every currency row without decimal places for the rest of the session,
 *    including figures nowhere near the threshold that caused it.
 * 2. **A deduction sign in front of nothing.** Fees and liabilities are drawn as
 *    deductions, with the sign printed by the template rather than by the formatter. The
 *    condition matched zero exactly, so a portfolio with no fees and no liabilities read
 *    `- 0.00` on both rows.
 * 3. **One number rendered straight from the model.** The activity count was the only
 *    figure here not grouped for the locale, so it sat un-separated beside neighbours
 *    that were - and in a locale grouping differently, it was simply wrong.
 *
 * The sign assertions are made against rendered text, because that is where the defect
 * was visible and nowhere else. Inputs go through `setInput` so that `ngOnChanges` runs
 * and the view is marked, exactly as it is when a parent module re-feeds this screen.
 */
describe('GfPortfolioSummaryComponent', () => {
  let fixture: ComponentFixture<GfPortfolioSummaryComponent>;

  /** A summary carrying only the members the rows under test read. */
  const createSummary = (overrides: Partial<PortfolioSummary> = {}) => {
    return {
      activityCount: 12,
      fees: 0,
      liabilitiesInBaseCurrency: 0,
      totalValueInBaseCurrency: 1000,
      ...overrides
    } as PortfolioSummary;
  };

  const precision = () => fixture.componentInstance.precision;

  const formattedActivityCount = () => {
    return fixture.componentInstance.formattedActivityCount;
  };

  /** Sets inputs together and renders once. */
  const render = (inputs: Record<string, unknown>) => {
    for (const [name, value] of Object.entries(inputs)) {
      fixture.componentRef.setInput(name, value);
    }

    fixture.detectChanges();
  };

  /** The text of the row whose label begins with the given words. */
  const rowText = (label: string) => {
    return Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll('.row')
    )
      .map((row) => row.textContent.replace(/\s+/g, ' ').trim())
      .find((text) => text.startsWith(label));
  };

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [GfPortfolioSummaryComponent],
      providers: [{ provide: NotificationService, useValue: {} }]
    }).compileComponents();

    fixture = TestBed.createComponent(GfPortfolioSummaryComponent);

    render({
      baseCurrency: 'USD',
      locale: 'en-US',
      summary: createSummary()
    });
  });

  describe('the precision of the currency rows', () => {
    it('drops the decimal places for a large total on a phone', () => {
      render({
        deviceType: 'mobile',
        summary: createSummary({ totalValueInBaseCurrency: 1_000_000 })
      });

      expect(precision()).toBe(0);
    });

    it('restores them once the total no longer warrants it', () => {
      render({
        deviceType: 'mobile',
        summary: createSummary({ totalValueInBaseCurrency: 1_000_000 })
      });

      expect(precision()).toBe(0);

      // The change that used to be ignored. Nothing rebuilds this component when a
      // filter narrows the portfolio, so the only thing that can put the decimal
      // places back is this recalculation.
      render({ summary: createSummary({ totalValueInBaseCurrency: 4_200 }) });

      expect(precision()).toBe(2);
    });

    it('keeps them on a desktop whatever the total', () => {
      render({
        deviceType: 'desktop',
        summary: createSummary({ totalValueInBaseCurrency: 9_999_999 })
      });

      expect(precision()).toBe(2);
    });
  });

  describe('the deduction sign on the fees row', () => {
    it('is absent when there are no fees', () => {
      // The whole of the defect: a sign in front of a figure that deducts nothing.
      expect(rowText('Fees')).not.toContain('-');
      expect(rowText('Fees')).toContain('0.00');
    });

    it('is present when there are fees to deduct', () => {
      render({ summary: createSummary({ fees: 42.5 }) });

      expect(rowText('Fees')).toContain('- 42.50');
    });
  });

  describe('the deduction sign on the liabilities row', () => {
    it('is absent when there are no liabilities', () => {
      expect(rowText('Liabilities')).not.toContain('-');
      expect(rowText('Liabilities')).toContain('0.00');
    });

    it('is present when there are liabilities to deduct', () => {
      render({ summary: createSummary({ liabilitiesInBaseCurrency: 1234.5 }) });

      expect(rowText('Liabilities')).toContain('- 1,234.50');
    });

    it('does not sign a credit twice', () => {
      render({ summary: createSummary({ liabilitiesInBaseCurrency: -500 }) });

      // A negative liability already carries its own sign from the formatter. The
      // template must not add a second one in front of it.
      expect(rowText('Liabilities')).not.toContain('--');
      expect(rowText('Liabilities')).toContain('-500.00');
    });
  });

  describe('the activity count', () => {
    it('is grouped for the locale', () => {
      render({ summary: createSummary({ activityCount: 12345 }) });

      expect(formattedActivityCount()).toBe('12,345');
      expect(rowText('12,345')).toBeTruthy();
    });

    it('follows a locale that groups differently', () => {
      render({
        locale: 'de-DE',
        summary: createSummary({ activityCount: 12345 })
      });

      expect(formattedActivityCount()).toBe('12.345');
    });

    it('shows nothing at all when the count is withheld', () => {
      // Redacted for an impersonated viewer, and the row is hidden then. Rendering the
      // word "null" into it would be worse than rendering nothing.
      render({ summary: createSummary({ activityCount: null }) });

      expect(formattedActivityCount()).toBe('');
    });

    it('shows nothing before a summary has arrived', () => {
      render({ summary: undefined });

      expect(formattedActivityCount()).toBe('');
      expect(precision()).toBe(2);
    });
  });
});
