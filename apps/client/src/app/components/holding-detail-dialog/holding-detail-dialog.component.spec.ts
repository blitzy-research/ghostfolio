import { DashboardIntentService } from '@ghostfolio/client/core/dashboard-intent.service';
import { UserService } from '@ghostfolio/client/services/user/user.service';
import { DashboardModuleType } from '@ghostfolio/common/dashboard';
import { Activity } from '@ghostfolio/common/interfaces';
import { GfActivitiesTableComponent } from '@ghostfolio/ui/activities-table';
import { NotificationService } from '@ghostfolio/ui/notifications';
import { DataService } from '@ghostfolio/ui/services';
import { GfTagsSelectorComponent } from '@ghostfolio/ui/tags-selector';

import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ReactiveFormsModule } from '@angular/forms';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { Router } from '@angular/router';
import { BehaviorSubject, Observable, of } from 'rxjs';

import { GfHoldingDetailDialogComponent } from './holding-detail-dialog.component';

/**
 * The four cross-module departures this dialog makes, and the fact that they are
 * not all the same shape.
 *
 * Three of them - cloning an activity, editing one, and opening the asset profile
 * - pair a reveal-module intent with a merged query-parameter write, because each
 * carries a payload the destination module has to act on. The fourth, closing a
 * holding, is deliberately different: the navigation it replaced carried nothing,
 * so revealing the activities module *is* the entire intent and no parameter is
 * produced. Adding one would put a key on the URL that no handler reads; omitting
 * one from the other three would surface a module with nothing to open.
 *
 * Closing a holding also has a sequencing requirement the others do not: it posts
 * an activity first and must only reveal the module once that write has succeeded.
 * Revealing eagerly would surface an activities module that does not yet contain
 * the activity the user just created, which reads as a lost write.
 *
 * Two of the four destinations are also permission-gated in the template. That
 * gating is what replaced the deleted header's admin check, so it is asserted here
 * rather than assumed - a UI-exposure regression, since the API keeps enforcing
 * the permission independently either way.
 */
