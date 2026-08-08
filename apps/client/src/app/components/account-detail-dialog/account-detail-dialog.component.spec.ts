import { DashboardIntentService } from '@ghostfolio/client/core/dashboard-intent.service';
import { UserService } from '@ghostfolio/client/services/user/user.service';
import { DashboardModuleType } from '@ghostfolio/common/dashboard';
import { Activity } from '@ghostfolio/common/interfaces';
import { GfActivitiesTableComponent } from '@ghostfolio/ui/activities-table';
import { NotificationService } from '@ghostfolio/ui/notifications';
import { DataService } from '@ghostfolio/ui/services';

import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { Router } from '@angular/router';
import { BehaviorSubject, of } from 'rxjs';

import { GfAccountDetailDialogComponent } from './account-detail-dialog.component';

/**
 * The reveal-then-merge sequence, which is how a dialog hands work to a module
 * that has no address of its own.
 *
 * Cloning or editing an activity from inside this dialog is two things rather than
 * a navigation: an intent asks the canvas to surface the activities module, and
 * the payload is *merged* onto the current route so the module's own
 * query-parameter handler opens the right form.
 *
 * Three properties make that work, and each is asserted here because each fails
 * silently on its own.
 *
 * `queryParamsHandling: 'merge'` is required, not incidental. These parameters
 * arrive while the account dialog's own parameters are still on the URL; replacing
 * them would erase the state the surrounding shell is mid-way through reading.
 *
 * The command array must stay empty. That is what makes the write
 * route-agnostic, and therefore independent of what the route table holds.
 *
 * The dialog must close. Left open, it would cover the very module the intent just
 * asked to be revealed.
 */
describe('GfAccountDetailDialogComponent', () => {
  let dialogRefMock: { close: jest.Mock };
  let fixture: ComponentFixture<GfAccountDetailDialogComponent>;

  /** Ordering between the intent, the URL write and the close. */
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

  const createComponent = async () => {
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

    await TestBed.configureTestingModule({
      imports: [GfAccountDetailDialogComponent],
      providers: [
        { provide: DashboardIntentService, useValue: dashboardIntentService },
        {
          provide: DataService,
          useValue: {
            fetchAccount: jest.fn(() => of({})),
            fetchAccountBalances: jest.fn(() => of({ balances: [] })),
            fetchActivities: jest.fn(() => of({ activities: [], count: 0 })),
            fetchPortfolioHoldings: jest.fn(() => of({ holdings: [] })),
            fetchPortfolioInvestments: jest.fn(() =>
              of({ investments: [], streaks: {} })
            ),
            fetchPortfolioPerformance: jest.fn(() =>
              of({ chart: [], errors: [], performance: {} })
            )
          }
        },
        {
          provide: MAT_DIALOG_DATA,
          useValue: {
            accountId: 'account-1',
            deviceType: 'desktop',
            hasImpersonationId: false,
            hasPermissionToCreateActivity: true
          }
        },
        { provide: MatDialogRef, useValue: dialogRefMock },
        // Reached by the real activities table, and by nothing this suite drives.
        // An unimplemented stub is therefore the stricter choice: a call throws
        // rather than passing unnoticed.
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
              user: { permissions: [], settings: { locale: 'en-GB' } }
            })
          }
        }
      ]
    })
      // Only the activities table is kept, because its outputs are what this suite
      // drives. Everything else - the investment chart above all, which wants a
      // real canvas - is left as an unrecognised element, which the component
      // tolerates because it declares `CUSTOM_ELEMENTS_SCHEMA`.
      .overrideComponent(GfAccountDetailDialogComponent, {
        set: { imports: [GfActivitiesTableComponent] }
      })
      .compileComponents();

    fixture = TestBed.createComponent(GfAccountDetailDialogComponent);

    fixture.detectChanges();

    return fixture.componentInstance;
  };

  /**
   * The activities table the dialog rendered.
   *
   * Emitting from the real child is what proves the outputs are bound. Reaching
   * into the dialog's own protected handlers would assert the bodies while leaving
   * an unbound output - the defect that made the empty-activity call to action
   * dead - completely invisible.
   */
  const activitiesTable = () => {
    const table = fixture.debugElement.query(
      (node) => node.componentInstance instanceof GfActivitiesTableComponent
    );

    // Asserted here, so a table that stopped rendering reports itself as a missing
    // table rather than as a missing intent.
    expect(table).not.toBeNull();

    return table.componentInstance as unknown as Record<
      string,
      { emit: (value: Activity) => void }
    >;
  };

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe.each([
    { dialogFlag: 'createDialog', handler: 'activityToClone' as const },
    { dialogFlag: 'editDialog', handler: 'activityToUpdate' as const }
  ])('handing $handler to the activities module', ({ dialogFlag, handler }) => {
    const emit = () => {
      activitiesTable()[handler].emit(activity);
    };

    it('reveals the activities module', async () => {
      await createComponent();

      emit();

      expect(revealedModules).toEqual([DashboardModuleType.ACTIVITIES]);
    });

    it('merges the payload onto the current route', async () => {
      await createComponent();

      emit();

      expect(navigations).toEqual([
        {
          commands: [],
          extras: {
            queryParams: {
              // This dialog's own hand-off keys are cleared in the same
              // navigation. Merging is what makes that necessary: leave them
              // standing and the accounts module reads its flag again the moment
              // the parameters change and reopens this dialog over the one being
              // asked for.
              accountDetailDialog: null,
              accountId: null,
              activityId: activity.id,
              // `createDialog` and `editDialog` are shared with other modules, so
              // the activities module refuses either unless it is named. Without
              // the discriminator the revealed module would open nothing.
              dialogModule: DashboardModuleType.ACTIVITIES,
              [dialogFlag]: true
            },
            queryParamsHandling: 'merge'
          }
        }
      ]);
    });

    it('closes itself so the revealed module is not covered', async () => {
      await createComponent();

      emit();

      expect(dialogRefMock.close).toHaveBeenCalledTimes(1);
    });

    it('reveals and writes before closing', async () => {
      await createComponent();

      emit();

      expect(callOrder).toEqual(['reveal', 'navigate', 'close']);
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
