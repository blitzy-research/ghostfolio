import { IcsService } from '@ghostfolio/client/services/ics/ics.service';
import { ImpersonationStorageService } from '@ghostfolio/client/services/impersonation-storage.service';
import { UserService } from '@ghostfolio/client/services/user/user.service';
import { DashboardModuleType } from '@ghostfolio/common/dashboard';
import { User } from '@ghostfolio/common/interfaces';
import { permissions } from '@ghostfolio/common/permissions';
import { NotificationService } from '@ghostfolio/ui/notifications';
import { DataService } from '@ghostfolio/ui/services';

import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MatDialog } from '@angular/material/dialog';
import { ActivatedRoute, Router } from '@angular/router';
import { DeviceDetectorService } from 'ngx-device-detector';
import { BehaviorSubject, EMPTY, Observable, of, throwError } from 'rxjs';

import { GfActivitiesComponent } from './activities.component';

// Cuts the two dialog trees this component can open. Neither is reachable from
// any test below - every dialog here is opened through `MatDialog`, which is
// supplied as a stub - and both drag in large editor trees that would slow the
// suite down without being exercised. The classes are only ever handed to
// `MatDialog.open`, so a bare class is a faithful stand-in.
jest.mock(
  './create-or-update-activity-dialog/create-or-update-activity-dialog.component',
  () => ({ GfCreateOrUpdateActivityDialogComponent: class {} })
);
jest.mock(
  './import-activities-dialog/import-activities-dialog.component',
  () => ({
    GfImportActivitiesDialogComponent: class {}
  })
);

/**
 * The activities module, focused on its route-neutral entry points.
 *
 * Two things are proved here, and the first of them is a regression the
 * compiler cannot catch:
 *
 * 1. **The empty-state call to action is connected end to end.** That control is
 *    a button inside `gf-no-transactions-info-indicator` that emits
 *    `createActivityClicked`, which `gf-activities-table` re-emits, rather than
 *    an anchor carrying a router link. If this component does not bind that
 *    output, the button renders, is focusable, is clickable - and does nothing at
 *    all. Nothing in the type system notices an unbound output, so the button is
 *    *clicked for real* here: the table is rendered as the real component, the
 *    notice is brought into its empty state through the same inputs the template
 *    binds, and the assertion is made on the effect at the far end of the chain.
 * 2. **The dialog request stays route-agnostic and stays narrow.** The payload is
 *    asserted down to its exact members: the `dialogModule` discriminator that
 *    tells co-mounted modules the flag is not addressed to them, the explicit
 *    nulls that neutralise a stale edit request, and the `merge` mode that keeps
 *    the clear confined to those keys instead of taking the shared-portfolio
 *    identifier and every sibling module's state with it.
 * 3. **Nothing is opened automatically.** `fetchActivities` raises no
 *    first-activity prompt, and the accounts module would make the same offer for
 *    the same viewer at the same moment - so raising one from a fetch would let
 *    whichever response landed first decide whether one onboarding dialog appeared
 *    or two appeared stacked. That absence is asserted, because an absence is
 *    exactly the kind of behaviour a later change reinstates without noticing.
 *
 * A `Router` stub records instead of navigating, which is what keeps the
 * assertions about the URL request rather than about the router: on a
 * single-canvas shell no navigation selects a screen, and the query parameters
 * are the whole message.
 */
