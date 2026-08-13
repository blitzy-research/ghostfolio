import { DashboardIntentService } from '@ghostfolio/client/core/dashboard-intent.service';
import { ImpersonationStorageService } from '@ghostfolio/client/services/impersonation-storage.service';
import { UserService } from '@ghostfolio/client/services/user/user.service';
import { DashboardModuleType } from '@ghostfolio/common/dashboard';
import { permissions } from '@ghostfolio/common/permissions';
import { DataService } from '@ghostfolio/ui/services';

import { CommonModule } from '@angular/common';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router } from '@angular/router';
import { DeviceDetectorService } from 'ngx-device-detector';
import { BehaviorSubject, of } from 'rxjs';

import { GfHomeHoldingsComponent } from './home-holdings.component';

/**
 * The two kinds of cross-module request this component makes, neither of which
 * has a screen to depart to.
 *
 * They are deliberately different mechanisms and the distinction is the point of
 * this suite. Managing activities is a *module* destination: nothing is carried,
 * so it becomes a reveal-module intent and produces no URL change at all. Opening
 * a holding is a *dialog* destination: it carries a payload, so it stays a query
 * parameter write on the current route - a route-agnostic convention that holds on
 * a single-route table, because `navigate([])` names no route to begin with.
 *
 * Conflating the two is the failure this guards against. Turning the holding
 * dialog into an intent would silently drop the identifier and open nothing;
 * turning the activities intent into a navigation would put a parameter on the
 * URL that no handler reads.
 */
describe('GfHomeHoldingsComponent', () => {
  let fixture: ComponentFixture<GfHomeHoldingsComponent>;

  /** Every navigation requested, recorded with its real types. */
  let navigations: {
    commands: unknown[];
    extras: {
      queryParams?: Record<string, unknown>;
      queryParamsHandling?: string;
    };
  }[];

  /** Every intent published, in order. */
  let revealedModules: DashboardModuleType[];

  const createComponent = async () => {
    navigations = [];
    revealedModules = [];

    const dashboardIntentService = new DashboardIntentService();

    dashboardIntentService.revealModule$.subscribe((moduleType) => {
      revealedModules.push(moduleType);
    });

    const routerMock = {
      navigate: jest.fn(
        (
          commands: unknown[],
          extras: {
            queryParams?: Record<string, unknown>;
            queryParamsHandling?: string;
          } = {}
        ) => {
          navigations.push({ commands, extras });

          return Promise.resolve(true);
        }
      )
    };

    await TestBed.configureTestingModule({
      imports: [GfHomeHoldingsComponent],
      providers: [
        // Reached because the holding-detail request is now merged relative to the
        // current route rather than replacing the whole query map. Only the snapshot
        // identity is used, so a bare object is a faithful stand-in.
        { provide: ActivatedRoute, useValue: { queryParams: of({}) } },
        { provide: DashboardIntentService, useValue: dashboardIntentService },
        {
          provide: DataService,
          useValue: {
            fetchPortfolioHoldings: jest.fn(() => of({ holdings: [] })),
            putUserSetting: jest.fn(() => of({}))
          }
        },
        {
          provide: DeviceDetectorService,
          useValue: { getDeviceInfo: () => ({ deviceType: 'desktop' }) }
        },
        {
          provide: ImpersonationStorageService,
          useValue: { onChangeHasImpersonation: () => of(null) }
        },
        { provide: Router, useValue: routerMock },
        {
          provide: UserService,
          useValue: {
            get: jest.fn(() => of({})),
            getFilters: jest.fn(() => []),
            stateChanged: new BehaviorSubject({
              user: {
                permissions: [permissions.createActivity],
                settings: { baseCurrency: 'CHF', locale: 'en-GB' }
              }
            })
          }
        }
      ]
    })
      // The holdings table and the treemap chart render nothing this suite reads,
      // and the chart would need a canvas. Their elements carry a dash, so the
      // component's `CUSTOM_ELEMENTS_SCHEMA` tolerates them unrecognised.
      // `CommonModule` is kept because the view containers bind `ngClass` on plain
      // `<div>` elements, which that schema does not excuse - stripping it reports
      // NG0303 on every render.
      .overrideComponent(GfHomeHoldingsComponent, {
        set: { imports: [CommonModule] }
      })
      .compileComponents();

    fixture = TestBed.createComponent(GfHomeHoldingsComponent);

    fixture.detectChanges();

    return fixture.componentInstance;
  };

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('managing activities', () => {
    it('reveals the activities module', async () => {
      const component = await createComponent();

      component.onManageActivities();

      expect(revealedModules).toEqual([DashboardModuleType.ACTIVITIES]);
    });

    it('changes no URL, because nothing is carried', async () => {
      const component = await createComponent();

      component.onManageActivities();

      // A navigation here would be a parameter no handler reads.
      expect(navigations).toEqual([]);
    });
  });

  describe('opening a holding', () => {
    it('requests the dialog on the current route with the full identifier', async () => {
      const component = await createComponent();

      component.onHoldingClicked({ dataSource: 'YAHOO', symbol: 'AAPL' });

      expect(navigations).toHaveLength(1);
      expect(navigations[0].commands).toEqual([]);

      // Merged, so that opening this dialog cannot discard what the rest of the
      // canvas put on the URL - a sibling module's open dialog, the
      // shared-portfolio access identifier, the sign-in token hand-off.
      expect(navigations[0].extras.queryParamsHandling).toBe('merge');

      // Merging is what makes the two nulls necessary. `dataSource` and `symbol`
      // are shared identifiers: three flags read that same pair, the other two
      // belonging to the market data administration module and to the benchmark
      // table. Leaving either up would re-point *their* dialog at this holding
      // rather than merely leaving it alone.
      expect(navigations[0].extras.queryParams).toEqual({
        assetProfileDialog: null,
        benchmarkDetailDialog: null,
        dataSource: 'YAHOO',
        holdingDetailDialog: true,
        symbol: 'AAPL'
      });
    });

    it('names no route, so the request survives the single-route collapse', async () => {
      const component = await createComponent();

      component.onHoldingClicked({ dataSource: 'YAHOO', symbol: 'AAPL' });

      // The empty command array is the whole mechanism: it addresses whatever
      // route is current, which on this application is always the canvas.
      expect(navigations[0].commands).toEqual([]);
    });

    it('publishes no intent, because a dialog is not a module', async () => {
      const component = await createComponent();

      component.onHoldingClicked({ dataSource: 'YAHOO', symbol: 'AAPL' });

      expect(revealedModules).toEqual([]);
    });

    it.each([
      { dataSource: undefined, description: 'the data source is missing' },
      { description: 'the symbol is missing', symbol: undefined }
    ])('asks for nothing when $description', async (identifier) => {
      const component = await createComponent();

      component.onHoldingClicked({
        dataSource: 'YAHOO',
        symbol: 'AAPL',
        ...identifier
      });

      // An incomplete identifier would open a dialog that cannot resolve what it
      // is meant to show.
      expect(navigations).toEqual([]);
      expect(revealedModules).toEqual([]);
    });
  });
});