describe('GfHoldingDetailDialogComponent', () => {
  const holding = { dataSource: 'YAHOO', symbol: 'AAPL' };

  let dialogRefMock: { close: jest.Mock };
  let fixture: ComponentFixture<GfHoldingDetailDialogComponent>;
  let postActivity: () => Observable<unknown>;

  /** Ordering between the write, the intent, the URL write and the close. */
  let callOrder: string[];

  let navigations: {
    commands: unknown[];
    extras: {
      queryParams?: Record<string, unknown>;
      queryParamsHandling?: string;
    };
  }[];

  let revealedModules: DashboardModuleType[];

  const activity = { id: 'activity-1' } as Activity;

  const createComponent = async ({
    hasPermissionToAccessAdminControl = true,
    hasPermissionToCreateActivity = true,
    postActivityResponse = of({})
  }: {
    hasPermissionToAccessAdminControl?: boolean;
    hasPermissionToCreateActivity?: boolean;
    postActivityResponse?: Observable<unknown>;
  } = {}) => {
    callOrder = [];
    navigations = [];
    revealedModules = [];

    const dashboardIntentService = new DashboardIntentService();

    dashboardIntentService.revealModule$.subscribe((moduleType) => {
      callOrder.push('reveal');
      revealedModules.push(moduleType);
    });

    dialogRefMock = {
      close: jest.fn(() => {
        callOrder.push('close');
      })
    };

    postActivity = () => {
      callOrder.push('postActivity');

      return postActivityResponse;
    };

    await TestBed.configureTestingModule({
      imports: [GfHoldingDetailDialogComponent],
      providers: [
        { provide: DashboardIntentService, useValue: dashboardIntentService },
        {
          provide: DataService,
          useValue: {
            fetchAccounts: jest.fn(() =>
              of({ accounts: [{ id: 'account-1' }] })
            ),
            fetchActivities: jest.fn(() => of({ activities: [] })),
            fetchHoldingDetail: jest.fn(() =>
              of({
                activitiesCount: 1,
                averagePrice: 100,
                dataProviderInfo: {},
                dateOfFirstActivity: '2024-01-01',
                dividendInBaseCurrency: 0,
                dividendYieldPercentWithCurrencyEffect: 0,
                feeInBaseCurrency: 0,
                historicalData: [],
                investmentInBaseCurrencyWithCurrencyEffect: 100,
                marketPrice: 120,
                marketPriceMax: 130,
                marketPriceMin: 90,
                netPerformance: 20,
                netPerformancePercent: 0.2,
                netPerformancePercentWithCurrencyEffect: 0.2,
                netPerformanceWithCurrencyEffect: 20,
                // A non-zero quantity is what makes the close-holding action
                // available in the template.
                quantity: 1,
                SymbolProfile: {
                  currency: 'USD',
                  dataSource: holding.dataSource,
                  symbol: holding.symbol
                },
                tags: []
              })
            ),
            fetchMarketDataBySymbol: jest.fn(() => of({ marketData: [] })),
            postActivity: () => postActivity()
          }
        },
        {
          provide: MAT_DIALOG_DATA,
          useValue: {
            baseCurrency: 'CHF',
            colorScheme: 'LIGHT',
            dataSource: holding.dataSource,
            deviceType: 'desktop',
            hasImpersonationId: false,
            hasPermissionToAccessAdminControl,
            hasPermissionToCreateActivity,
            hasPermissionToReportDataGlitch: false,
            hasPermissionToUpdateActivity: true,
            locale: 'en-GB',
            symbol: holding.symbol
          }
        },
        { provide: MatDialogRef, useValue: dialogRefMock },
        // Reached by the real activities table, and by nothing this suite drives.
        { provide: NotificationService, useValue: {} },
        {
          provide: Router,
          useValue: {
            navigate: jest.fn(
              (
                commands: unknown[],
                extras: {
                  queryParams?: Record<string, unknown>;
                  queryParamsHandling?: string;
                } = {}
              ) => {
                callOrder.push('navigate');
                navigations.push({ commands, extras });

                return Promise.resolve(true);
              }
            )
          }
        },
        {
          provide: UserService,
          useValue: {
            stateChanged: new BehaviorSubject({
              user: {
                id: 'user-1',
                permissions: [],
                settings: { locale: 'en-GB' }
              }
            })
          }
        }
      ]
    })
      // Kept deliberately, and only these three. The activities table because its
      // outputs are driven below. `ReactiveFormsModule` because the tag form's
      // `[formGroup]` is a binding on a plain `<form>`, which
      // `CUSTOM_ELEMENTS_SCHEMA` does not excuse for a standard element - stripping
      // it reports NG0303 on every render. And the tags selector because it is the
      // control value accessor that `formControlName` inside that form resolves to,
      // so admitting the form module without it trades NG0303 for NG01203.
      //
      // Everything else is stripped: the charts want a real canvas and contribute
      // nothing to an intent, and their elements carry a dash, so they are
      // tolerated unrecognised.
      .overrideComponent(GfHoldingDetailDialogComponent, {
        set: {
          imports: [
            GfActivitiesTableComponent,
            GfTagsSelectorComponent,
            ReactiveFormsModule
          ]
        }
      })
      .compileComponents();

    fixture = TestBed.createComponent(GfHoldingDetailDialogComponent);

    fixture.detectChanges();

    return fixture.componentInstance;
  };

  /** Emits one of the activities table's outputs, proving it is bound. */
  const emitFromActivitiesTable = (output: string) => {
    const table = fixture.debugElement.query(
      (node) => node.componentInstance instanceof GfActivitiesTableComponent
    );

    expect(table).not.toBeNull();

    (
      table.componentInstance as unknown as Record<
        string,
        { emit: (value: Activity) => void }
      >
    )[output].emit(activity);
  };

  /** A rendered action button whose label matches, or `undefined`. */
  const actionButton = (label: string) => {
    const buttons: HTMLButtonElement[] = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll(
        '.button-container button'
      )
    );

    return buttons.find((button) => button.textContent.trim().includes(label));
  };

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe.each([
    { dialogFlag: 'createDialog', output: 'activityToClone' },
    { dialogFlag: 'editDialog', output: 'activityToUpdate' }
  ])('handing $output to the activities module', ({ dialogFlag, output }) => {
    it('reveals the activities module', async () => {
      await createComponent();

      emitFromActivitiesTable(output);

      expect(revealedModules).toEqual([DashboardModuleType.ACTIVITIES]);
    });

    it('merges the payload onto the current route', async () => {
      await createComponent();

      emitFromActivitiesTable(output);

      expect(navigations).toEqual([
        {
          commands: [],
          extras: {
            queryParams: {
              activityId: activity.id,
              // This dialog's own hand-off keys go in the same navigation, which
              // merging makes necessary: left standing, the holdings module reads
              // them again on the next parameter change and reopens this dialog
              // over the activities dialog being asked for.
              dataSource: null,
              // `createDialog` and `editDialog` are shared with other modules, and
              // every consumer refuses a request that names none - so without the
              // discriminator the revealed module would open nothing at all.
              dialogModule: DashboardModuleType.ACTIVITIES,
              holdingDetailDialog: null,
              symbol: null,
              [dialogFlag]: true
            },
            queryParamsHandling: 'merge'
          }
        }
      ]);
    });

    it('reveals and writes before closing', async () => {
      await createComponent();

      emitFromActivitiesTable(output);

      expect(callOrder).toEqual(['reveal', 'navigate', 'close']);
    });
  });

  describe('opening the asset profile', () => {
    it('reveals the market data module and carries the identifier', async () => {
      await createComponent();

      actionButton('Asset Profile').click();

      expect(revealedModules).toEqual([DashboardModuleType.ADMIN_MARKET_DATA]);
      expect(navigations).toEqual([
        {
          commands: [],
          extras: {
            queryParams: {
              assetProfileDialog: true,
              // Kept rather than cleared, unlike the activities hand-off above:
              // these two identify the asset profile being asked for, not this
              // dialog. Only the flag that would reopen this dialog is dropped.
              dataSource: holding.dataSource,
              dialogModule: DashboardModuleType.ADMIN_MARKET_DATA,
              holdingDetailDialog: null,
              symbol: holding.symbol
            },
            queryParamsHandling: 'merge'
          }
        }
      ]);
    });

    it('is withheld from a viewer without the admin permission', async () => {
      await createComponent({ hasPermissionToAccessAdminControl: false });

      // This template gate is what replaced the deleted header's admin check.
      expect(actionButton('Asset Profile')).toBeUndefined();
    });
  });

  describe('closing a holding', () => {
    it('reveals the activities module without any query parameter', async () => {
      await createComponent();

      actionButton('Close').click();

      // The navigation this replaced carried nothing, so the intent is the whole
      // message and a parameter here would be one no handler reads.
      expect(revealedModules).toEqual([DashboardModuleType.ACTIVITIES]);
      expect(navigations).toEqual([]);
    });

    it('records the activity before revealing the module', async () => {
      await createComponent();

      actionButton('Close').click();

      // Revealing first would surface a module that does not yet contain the
      // activity just created, which reads to the user as a lost write.
      expect(callOrder).toEqual(['postActivity', 'reveal', 'close']);
    });

    it('is withheld from a viewer who cannot create activities', async () => {
      await createComponent({ hasPermissionToCreateActivity: false });

      expect(actionButton('Close')).toBeUndefined();
    });
  });

  describe('before the viewer acts', () => {
    it('publishes no intent and requests no navigation', async () => {
      await createComponent();

      expect(revealedModules).toEqual([]);
      expect(navigations).toEqual([]);
      expect(dialogRefMock.close).not.toHaveBeenCalled();
    });
  });
});