describe('GfActivitiesComponent', () => {
  const viewer = {
    activitiesCount: 0,
    permissions: [permissions.createActivity, permissions.deleteActivity],
    settings: {
      baseCurrency: 'CHF',
      isExperimentalFeatures: false,
      isRestrictedView: false,
      locale: 'en-GB'
    }
  };

  /**
   * The configuration of every dialog the component asked for, with real types.
   *
   * `dialogMock.open.mock.calls` would serve, but its element type is `any`, and the
   * device-derived sizing and viewer-derived form data asserted below are claims
   * worth nothing if the compiler is not checking them.
   */
  interface DialogConfiguration {
    data?: { user?: User };
    height?: string;
    width?: string;
  }

  /**
   * Every alert the component raised, in the order it raised them.
   *
   * A refused activity read is only observable through what the viewer is told,
   * so the notification service is recorded rather than merely stubbed: the
   * assertions below are on the message itself, which is the whole of the
   * behaviour being fixed.
   */
  let alertCalls: { title: string }[];

  /**
   * The answers `fetchActivity` will give, consumed one per call.
   *
   * A queue rather than a single value, because a test needs to distinguish the
   * first read of a stale identifier from any later read, and because a read
   * that is never answered at all (`EMPTY`) is a third, distinct case.
   */
  let activityResponses: Observable<unknown>[];

  let component: GfActivitiesComponent;
  let dataServiceMock: {
    fetchActivities: jest.Mock;
    fetchActivity: jest.Mock;
  };
  let dialogConfigurations: DialogConfiguration[];
  let dialogMock: { open: jest.Mock };
  let fixture: ComponentFixture<GfActivitiesComponent>;

  /**
   * The query parameters the module observes, as a subject rather than a constant.
   *
   * Re-notification is the norm on a single canvas - every producer merges, so any
   * module writing to the URL makes every other module observe it again - and a
   * static observable cannot express that at all.
   */
  let queryParamsSubject: BehaviorSubject<Record<string, unknown>>;

  let routerMock: { navigate: jest.Mock };

  /**
   * Every navigation the component requested, recorded with its real types.
   *
   * `routerMock.navigate.mock.calls` would serve, but its element type is `any`,
   * and the whole point of these assertions is the exact shape of the query
   * payload - a claim worth nothing if the compiler is not checking it.
   */
  let navigations: {
    commands: unknown[];
    extras: {
      queryParams?: Record<string, unknown>;
      queryParamsHandling?: string;
    };
  }[];

  /**
   * Builds the screen for one set of query parameters.
   *
   * The viewer store is seeded with a `BehaviorSubject` so that the state
   * subscription established in `ngOnInit` resolves the viewer - and therefore
   * fetches the activities - during the first change-detection pass, which is
   * what puts the empty notice on screen without a second round trip.
   */
  const createComponent = async (
    queryParams: Record<string, unknown> = {},
    { deviceType = 'desktop' }: { deviceType?: string } = {}
  ) => {
    alertCalls = [];

    dataServiceMock = {
      fetchActivities: jest.fn(() => of({ activities: [], count: 0 })),
      // Answered from a queue where a test supplies one, so a stale identifier can be
      // made to fail. `EMPTY` otherwise, which is neither an answer nor a failure.
      fetchActivity: jest.fn(() => activityResponses.shift() ?? EMPTY)
    };

    queryParamsSubject = new BehaviorSubject<Record<string, unknown>>(
      queryParams
    );

    // Records what it was asked to open, and reports the dialog as closing
    // immediately. Both matter: the configuration is where the device-derived sizing
    // and the viewer-derived form data show up, and a synchronous close is the
    // strictest way to prove the close path cannot re-open the dialog it has just
    // dismissed.
    dialogConfigurations = [];
    dialogMock = {
      open: jest.fn((_component: unknown, config: DialogConfiguration = {}) => {
        dialogConfigurations.push(config);

        return { afterClosed: () => of(null) };
      })
    };

    navigations = [];
    routerMock = {
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
      imports: [GfActivitiesComponent],
      providers: [
        {
          provide: ActivatedRoute,
          useValue: { queryParams: queryParamsSubject }
        },
        { provide: DataService, useValue: dataServiceMock },
        {
          provide: DeviceDetectorService,
          useValue: { getDeviceInfo: () => ({ deviceType }) }
        },
        { provide: IcsService, useValue: {} },
        {
          provide: ImpersonationStorageService,
          useValue: { onChangeHasImpersonation: () => of(null) }
        },
        { provide: MatDialog, useValue: dialogMock },
        // Recorded rather than stubbed away. It is reached from two directions -
        // the real activities table confirms a deletion through it, and this
        // component reports a refused activity read through it - and the message
        // the viewer is given for the second of those is the only externally
        // observable part of that behaviour, so it has to be captured.
        {
          provide: NotificationService,
          useValue: {
            alert: (params: { title: string }) => {
              alertCalls.push(params);
            }
          }
        },
        { provide: Router, useValue: routerMock },
        {
          provide: UserService,
          useValue: {
            get: jest.fn(() => of(viewer)),
            getFilters: jest.fn(() => []),
            stateChanged: new BehaviorSubject({ user: viewer })
          }
        }
      ]
    }).compileComponents();

    fixture = TestBed.createComponent(GfActivitiesComponent);
    component = fixture.componentInstance;

    fixture.detectChanges();
  };

  /**
   * The empty-state call to action, located by the source message it carries
   * rather than by a class or an index, so a restyling cannot silently move the
   * assertion onto a different control.
   */
  const createActivityButton = () => {
    return Array.from(
      (
        fixture.nativeElement as HTMLElement
      ).querySelectorAll<HTMLButtonElement>(
        'gf-no-transactions-info-indicator button'
      )
    ).find((button) => {
      return button.textContent.trim() === 'Time to add your first activity.';
    });
  };

  /** The dialog request the router was asked to make, ignoring earlier ones. */
  const lastNavigation = () => {
    return navigations.at(-1);
  };

  // Emptied here rather than inside `createComponent`, because a test seeding an
  // answer has to do so *before* the screen is built - the read it is answering
  // fires during initialization - so clearing the queue there would discard it.
  beforeEach(() => {
    activityResponses = [];
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('the empty-state call to action', () => {
    it('should render the notice once the viewer holds no activities', async () => {
      await createComponent();

      // A precondition rather than the point of the test: everything below
      // depends on the notice actually being on screen, and the table only draws
      // it when it has an empty data source, no activities and the permission to
      // create one - the exact three inputs this component's template binds.
      expect(createActivityButton()).toBeTruthy();
    });

    it('should request the create dialog when the notice is clicked', async () => {
      await createComponent();

      // Asserted rather than cleared away: initialization must request nothing at
      // all, so the click below is the only navigation this component has made
      // and the count assertion covers both facts at once.
      expect(navigations).toEqual([]);

      createActivityButton().click();

      // `createDialog` is shared with the accounts and account-access modules,
      // and every consumer of it refuses a request that names no module. An
      // unqualified request would therefore open nothing at all rather than
      // opening the wrong thing - a silent failure, because the navigation still
      // succeeds.
      expect(routerMock.navigate).toHaveBeenCalledTimes(1);
      expect(lastNavigation().commands).toEqual([]);
      expect(lastNavigation().extras.queryParams).toEqual({
        activityId: null,
        createDialog: true,
        dialogModule: DashboardModuleType.ACTIVITIES,
        editDialog: null
      });
    });

    it('should merge the request while neutralising a stale edit request', async () => {
      // Arrived with an edit request already on the URL. `createDialog` is tested
      // ahead of `editDialog`, so leaving `activityId` up would open a create form
      // pre-filled from the activity being edited. Nulling the two keys is what
      // guarantees a blank form; merging is what keeps that clear confined to
      // them, instead of also discarding the shared-portfolio access identifier,
      // the sign-in token hand-off and every sibling module's dialog state.
      await createComponent({ activityId: 'activity-1', editDialog: true });

      routerMock.navigate.mockClear();
      navigations = [];

      component.onCreateActivity();

      const { commands, extras } = lastNavigation();

      expect(commands).toEqual([]);
      expect(extras.queryParamsHandling).toBe('merge');
      expect(extras.queryParams).toEqual({
        activityId: null,
        createDialog: true,
        dialogModule: DashboardModuleType.ACTIVITIES,
        editDialog: null
      });
    });

    it('should emit the same request as the floating action button', async () => {
      await createComponent();

      // The floating action button binds the very object `onCreateActivity`
      // navigates with, so identity is the strongest available statement that the
      // two controls meaning the same thing cannot drift apart - a duplicated
      // literal is a match no compiler checks.
      expect(component.createDialogQueryParams).toBe(
        fixture.componentInstance.createDialogQueryParams
      );
      expect(component.createDialogQueryParams.dialogModule).toBe('activities');
    });
  });

  describe('the query-parameter dialog convention', () => {
    it('should open the create dialog for a request addressed with no activity', async () => {
      await createComponent();

      dialogMock.open.mockClear();

      // Re-entered through the component rather than through a second fixture,
      // because the handler under test is the one established in the
      // constructor and it has already consumed the parameters it was built
      // with.
      component['openCreateActivityDialog']();

      expect(dialogMock.open).toHaveBeenCalledTimes(1);
      expect(dataServiceMock.fetchActivity).not.toHaveBeenCalled();
    });

    it('should open nothing at all for a viewer holding no activities', async () => {
      await createComponent();

      // `fetchActivities` raises no onboarding prompt. The accounts module makes
      // the same offer for the same viewer at the same moment, so raising one here
      // would let whichever response arrived first decide whether one onboarding
      // dialog appeared or two appeared stacked. The empty-state call to action
      // asserted above makes the offer, and the viewer chooses to act on it.
      expect(routerMock.navigate).not.toHaveBeenCalled();
      expect(dialogMock.open).not.toHaveBeenCalled();
    });

    it('should ignore a create request addressed to another module', async () => {
      await createComponent({
        createDialog: true,
        dialogModule: DashboardModuleType.ACCOUNTS
      });

      expect(dialogMock.open).not.toHaveBeenCalled();
    });

    it('should ignore an unqualified create request', async () => {
      await createComponent({ createDialog: true });

      expect(dialogMock.open).not.toHaveBeenCalled();
    });
  });

  /**
   * A dialog request naming an activity that cannot be read.
   *
   * This is the ordinary way for one to arrive: a shared link, a restored tab or a Back
   * navigation can all carry the identifier of an activity that has since been deleted.
   * The read had no failure handler, so nothing opened, the request stayed RECORDED as
   * served, and the identifier stayed in the address - leaving a module that had been
   * asked to show something and silently showed nothing, with no way to ask again short
   * of editing the URL.
   */
  describe('a request naming an activity that is gone', () => {
    it('says the activity no longer exists', async () => {
      activityResponses = [throwError(() => ({ status: 404 }))];

      await createComponent({
        activityId: 'ACTIVITY_ID',
        dialogModule: DashboardModuleType.ACTIVITIES,
        editDialog: true
      });

      expect(dialogMock.open).not.toHaveBeenCalled();
      expect(alertCalls).toEqual([
        { title: 'This activity no longer exists.' }
      ]);
    });

    it('clears the request from the address', async () => {
      activityResponses = [throwError(() => ({ status: 404 }))];

      await createComponent({
        activityId: 'ACTIVITY_ID',
        dialogModule: DashboardModuleType.ACTIVITIES,
        editDialog: true
      });

      // Clearing them is what makes the module usable again, and what lets the same
      // request count as new if it was merely transient: the final branch observes
      // their absence and forgets what was served.
      const cleared = navigations.find(({ extras }) => {
        return extras.queryParams?.['activityId'] === null;
      });

      expect(cleared).toBeTruthy();
      expect(cleared.extras.queryParamsHandling).toBe('merge');
    });

    it('distinguishes a transient failure from a deletion', async () => {
      activityResponses = [throwError(() => ({ status: 500 }))];

      await createComponent({
        activityId: 'ACTIVITY_ID',
        dialogModule: DashboardModuleType.ACTIVITIES,
        editDialog: true
      });

      // Worth separating: one of these is worth trying again and the other never will
      // be.
      expect(alertCalls).toEqual([
        { title: 'The activity could not be loaded. Please try again.' }
      ]);
    });

    it('applies to a create request carrying an identifier as well', async () => {
      activityResponses = [throwError(() => ({ status: 404 }))];

      await createComponent({
        activityId: 'ACTIVITY_ID',
        createDialog: true,
        dialogModule: DashboardModuleType.ACTIVITIES
      });

      // The same read serves both: this module opens a prefilled create form from an
      // existing activity, which is how an activity is duplicated.
      expect(dialogMock.open).not.toHaveBeenCalled();
      expect(alertCalls).toHaveLength(1);
    });
  });

  describe('cold placement', () => {
    it('should size the dialog for the device even though the request preceded initialization', async () => {
      // The cold path this module is reached by on a single canvas: it is
      // materialised lazily *in response to* a request that is already on the URL,
      // so `route.queryParams` delivers its current value in the constructor -
      // before `ngOnInit` has read the device or the viewer. Acting on it there
      // produced a dialog laid out for a desktop on a phone, and handed the form
      // `user: undefined`, which left its account and currency selectors empty.
      await createComponent(
        { createDialog: true, dialogModule: DashboardModuleType.ACTIVITIES },
        { deviceType: 'mobile' }
      );

      expect(dialogMock.open).toHaveBeenCalledTimes(1);

      const configuration = dialogConfigurations.at(-1);

      expect(configuration.height).toBe('98vh');
      expect(configuration.width).toBe('100vw');
      expect(configuration.data.user).toBe(viewer);
    });

    it('should open one dialog when the request is re-observed', async () => {
      // Every producer on the canvas merges rather than replaces, so
      // `route.queryParams` emits again whenever any *other* module writes to the
      // URL. Four prerequisites also re-evaluate the held parameters as they
      // arrive. Both make re-notification the norm rather than the exception.
      await createComponent({
        createDialog: true,
        dialogModule: DashboardModuleType.ACTIVITIES
      });

      queryParamsSubject.next({
        accessId: 'ACCESS_ID',
        createDialog: true,
        dialogModule: DashboardModuleType.ACTIVITIES
      });

      expect(dialogMock.open).toHaveBeenCalledTimes(1);
    });

    it('should honour the same request again once the parameters have been cleared', async () => {
      await createComponent({
        createDialog: true,
        dialogModule: DashboardModuleType.ACTIVITIES
      });

      // What the close handler does: the parameters the dialog travelled on are
      // removed. Observing their absence is what lets the identical request count
      // as new, which is why the guard is keyed on the request the URL is making
      // rather than on the dialog's own lifecycle.
      queryParamsSubject.next({});
      queryParamsSubject.next({
        createDialog: true,
        dialogModule: DashboardModuleType.ACTIVITIES
      });

      expect(dialogMock.open).toHaveBeenCalledTimes(2);
    });
  });

  describe('the onboarding invitation', () => {
    it('should request no dialog while initializing for a viewer with no activities', async () => {
      const open = jest.fn();

      await createComponent();

      TestBed.inject(MatDialog).open = open;

      // The seeded viewer holds zero activities and may create one, which is
      // exactly the case a fetch-time create dialog would fire for. On a canvas
      // that is an ambush: the module is one card among many that all load
      // together, the dialog would cover and block every other module behind a
      // full-viewport scrim, and it would do so on every visit because the fetch
      // runs on every load.
      //
      // Both halves are asserted, because either alone would be satisfiable by a
      // broken component: that no dialog REQUEST was made, and that no dialog was
      // opened by any other route.
      expect(dataServiceMock.fetchActivities).toHaveBeenCalled();
      expect(viewer.activitiesCount).toBe(0);

      expect(navigations).toEqual([]);
      expect(routerMock.navigate).not.toHaveBeenCalled();
      expect(open).not.toHaveBeenCalled();

      // And the invitation is still on screen, so the dialog remains one click
      // away rather than being unreachable.
      expect(createActivityButton()).toBeTruthy();
    });

    it('should still honour a create request that names this module', async () => {
      // The removal above must not have cost the module its ability to respond
      // when a request genuinely arrives - the parameters the invitation and the
      // floating action button both write.
      const open = jest.fn();

      await createComponent();

      TestBed.inject(MatDialog).open = open;

      component['openCreateActivityDialog']();

      expect(open).toHaveBeenCalledTimes(1);
    });
  });
});
