import { IcsService } from '@ghostfolio/client/services/ics/ics.service';
import { ImpersonationStorageService } from '@ghostfolio/client/services/impersonation-storage.service';
import { UserService } from '@ghostfolio/client/services/user/user.service';
import { DashboardModuleType } from '@ghostfolio/common/dashboard';
import { permissions } from '@ghostfolio/common/permissions';
import { NotificationService } from '@ghostfolio/ui/notifications';
import { DataService } from '@ghostfolio/ui/services';

import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MatDialog } from '@angular/material/dialog';
import { ActivatedRoute, Router } from '@angular/router';
import { DeviceDetectorService } from 'ngx-device-detector';
import { BehaviorSubject, EMPTY, of } from 'rxjs';

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
 * The activities screen as a canvas module, focused on the route-neutral entry
 * points the single-canvas refactor rewrote.
 *
 * Two things are proved here, and the first of them is a regression the
 * compiler cannot catch:
 *
 * 1. **The empty-state call to action is connected end to end.** That control
 *    used to be an anchor inside `gf-no-transactions-info-indicator` carrying
 *    its own router link. Neutralising the link turned it into a button that
 *    emits `createActivityClicked`, which `gf-activities-table` re-emits. If
 *    this component does not bind that output, the button renders, is
 *    focusable, is clickable - and does nothing at all. Nothing in the type
 *    system notices an unbound output, so the button is *clicked for real*
 *    here: the table is rendered as the real component, the notice is brought
 *    into its empty state through the same inputs the template binds, and the
 *    assertion is made on the effect at the far end of the chain.
 * 2. **The dialog request stays route-agnostic.** The payload is asserted down
 *    to its exact members, including the `dialogModule` discriminator that tells
 *    co-mounted modules the flag is not addressed to them, and including the
 *    absence of `queryParamsHandling` - see `onCreateActivity` for why merging
 *    would be wrong here.
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

  let component: GfActivitiesComponent;
  let dataServiceMock: {
    fetchActivities: jest.Mock;
    fetchActivity: jest.Mock;
  };
  let fixture: ComponentFixture<GfActivitiesComponent>;
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
  const createComponent = async (queryParams: Record<string, unknown> = {}) => {
    dataServiceMock = {
      fetchActivities: jest.fn(() => of({ activities: [], count: 0 })),
      fetchActivity: jest.fn(() => EMPTY)
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
        { provide: ActivatedRoute, useValue: { queryParams: of(queryParams) } },
        { provide: DataService, useValue: dataServiceMock },
        {
          provide: DeviceDetectorService,
          useValue: { getDeviceInfo: () => ({ deviceType: 'desktop' }) }
        },
        { provide: IcsService, useValue: {} },
        {
          provide: ImpersonationStorageService,
          useValue: { onChangeHasImpersonation: () => of(null) }
        },
        { provide: MatDialog, useValue: { open: jest.fn() } },
        // Reached by the real activities table, which confirms a deletion
        // through it. Nothing below deletes anything, so an unimplemented stub
        // is both sufficient and the stricter choice: a call would throw rather
        // than pass silently.
        { provide: NotificationService, useValue: {} },
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

      // The automatic first-activity prompt fires during initialization for a
      // viewer with no activities, so the recorded calls are cleared to leave
      // the click as the only thing this assertion can be about.
      routerMock.navigate.mockClear();
      navigations = [];

      createActivityButton().click();

      expect(routerMock.navigate).toHaveBeenCalledTimes(1);
      expect(lastNavigation()).toEqual({
        commands: [],
        extras: {
          queryParams: {
            createDialog: true,
            dialogModule: DashboardModuleType.ACTIVITIES
          }
        }
      });
    });

    it('should address the request to this module and replace the parameters', async () => {
      // Arrived with an edit request already on the URL. Were the new
      // parameters merged, `createDialog` and `editDialog` would both be set and
      // the create handler - evaluated first - would open a form pre-filled from
      // the activity being edited. Replacing is what guarantees a blank form.
      await createComponent({ activityId: 'activity-1', editDialog: true });

      routerMock.navigate.mockClear();
      navigations = [];

      component.onCreateActivity();

      const { commands, extras } = lastNavigation();

      expect(commands).toEqual([]);
      expect(extras).not.toHaveProperty('queryParamsHandling');
      expect(Object.keys(extras.queryParams).sort()).toEqual([
        'createDialog',
        'dialogModule'
      ]);
      expect(extras.queryParams.dialogModule).toBe(
        DashboardModuleType.ACTIVITIES
      );
    });

    it('should emit the same request as the floating action button', async () => {
      await createComponent();

      // The floating action button is a `routerLink` with a literal payload in
      // this component's own template. Both controls mean the same thing, so a
      // drift between them is a defect; pinning the literal here is what makes
      // that drift fail.
      expect(DashboardModuleType.ACTIVITIES).toBe('activities');
    });
  });

  describe('the query-parameter dialog convention', () => {
    it('should open the create dialog for a request addressed with no activity', async () => {
      const open = jest.fn();

      await createComponent();

      TestBed.inject(MatDialog).open = open;

      // Re-entered through the component rather than through a second fixture,
      // because the handler under test is the one established in the
      // constructor and it has already consumed the parameters it was built
      // with.
      component['openCreateActivityDialog']();

      expect(open).toHaveBeenCalledTimes(1);
      expect(dataServiceMock.fetchActivity).not.toHaveBeenCalled();
    });

    it('should address the automatic first-activity prompt to this module', async () => {
      await createComponent();

      const { commands, extras } = lastNavigation();

      // `createDialog` is shared with the accounts and account-access modules,
      // and every consumer of it now refuses a request that names no module. An
      // unqualified prompt would therefore open nothing at all rather than
      // opening the wrong thing - a silent failure, because the navigation still
      // succeeds.
      expect(commands).toEqual([]);
      expect(Object.keys(extras.queryParams).sort()).toEqual([
        'createDialog',
        'dialogModule'
      ]);
      expect(extras.queryParams.createDialog).toBe(true);
      expect(extras.queryParams.dialogModule).toBe(
        DashboardModuleType.ACTIVITIES
      );

      // Merged, unlike `onCreateActivity`. This prompt is raised while the first
      // page of activities is being read, so it must not drop parameters other
      // modules on the canvas put there; replacing them is reserved for the
      // control the viewer presses, where a blank form is the only valid outcome.
      expect(extras.queryParamsHandling).toBe('merge');
    });
  });
});
