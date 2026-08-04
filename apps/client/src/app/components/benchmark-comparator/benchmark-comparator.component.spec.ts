import { DashboardIntentService } from '@ghostfolio/client/core/dashboard-intent.service';
import { DashboardModuleType } from '@ghostfolio/common/dashboard';

import { TestBed } from '@angular/core/testing';

import { GfBenchmarkComparatorComponent } from './benchmark-comparator.component';

/**
 * The one cross-module destination this comparator offers, and the fact that it
 * needs nothing but the intent bus to offer it.
 *
 * Choosing "Manage Benchmarks" used to navigate to the admin market data screen.
 * It now publishes a reveal-module intent, and the discriminator matters: the
 * activities module is the one every other producer in this refactor reveals, so
 * `ADMIN_MARKET_DATA` is the odd one out and the easiest to get wrong by copying
 * a neighbour.
 *
 * The suite also pins what this component is *not* injected with. It takes a single
 * constructor dependency - the intent bus - and no `Router`, no registry and no
 * canvas. Constructing it through a `TestBed` that provides only the bus is
 * therefore itself an assertion: acquiring a router here would fail to resolve,
 * which is what keeps a reveal from quietly becoming a navigation again.
 */
describe('GfBenchmarkComparatorComponent', () => {
  let component: GfBenchmarkComparatorComponent;

  /** Every intent published, in order. */
  let revealedModules: DashboardModuleType[];

  beforeEach(() => {
    revealedModules = [];

    const dashboardIntentService = new DashboardIntentService();

    dashboardIntentService.revealModule$.subscribe((moduleType) => {
      revealedModules.push(moduleType);
    });

    TestBed.configureTestingModule({
      providers: [
        GfBenchmarkComparatorComponent,
        { provide: DashboardIntentService, useValue: dashboardIntentService }
      ]
    });

    // Resolved as a provider rather than rendered: the template's trigger sits
    // inside a `mat-select` overlay, and the chart this component owns wants a real
    // canvas. Neither is what the intent depends on.
    component = TestBed.inject(GfBenchmarkComparatorComponent);
  });

  afterEach(() => {
    component.ngOnDestroy();

    jest.restoreAllMocks();
  });

  it('reveals the market data module', () => {
    component.onOpenAdminMarketData();

    expect(revealedModules).toEqual([DashboardModuleType.ADMIN_MARKET_DATA]);
  });

  it('reveals the market data module and not the activities module', () => {
    component.onOpenAdminMarketData();

    // Stated explicitly because every other producer in this refactor reveals the
    // activities module, which makes this the entry most likely to be copied wrong.
    expect(revealedModules).not.toContain(DashboardModuleType.ACTIVITIES);
  });

  it('publishes nothing until the viewer acts', () => {
    expect(revealedModules).toEqual([]);
  });

  it('publishes one intent per activation', () => {
    component.onOpenAdminMarketData();
    component.onOpenAdminMarketData();

    expect(revealedModules).toEqual([
      DashboardModuleType.ADMIN_MARKET_DATA,
      DashboardModuleType.ADMIN_MARKET_DATA
    ]);
  });

  it('constructs with the intent bus as its only dependency', () => {
    // Nothing else is provided in this suite, so the component resolving at all is
    // the assertion: it holds no router, no registry and no canvas reference.
    expect(component).toBeInstanceOf(GfBenchmarkComparatorComponent);
  });
});
