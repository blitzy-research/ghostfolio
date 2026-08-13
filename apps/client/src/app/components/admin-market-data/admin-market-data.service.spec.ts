import { NotificationService } from '@ghostfolio/ui/notifications';
import { AdminService } from '@ghostfolio/ui/services';

import { TestBed } from '@angular/core/testing';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { AdminMarketDataService } from './admin-market-data.service';

/**
 * Whether an asset profile may be deleted, and the way that answer was reached wrongly.
 *
 * The predicate requires `watchedByCount` to be exactly zero, and one of its two call
 * sites did not pass it. That did not make the check lenient - it made the control DEAD:
 * the value arrived as `undefined`, `undefined === 0` is false, and the row-level Delete
 * item was therefore disabled on every row, for every profile, permanently. The selection
 * checkbox in the same table did pass it, which is why deleting worked in bulk and never
 * from the row, and why the cause was easy to miss.
 *
 * The strictness is kept rather than softened, and the template is corrected instead. A
 * missing count treated as zero would offer deletion of a profile somebody is watching on
 * the strength of a field nobody supplied, so failing closed is the right direction - it
 * just has to be visible when it happens, which is what these tests are for.
 */
describe('AdminMarketDataService', () => {
  let service: AdminMarketDataService;

  /** The table template as text, resolved from this spec's own location. */
  const template = readFileSync(
    join(__dirname, 'admin-market-data.html'),
    'utf8'
  );

  const createRow = (
    overrides: Record<string, unknown> = {}
  ): Parameters<
    AdminMarketDataService['hasPermissionToDeleteAssetProfile']
  >[0] => {
    return {
      activitiesCount: 0,
      isBenchmark: false,
      symbol: 'MY-ASSET',
      watchedByCount: 0,
      ...overrides
    } as Parameters<
      AdminMarketDataService['hasPermissionToDeleteAssetProfile']
    >[0];
  };

  beforeEach(() => {
    TestBed.resetTestingModule();

    TestBed.configureTestingModule({
      providers: [
        AdminMarketDataService,
        { provide: AdminService, useValue: {} },
        { provide: NotificationService, useValue: {} }
      ]
    });

    service = TestBed.inject(AdminMarketDataService);
  });

  describe('a profile nothing depends on', () => {
    it('may be deleted', () => {
      expect(service.hasPermissionToDeleteAssetProfile(createRow())).toBe(true);
    });
  });

  describe('a profile something depends on', () => {
    it.each([
      ['it has activities', { activitiesCount: 1 }],
      ['it is a benchmark', { isBenchmark: true }],
      ['somebody is watching it', { watchedByCount: 1 }],
      // The symbol is a currency PAIR, and the predicate reads it by stripping the
      // base currency: `USDGBP` leaves `GBP`, which is the root of the derived `GBp`.
      ['it is a root currency', { symbol: 'USDGBP' }],
      // `USDUSX` leaves `USX`, a derived currency.
      ['it is a derived currency', { symbol: 'USDUSX' }],
      ['it is a scraper symbol', { symbol: '_GF_MY_SCRAPER' }]
    ])('may not be deleted because %s', (_label, overrides) => {
      expect(
        service.hasPermissionToDeleteAssetProfile(createRow(overrides))
      ).toBe(false);
    });
  });

  describe('a caller that omits how many are watching', () => {
    it('is refused, rather than assumed to mean none', () => {
      // Failing closed is the safe direction: the alternative offers deletion of a
      // profile somebody is watching on the strength of a field nobody supplied.
      expect(
        service.hasPermissionToDeleteAssetProfile(
          createRow({ watchedByCount: undefined })
        )
      ).toBe(false);
    });
  });

  /**
   * Both call sites, checked against the template itself.
   *
   * A unit test of the predicate cannot catch this class of defect - the predicate was
   * always correct - so what has to be pinned is that every caller passes the field it
   * requires.
   */
  describe('every control that offers deletion', () => {
    it('passes how many are watching', () => {
      const callSites = template.match(
        /hasPermissionToDeleteAssetProfile\(\{[^}]*\}/g
      );

      expect(callSites).toHaveLength(2);

      for (const callSite of callSites) {
        expect(callSite).toContain('watchedByCount');
      }
    });

    it('passes every other field the predicate requires', () => {
      const callSites = template.match(
        /hasPermissionToDeleteAssetProfile\(\{[^}]*\}/g
      );

      for (const callSite of callSites) {
        expect(callSite).toContain('activitiesCount');
        expect(callSite).toContain('isBenchmark');
        expect(callSite).toContain('symbol');
      }
    });
  });
});
