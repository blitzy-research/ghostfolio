import { GfPublicPortfolioComponent } from '@ghostfolio/client/components/public-portfolio/public-portfolio.component';
import { DashboardIntentService } from '@ghostfolio/client/core/dashboard-intent.service';
import { LayoutService } from '@ghostfolio/client/core/layout.service';
import { TokenStorageService } from '@ghostfolio/client/services/token-storage.service';
import { UserService } from '@ghostfolio/client/services/user/user.service';
import type { UserDashboardLayout } from '@ghostfolio/common/interfaces';
import { permissions } from '@ghostfolio/common/permissions';
import type { AlertParams, ConfirmParams } from '@ghostfolio/ui/notifications';
import { NotificationService } from '@ghostfolio/ui/notifications';
import { DataService } from '@ghostfolio/ui/services';

import { ScrollDispatcher } from '@angular/cdk/scrolling';
import { HttpErrorResponse } from '@angular/common/http';
import {
  Component,
  ElementRef,
  EventEmitter,
  forwardRef,
  Input,
  Output,
  reflectComponentType,
  ViewChild
} from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { ActivatedRoute, Router } from '@angular/router';
import { Gridster, GridsterItem } from 'angular-gridster2';
import type { GridsterItemConfig } from 'angular-gridster2';
import { readFileSync } from 'fs';
import { StatusCodes } from 'http-status-codes';
import { join } from 'path';
import {
  BehaviorSubject,
  EMPTY,
  Observable,
  Subject,
  of,
  throwError
} from 'rxjs';

import { DashboardModuleType } from '../enums/dashboard-module-type';
import type {
  DashboardLayoutItem,
  DashboardModuleDefinition,
  DashboardModuleGeometryStep
} from '../interfaces/interfaces';
import { GfModuleCatalogComponent } from '../module-catalog/module-catalog.component';
import { GfModuleRegistryService } from '../module-registry.service';
import { GfDashboardLayoutService } from '../services/dashboard-layout.service';
import { GfDashboardCanvasComponent } from './dashboard-canvas.component';
import {
  createDashboardCanvasConfig,
  GRID_COLUMNS,
  GRID_ROWS,
  itemValidateCallback
} from './dashboard-canvas.config';
import { GfDashboardModuleHostComponent } from './dashboard-module-host/dashboard-module-host.component';
import { GfDashboardToolbarComponent } from './dashboard-toolbar/dashboard-toolbar.component';
import { GfEmptyCanvasStateComponent } from './empty-canvas-state/empty-canvas-state.component';
import { GfSignInPromptComponent } from './sign-in-prompt/sign-in-prompt.component';

// Cuts the chart tree the shared portfolio brings with it, which reaches the `color`
// package: it ships plain `.js` ES modules that this project's Jest transform does
// not process, so merely naming the real component - which this spec must do to
// override it - would fail the suite before a single test ran.
jest.mock(
  '@ghostfolio/client/components/public-portfolio/public-portfolio.component',
  () => ({ GfPublicPortfolioComponent: class {} })
);

// Cuts the one import chain that would evaluate the shared route metadata - and so
// call `$localize` - before the global above is installed: the user service holds a
// reference to this dialog to hand to `MatDialog.open`. The user service is stubbed,
// so neither the dialog nor the path that opens it is reachable here.
jest.mock(
  '@ghostfolio/client/components/subscription-interstitial-dialog/subscription-interstitial-dialog.component',
  () => ({ GfSubscriptionInterstitialDialogComponent: class {} })
);

// Cuts the one dependency of the canvas that this environment cannot load.
// `@ionic/angular/standalone` re-exports `@ionic/core`, which ships plain `.js`
// ES modules rather than `.mjs`, and this project's Jest transform deliberately
// admits only `.mjs` from `node_modules` - the workspace-wide setting that
// `libs/ui` shares - so importing the canvas, which names `IonIcon` among its own
// `imports`, would fail this suite before a single test ran. The accommodation
// belongs here rather than in that global configuration, which every other spec
// in this project is transformed by.
//
// A bare class would not do: Angular validates every entry of an `imports`
// array, so the stand-in is a real standalone component carrying the same
// `ion-icon` selector, which also keeps the rendered markup identical in shape.
// The decorator is applied as a function because this factory is hoisted above
// the file's own imports, so no class declared here would exist yet.
jest.mock('@ionic/angular/standalone', () => {
  // Reached through the namespace rather than destructured, so that `Component`
  // is not shadowed in the files that name it for their own stand-ins.
  const angularCore =
    jest.requireActual<typeof import('@angular/core')>('@angular/core');

  return {
    IonIcon: angularCore.Component({ selector: 'ion-icon', template: '' })(
      class IonIcon {}
    )
  };
});

/**
 * The shape of the viewer the canvas actually reads.
 *
 * Deliberately narrower than the real user object. The canvas reads exactly two
 * things out of a viewer - the identity it compares against the previous one, and
 * the permissions it screens module visibility with - so describing those and
 * nothing else keeps this harness from implying a dependency on the rest.
 */
interface CanvasViewer {
  id: string;
  permissions: string[];
}

interface CanvasViewerState {
  user?: CanvasViewer | null;
}

interface CanvasScenario {
  /**
   * Whether the canvas is permitted to navigate at all. Left off everywhere but
   * the spent-token clean-up, where it is the behaviour under test; anywhere
   * else a navigation is a defect, and the `Router` stub throws rather than
   * recording it. See the note in this suite's documentation.
   */
  allowsNavigation?: boolean;

  /** What `GfDashboardLayoutService.get()` answers with. */
  layout?: Observable<UserDashboardLayout | null>;

  queryParams?: Record<string, string>;

  viewer?: CanvasViewer | null;

  /**
   * What `UserService.get()` answers with.
   *
   * Both channels matter. The real service serves an already-fetched viewer from
   * its cache *without* dispatching through the store, so a success arriving this
   * way is the only notification the canvas gets - which is exactly what happens
   * when the share parameter is dropped from the URL after the store's emissions
   * were being ignored.
   */
  viewerRequest?: Observable<CanvasViewer>;
}

@Component({ selector: 'gf-dashboard-toolbar', template: '' })
class GfTestDashboardToolbarComponent {}

@Component({ selector: 'gf-public-portfolio', template: '' })
class GfTestPublicPortfolioComponent {}

@Component({ selector: 'gf-sign-in-prompt', template: '' })
class GfTestSignInPromptComponent {
  // Declared so the canvas's binding resolves against the stand-in, and so a test
  // can read what the canvas passed. The sentence it produces belongs to the real
  // component's own suite.
  @Input() hasSignInError = false;
}

/**
 * Stands in for the catalog panel, and answers a focus request the way the real
 * panel does.
 *
 * It is registered under the real component's token as well as its own, which is
 * what lets the canvas's `@ViewChild(GfModuleCatalogComponent)` resolve it: a view
 * query with a type predicate resolves that type through the matched element's
 * injector, so a stand-in that provides the token is found even though it is a
 * different class. Without it the query would simply be `undefined` here and the
 * focus hand-off - the thing under test - would never run.
 *
 * The search field is a real focusable element rather than a spy, so the assertions
 * below can read `document.activeElement` and see where focus actually went. That
 * matters more than it looks: `focus()` on a hidden element is a silent no-op, so a
 * spy that merely records being called would pass whether or not focus moved.
 */
@Component({
  providers: [
    {
      provide: GfModuleCatalogComponent,
      // Wrapped because the class is referenced inside its own decorator, which is
      // the textbook case for a forward reference.
      useExisting: forwardRef(() => GfTestModuleCatalogComponent)
    }
  ],
  selector: 'gf-module-catalog',
  template: '<input #search type="text" />'
})
class GfTestModuleCatalogComponent {
  /**
   * Both inputs the canvas binds, declared rather than left off - and for a
   * sharper reason than symmetry. The canvas applies `CUSTOM_ELEMENTS_SCHEMA`, and
   * every stand-in here has a hyphenated selector, so Angular treats these
   * elements as custom elements and accepts a binding to a property no component
   * declares *without complaint*. A stand-in missing an input therefore proves
   * nothing: the binding would be silently discarded and every test would still
   * pass while the real catalog received nothing at all. Declaring them is what
   * makes the values below observable, and what makes a renamed input fail here.
   */
  @Input() public placedModuleTypes: DashboardModuleType[] = [];

  @Input() public unavailableModuleTypes: DashboardModuleType[] = [];

  @Output() public moduleAdded = new EventEmitter<DashboardModuleType>();

  @ViewChild('search', { read: ElementRef })
  private searchField: ElementRef<HTMLInputElement>;

  /** How many times the canvas asked this panel to take focus. */
  public focusRequestCount = 0;

  /**
   * Whether the search field should report that focus landed.
   *
   * A test flips this to model the one case the canvas has to cope with - a panel
   * that could not take focus - without having to detach or hide anything.
   */
  public willTakeFocus = true;

  /**
   * The real panel's contract: move focus to the search field and report whether it
   * landed. Mirrored rather than stubbed, so the canvas is exercised against the
   * same true/false answer the real panel gives.
   */
  public focusSearchField(): boolean {
    this.focusRequestCount += 1;

    const searchField = this.searchField?.nativeElement;

    if (!this.willTakeFocus || !searchField) {
      return false;
    }

    searchField.focus();

    return searchField.ownerDocument?.activeElement === searchField;
  }
}

@Component({ selector: 'gf-dashboard-module-host', template: '' })
class GfTestDashboardModuleHostComponent {
  @Input() public definition: DashboardModuleDefinition;

  /**
   * The three outputs the canvas binds. Declared here rather than left off, and
   * that is not tidiness: a binding to an output a component does not declare is
   * not an error - Angular quietly registers a DOM listener of that name instead -
   * so a stand-in missing one would let the canvas's own binding rot while every
   * test still passed, and would hand the handler a `CustomEvent` where it expects
   * a geometry step.
   */
  @Output() public move = new EventEmitter<DashboardModuleGeometryStep>();

  @Output() public remove = new EventEmitter<void>();

  @Output() public resize = new EventEmitter<DashboardModuleGeometryStep>();
}

/**
 * A stand-in for the browser's own `ResizeObserver`, which jsdom does not
 * implement at all.
 *
 * The canvas feature-detects it and skips the whole path when it is absent, so
 * without this the behaviour under test - noticing that the grid's host box has
 * changed for a reason the engine cannot see - is not merely unasserted but
 * unreachable. Every instance records itself so a test can reach the callback the
 * canvas registered and fire it deliberately, which is the only way to simulate a
 * reflow in an environment that performs no layout.
 */
class GfTestResizeObserver {
  public static instances: GfTestResizeObserver[] = [];

  public disconnectCount = 0;

  public readonly observed: Element[] = [];

  private readonly callback: ResizeObserverCallback;

  public constructor(aCallback: ResizeObserverCallback) {
    this.callback = aCallback;

    GfTestResizeObserver.instances.push(this);
  }

  public disconnect() {
    this.disconnectCount += 1;
  }

  public observe(aTarget: Element) {
    this.observed.push(aTarget);
  }

  /** Fires the observed callback exactly as a real reflow would. */
  public trigger() {
    this.callback([], this as unknown as ResizeObserver);
  }

  public unobserve() {
    // Never called by the canvas, which disconnects wholesale; present only to
    // satisfy the interface being stood in for.
  }
}

describe('itemValidateCallback', () => {
  const atFloor: GridsterItemConfig = {
    cols: 2,
    minItemCols: 2,
    minItemRows: 2,
    rows: 2,
    x: 0,
    y: 0
  };

  const stricterThanFloor: GridsterItemConfig = {
    cols: 4,
    minItemCols: 4,
    minItemRows: 3,
    rows: 3,
    x: 0,
    y: 0
  };

  it('should accept a placement exactly at its declared minimum', () => {
    expect(itemValidateCallback(atFloor)).toBe(true);
  });

  it('should accept a placement larger than its declared minimum', () => {
    expect(itemValidateCallback({ ...atFloor, cols: 4, rows: 4 })).toBe(true);
  });

  it('should reject a placement one column below its declared minimum', () => {
    expect(itemValidateCallback({ ...atFloor, cols: 1, rows: 4 })).toBe(false);
  });

  it('should reject a placement one row below its declared minimum', () => {
    expect(itemValidateCallback({ ...atFloor, cols: 4, rows: 1 })).toBe(false);
  });

  it('should accept a placement exactly at a stricter declared minimum', () => {
    expect(itemValidateCallback(stricterThanFloor)).toBe(true);
  });

  it('should reject a placement below a stricter declared minimum', () => {
    expect(itemValidateCallback({ ...stricterThanFloor, cols: 3 })).toBe(false);
  });

  it('should hold a placement that declares no minimum to the grid-wide floor', () => {
    // Both members are optional on a grid item, and an absent one falls back to
    // the 2x2 grid floor - which is precisely what the engine itself does one line
    // later in `checkGridCollision`. Nothing is loosened by that: every item this
    // canvas mints carries the registry minimums, so a genuine module always
    // presents its own contract and a stricter declaration is always the one
    // applied. The one candidate that cannot present a contract is the library's
    // own drag-over preview, and admitting it on the grid floor is what keeps
    // `emptyCellDropCallback` reachable at all.
    expect(itemValidateCallback({ cols: 4, rows: 4, x: 0, y: 0 })).toBe(true);
    expect(itemValidateCallback({ cols: 2, rows: 2, x: 0, y: 0 })).toBe(true);
    expect(itemValidateCallback({ cols: 12, rows: 12, x: 0, y: 0 })).toBe(true);

    // The floor is still a floor.
    expect(itemValidateCallback({ cols: 1, rows: 4, x: 0, y: 0 })).toBe(false);
    expect(itemValidateCallback({ cols: 4, rows: 1, x: 0, y: 0 })).toBe(false);

    // And a half-declared contract is measured against what it does declare,
    // falling back to the floor only for the dimension it leaves out.
    expect(
      itemValidateCallback({ cols: 4, minItemCols: 6, rows: 4, x: 0, y: 0 })
    ).toBe(false);
    expect(
      itemValidateCallback({ cols: 4, minItemRows: 6, rows: 4, x: 0, y: 0 })
    ).toBe(false);
    expect(
      itemValidateCallback({ cols: 4, minItemCols: 2, rows: 4, x: 0, y: 0 })
    ).toBe(true);
    expect(
      itemValidateCallback({ cols: 4, minItemRows: 2, rows: 4, x: 0, y: 0 })
    ).toBe(true);
  });
});

/**
 * The ceiling a viewer can reach has to be the ceiling the server advertises.
 *
 * Gridster decides whether a footprint may be placed by testing it against
 * `maxItemCols`/`maxItemRows` - the *per-item* ceilings - and defaults both to 50.
 * `maxCols`/`maxRows` bound the grid and are not consulted for this. So a
 * configuration that states only the grid-wide pair leaves the engine refusing
 * anything past 50 rows while the grid, the hydration clamp and the DTO all say
 * 100. The server accepts such a module, the canvas hydrates it, and the engine
 * then marks it `notPlaced` and paints it `display: none`: it disappears with no
 * notice and no way for a viewer to get it back.
 *
 * These assertions pin the agreement rather than the numbers - each is expressed
 * against `GRID_COLUMNS`/`GRID_ROWS`, so widening the grid one day cannot leave the
 * per-item ceilings behind and silently reintroduce the gap.
 */
describe('the grid ceilings', () => {
  const config = () =>
    createDashboardCanvasConfig({
      onDragGestureStart: () => undefined,
      onEmptyCellDrop: () => undefined,
      onGridsterDestroy: () => undefined,
      onGridsterInit: () => undefined,
      onItemGeometryChange: () => undefined,
      onItemInit: () => undefined,
      onLayoutChange: () => undefined,
      onResizeGestureEnd: () => undefined,
      onResizeGestureStart: () => undefined
    });

  it('should cap one module at exactly the grid it lives in', () => {
    // Stated explicitly, because leaving either to the library is the defect:
    // both would silently become 50.
    expect(config().maxItemCols).toBe(GRID_COLUMNS);
    expect(config().maxItemRows).toBe(GRID_ROWS);
  });

  it('should not let the per-item ceilings drift from the grid-wide ones', () => {
    const { maxCols, maxItemCols, maxItemRows, maxRows } = config();

    expect(maxItemCols).toBe(maxCols);
    expect(maxItemRows).toBe(maxRows);
  });

  it('should leave the full-height footprint the server accepts reachable', () => {
    // A module occupying the whole grid is the widest and tallest thing the DTO
    // admits - `cols @Max(12)`, `rows @Max(100)`, and `x + cols <= 12` with
    // `y + rows <= 100`. It has to survive every client-side gate too, or the two
    // layers describe different grids again.
    const fullHeight: GridsterItemConfig = {
      cols: GRID_COLUMNS,
      minItemCols: 2,
      minItemRows: 2,
      rows: GRID_ROWS,
      x: 0,
      y: 0
    };

    expect(fullHeight.cols).toBeLessThanOrEqual(config().maxItemCols);
    expect(fullHeight.rows).toBeLessThanOrEqual(config().maxItemRows);
    expect(itemValidateCallback(fullHeight)).toBe(true);

    // And the area ceiling cannot bind before the dimensional ones do: the library
    // defaults `maxItemArea` to 2500 and the whole grid is 1200 cells, so it is
    // left alone rather than restated. This asserts that remains true.
    expect(GRID_COLUMNS * GRID_ROWS).toBeLessThanOrEqual(
      config().maxItemArea ?? 2500
    );
  });

  it('should still admit the row heights that were previously refused', () => {
    // 51 through 100 is the band the library's default silently swallowed: the DTO
    // accepted it, the engine did not.
    for (const rows of [51, 60, 75, 99, GRID_ROWS]) {
      expect(rows).toBeLessThanOrEqual(config().maxItemRows);
      expect(
        itemValidateCallback({ cols: GRID_COLUMNS, rows, x: 0, y: 0 })
      ).toBe(true);
    }
  });
});

/**
 * Five properties of this harness are load-bearing.
 *
 * **The real grid engine is mounted, not stubbed.** Checked rather than assumed: in
 * this environment `angular-gridster2` renders without a layout engine, references no
 * observer API, leaves a hydrated item's cell and size untouched and raises none of
 * its own callbacks. Keeping it real costs no determinism and supplies properly typed
 * `Gridster` and `GridsterItem` instances, which is what lets every grid callback be
 * invoked through the configuration the canvas hands the engine with no type
 * assertion anywhere.
 *
 * **The viewer is delivered through the store, never through the fetch.** The canvas
 * adopts a viewer only from `UserService.stateChanged`, `get()` existing for it to
 * observe a *failure*. Seeding the store with a `BehaviorSubject` completes hydration
 * inside the constructor, which is what makes "already open on the first frame" a
 * statement about the first frame rather than the second.
 *
 * **The chrome is replaced, the empty notice is not.** The replaced collaborators each
 * bring a large tree the canvas has no opinion about, and replacing the module chrome
 * is what makes "no module component was resolved" a statement about the canvas rather
 * than its child. The empty notice injects nothing, so it is rendered for real.
 *
 * **The registry stub performs a real, unfiltered lookup.** Narrowing to a viewer is
 * the canvas's own job, so a stub that pre-filtered - or answered every lookup with
 * the same definition - would make the visibility and stale-discriminator tests
 * vacuous.
 *
 * **Navigation is forbidden by default and permitted in exactly one place.** The
 * canvas injects `Router` as a constructor dependency, so the token has to be
 * satisfiable; its absence therefore cannot be the assertion. What replaces that
 * is a `Router` whose `navigate` *throws*: outside the one describe block that
 * declares `allowsNavigation`, any navigation the canvas attempts - from an
 * existing branch or a future one - fails the test that provoked it, by name,
 * instead of being quietly recorded. Only the spent-token clean-up declares the
 * capability, and the single navigation it is entitled to is asserted down to its
 * exact arguments: the empty command array, one nulled parameter and a merge. No
 * route table, `provideRouter` or router testing module is configured anywhere in
 * this file, because the URL selects no screen: an injection failure here is the
 * guard working rather than a missing provider.
 *
 * **No timer is faked and none is needed.** The canvas does not debounce; the five
 * hundred millisecond window belongs to `GfDashboardLayoutService`, whose own spec
 * owns it. Everything here settles synchronously, so there is no clock to advance
 * and none to hand back.
 */
describe('GfDashboardCanvasComponent', () => {
  const signedInViewer: CanvasViewer = { id: 'viewer-1', permissions: [] };

  let component: GfDashboardCanvasComponent;
  let activatedRouteMock: {
    queryParams: Observable<Record<string, string>>;
    snapshot: { queryParams: Record<string, string> };
  };
  let dashboardLayoutServiceMock: {
    adoptIdentity: jest.Mock<void, [string]>;
    beginIdentityTransition: jest.Mock<void, []>;
    discard: jest.Mock;
    discardFailedSave: jest.Mock<void, []>;
    dismissConflict: jest.Mock;
    get: jest.Mock;
    getHasConflict: jest.Mock;
    getHasSaveError: jest.Mock;
    identityTransition$: Observable<void>;
    overwriteAfterConflict: jest.Mock;
    retryFailedSave: jest.Mock;
    // Typed precisely, unlike its neighbours, for one reason: the assertions that
    // exactly one array is ever reported have to read the recorded argument and
    // compare it by identity, and an untyped mock would hand that back as `any`.
    // The viewer the arrangement belongs to travels with it, so the array is the
    // second argument.
    scheduleSave: jest.Mock<void, [string, DashboardLayoutItem[]]>;
  };
  let conflictSubject: BehaviorSubject<boolean>;
  // Whether the confirmation stand-in confirms of its own accord. Default true, so a
  // test that is about the ACTION behind a destructive control does not have to
  // drive the guard in front of it; flipped by the tests that are about the guard.
  let confirmsAutomatically: boolean;
  let confirmParams: ConfirmParams;
  // What the discard reports. A subject rather than a fixed observable so the
  // failure path is reachable, which is the path that must leave the viewer exactly
  // where they were.
  let discardResponse: Observable<void>;
  let identityTransitionSubject: Subject<void>;
  let notificationServiceMock: {
    alert: jest.Mock<void, [AlertParams]>;
    confirm: jest.Mock;
  };
  let queryParamsSubject: BehaviorSubject<Record<string, string>>;
  let dataServiceMock: {
    fetchUserDashboardLayout: jest.Mock;
    patchUserDashboardLayout: jest.Mock;
  };
  let definitions: DashboardModuleDefinition[];
  let fixture: ComponentFixture<GfDashboardCanvasComponent>;
  // Stubbed rather than resolved for real: the shell's own layout service is
  // `providedIn: 'root'`, but its constructor reaches the device detector and the
  // notification service to size dialogs - none of which this canvas exercises, and
  // all of which would have to be provided here to construct it.
  let layoutServiceMock: { shouldReloadContent$: Observable<void> };
  let originalResizeObserverDescriptor: PropertyDescriptor;
  let originalScrollIntoViewDescriptor: PropertyDescriptor;
  let registryServiceMock: { get: jest.Mock; getAll: jest.Mock };
  let revealModuleSubject: Subject<DashboardModuleType>;
  /**
   * Typed from the real method rather than from how this suite happens to call it.
   *
   * The argument tuple is not decoration: `jest.Mock<R, A>` types `mock.calls` as
   * `A[]`, so declaring `A` as `[]` - which is what an implementation taking no
   * parameters invites - made every recorded call an empty tuple as far as the
   * compiler was concerned. Reading a command list and its extras back off
   * `mock.calls` then needed an assertion that TypeScript rejected outright
   * (TS2352, "neither type sufficiently overlaps"), and because Jest transpiles
   * each spec in isolation the suite still ran: a red spec program and a green
   * test run at the same time. Deriving both halves from `Router['navigate']`
   * makes the recorded calls carry the router's own types, so the assertion is
   * unnecessary rather than merely tolerated.
   */
  let routerMock: {
    navigate: jest.Mock<
      ReturnType<Router['navigate']>,
      Parameters<Router['navigate']>
    >;
  };
  let saveErrorSubject: BehaviorSubject<boolean>;
  let scrollIntoViewMock: jest.Mock;
  let shouldReloadContentSubject: Subject<void>;
  let tokenStorageServiceMock: { saveToken: jest.Mock };
  let userServiceMock: {
    get: jest.Mock;
    // Widened to allow no state at all, because the real store genuinely emits that
    // way before it has been primed - and the canvas has to survive it.
    stateChanged: BehaviorSubject<CanvasViewerState | null>;
  };

  /**
   * `markets` is here specifically because it is free while `markets-premium` is not,
   * so a viewer entitled to nothing still sees something - which is what stops the
   * visibility tests passing for the wrong reason. Every footprint differs from its
   * neighbours so "the size came from this definition" cannot be satisfied by
   * accident.
   *
   * Rebuilt per test so loader call records cannot leak between them.
   */
  const createDefinitions = (): DashboardModuleDefinition[] => {
    return [
      {
        defaultItemCols: 6,
        defaultItemRows: 4,
        loadComponent: jest.fn(),
        minItemCols: 2,
        minItemRows: 2,
        moduleType: DashboardModuleType.HOLDINGS,
        name: 'Holdings'
      },
      {
        defaultItemCols: 4,
        defaultItemRows: 3,
        loadComponent: jest.fn(),
        minItemCols: 3,
        minItemRows: 2,
        moduleType: DashboardModuleType.MARKETS,
        name: 'Markets'
      },
      {
        defaultItemCols: 8,
        defaultItemRows: 6,
        loadComponent: jest.fn(),
        minItemCols: 4,
        minItemRows: 4,
        moduleType: DashboardModuleType.ADMIN_OVERVIEW,
        name: 'Admin Control',
        permission: permissions.accessAdminControl
      },
      {
        defaultItemCols: 5,
        defaultItemRows: 6,
        loadComponent: jest.fn(),
        minItemCols: 2,
        minItemRows: 4,
        moduleType: DashboardModuleType.AI_CHAT,
        name: 'AI Chat',
        permission: permissions.readAiPrompt
      },
      {
        // The qualifier the real registry gives this entry, and the reason it is here:
        // two modules are titled `Markets`, and every place a module is NAMED to a
        // person has to distinguish them. Without a fixture that reproduces the
        // collision, nothing in this file could tell whether it does.
        context: 'Market Data',
        defaultItemCols: 7,
        defaultItemRows: 5,
        loadComponent: jest.fn(),
        minItemCols: 3,
        minItemRows: 3,
        moduleType: DashboardModuleType.MARKETS_PREMIUM,
        name: 'Markets',
        permission: permissions.readMarketDataOfMarkets
      }
    ];
  };

  /**
   * Stops short of the first render on purpose: the canvas finishes resolving the
   * viewer and their arrangement while it is being constructed, so the gap before the
   * first change-detection pass is where "before the canvas was painted" is
   * observable.
   */
  const createCanvas = async (scenario: CanvasScenario = {}) => {
    const {
      allowsNavigation = false,
      layout = of(null),
      queryParams = {},
      viewerRequest = EMPTY
    } = scenario;

    // Read with `in` rather than through a destructuring default, because
    // `undefined` is a meaningful value here - it is the store's "nobody has
    // answered yet" - and a default would silently replace it with a viewer.
    const viewer = 'viewer' in scenario ? scenario.viewer : signedInViewer;

    // Backed by a subject rather than a static observable so that a test can put
    // the root route through a genuine parameter change - dropping the share
    // parameter, most importantly, which is what takes the canvas out of the
    // shared-portfolio state. It is seeded with the scenario's parameters and
    // delivers them synchronously on subscribe, exactly as `of()` did.
    queryParamsSubject = new BehaviorSubject<Record<string, string>>(
      queryParams
    );

    activatedRouteMock = {
      queryParams: queryParamsSubject.asObservable(),
      snapshot: { queryParams }
    };

    identityTransitionSubject = new Subject<void>();
    conflictSubject = new BehaviorSubject<boolean>(false);
    saveErrorSubject = new BehaviorSubject<boolean>(false);
    shouldReloadContentSubject = new Subject<void>();

    // Only the one member the canvas consumes. The shell owns this subject and the
    // control bar is what pushes to it; the canvas is strictly a subscriber, and
    // exposing nothing else keeps that assertable.
    layoutServiceMock = {
      shouldReloadContent$: shouldReloadContentSubject.asObservable()
    };

    dashboardLayoutServiceMock = {
      adoptIdentity: jest.fn<void, [string]>(),
      beginIdentityTransition: jest.fn<void, []>(),
      // A delete rather than a write, which is what lets an uninterpretable
      // arrangement be recovered from without giving the error state a way to store
      // one. Declared as a subject so a test can make it fail as well as succeed.
      discard: jest.fn(() => discardResponse),
      // Abandoning a failed read gives up whatever was being held for retry,
      // because it belongs to the arrangement just left behind. Like the retry
      // itself this is a bare delegation and is asserted as one.
      discardFailedSave: jest.fn<void, []>(),
      dismissConflict: jest.fn(),
      get: jest.fn(() => layout),
      // A refused write is a separate channel from a failed one, because the
      // recoveries are opposites: one is a retry, the other a choice between two
      // arrangements.
      getHasConflict: jest.fn(() => conflictSubject.asObservable()),
      // The canvas only mirrors this state; the snapshot whose write failed stays
      // with the service, which is why the retry is a bare delegation and is
      // asserted as one.
      getHasSaveError: jest.fn(() => saveErrorSubject.asObservable()),
      identityTransition$: identityTransitionSubject.asObservable(),
      overwriteAfterConflict: jest.fn(),
      retryFailedSave: jest.fn(),
      scheduleSave: jest.fn<void, [string, DashboardLayoutItem[]]>()
    };

    // Named so that "the canvas never writes the layout itself" is assertable. The
    // canvas does not inject this service and every child that might has been
    // replaced, so these two must stay untouched; a future canvas that reached for
    // the HTTP facade directly would resolve this very mock and be caught.
    dataServiceMock = {
      fetchUserDashboardLayout: jest.fn(),
      patchUserDashboardLayout: jest.fn()
    };

    registryServiceMock = {
      get: jest.fn((aModuleType: DashboardModuleType) => {
        return definitions.find(({ moduleType }) => moduleType === aModuleType);
      }),
      // A fresh array of the same objects, mirroring the real service: the array is
      // the service's to rebuild, while the definitions inside it are shared by
      // reference, which is the contract the module chrome relies on.
      getAll: jest.fn(() => [...definitions])
    };

    revealModuleSubject = new Subject<DashboardModuleType>();

    // Records like any other spy so that "no navigation" stays assertable, and
    // refuses like no other spy so that a navigation nobody declared cannot pass
    // unnoticed. The scenario flag is the whole permission system: only the
    // spent-token clean-up sets it.
    routerMock = {
      navigate: jest.fn<
        ReturnType<Router['navigate']>,
        Parameters<Router['navigate']>
      >(() => {
        if (!allowsNavigation) {
          throw new Error(
            'The canvas navigated in a scenario that does not permit it. The router still owns the single root route and the canvas addresses no screen; the only navigation it may make is removing a spent jwt parameter.'
          );
        }

        return Promise.resolve(true);
      })
    };

    // Only the two members the canvas reaches for. `confirm` records the parameters
    // it was handed and, unless a test says otherwise, confirms immediately - so a
    // destructive action's guard is observable AND the action behind it is reachable
    // without driving a real dialog.
    notificationServiceMock = {
      alert: jest.fn<void, [AlertParams]>(),
      confirm: jest.fn((params: ConfirmParams) => {
        confirmParams = params;

        if (confirmsAutomatically) {
          params.confirmFn();
        }
      })
    };

    tokenStorageServiceMock = { saveToken: jest.fn() };

    userServiceMock = {
      get: jest.fn(() => viewerRequest),
      stateChanged: new BehaviorSubject<CanvasViewerState | null>({
        user: viewer
      })
    };

    await TestBed.configureTestingModule({
      imports: [GfDashboardCanvasComponent],
      providers: [
        { provide: ActivatedRoute, useValue: activatedRouteMock },
        {
          provide: DashboardIntentService,
          useValue: {
            getRevealModuleSubject: () => revealModuleSubject,
            revealModule$: revealModuleSubject.asObservable()
          }
        },
        {
          provide: GfModuleRegistryService,
          useValue: registryServiceMock
        },
        { provide: DataService, useValue: dataServiceMock },
        {
          provide: GfDashboardLayoutService,
          useValue: dashboardLayoutServiceMock
        },
        { provide: LayoutService, useValue: layoutServiceMock },
        { provide: NotificationService, useValue: notificationServiceMock },
        // Required rather than tidy-minded, and the catalog drawer is why. Material
        // enables CSS transitions on a drawer container 200ms after it is
        // constructed, and from that point on the drawer only reports `openedChange`
        // when it receives a real `transitionend` - an event this environment
        // performs no layout to produce, so the report the focus lifecycle hangs off
        // would simply never arrive. Worse, it depends on wall-clock timing: a test
        // that ran inside those 200ms would see the report and one that ran after it
        // would not. Disabling animations keeps the drawer on its no-transition
        // path, where it reports on a macrotask every time. It also removes that
        // stray timer from every other test in this suite.
        provideNoopAnimations(),
        { provide: Router, useValue: routerMock },
        { provide: TokenStorageService, useValue: tokenStorageServiceMock },
        { provide: UserService, useValue: userServiceMock }
      ]
    })
      .overrideComponent(GfDashboardCanvasComponent, {
        add: {
          imports: [
            GfTestDashboardModuleHostComponent,
            GfTestDashboardToolbarComponent,
            GfTestModuleCatalogComponent,
            GfTestPublicPortfolioComponent,
            GfTestSignInPromptComponent
          ]
        },
        remove: {
          imports: [
            GfDashboardModuleHostComponent,
            GfDashboardToolbarComponent,
            GfModuleCatalogComponent,
            GfPublicPortfolioComponent,
            GfSignInPromptComponent
          ]
        }
      })
      .compileComponents();

    fixture = TestBed.createComponent(GfDashboardCanvasComponent);
    component = fixture.componentInstance;
  };

  const paint = () => {
    fixture.detectChanges();
  };

  /**
   * Paints, then lets the canvas's hydration settle window close.
   *
   * The canvas records but does not WRITE a change the grid engine reports while it
   * is admitting a freshly applied arrangement, because the engine resolves
   * collisions as it admits each cell and reports the correction through the same
   * callback a drag reports through - which used to make merely opening a dashboard
   * that needed normalizing save a rewritten copy of it. The window closes on the
   * next macrotask, and at the first thing the viewer does.
   *
   * Every test that reports a change by invoking a grid callback DIRECTLY, rather
   * than through one of the canvas's own intent paths, therefore has to get past
   * that window first - which is exactly what a viewer does simply by existing for
   * one task before touching anything.
   */
  const paintAndSettle = async () => {
    fixture.detectChanges();

    await new Promise<void>((resolve) => setTimeout(resolve));
  };

  /**
   * Paints, then waits for the deferred shared-portfolio block to arrive, then
   * paints again.
   *
   * The shared portfolio is the one branch of this template behind `@defer`,
   * because it is also the one branch a signed-in viewer never reaches and the one
   * that reaches the charting and map libraries - deferring it is what keeps all
   * of that out of every visitor's initial bundle. The trade is that the branch
   * resolves on a later tick than the parameter that selected it, so a test
   * looking for its element has to wait for that resolution rather than race it.
   */
  const paintDeferredBlocks = async () => {
    fixture.detectChanges();

    await fixture.whenStable();

    fixture.detectChanges();
  };

  function queryElement<T extends HTMLElement>(aSelector: string) {
    return (fixture.nativeElement as HTMLElement).querySelector<T>(aSelector);
  }

  function queryElements<T extends HTMLElement>(aSelector: string) {
    return Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll<T>(aSelector)
    );
  }

  const gridsterComponent = (): Gridster => {
    return fixture.debugElement
      .query(By.directive(Gridster))
      .injector.get(Gridster);
  };

  const gridsterItemComponents = (): GridsterItem[] => {
    return fixture.debugElement
      .queryAll(By.directive(GridsterItem))
      .map((cell) => {
        return cell.injector.get(GridsterItem);
      });
  };

  const moduleCatalogComponent = (): GfTestModuleCatalogComponent => {
    return fixture.debugElement
      .query(By.directive(GfTestModuleCatalogComponent))
      .injector.get(GfTestModuleCatalogComponent);
  };

  const moduleHostComponents = (): GfTestDashboardModuleHostComponent[] => {
    return fixture.debugElement
      .queryAll(By.directive(GfTestDashboardModuleHostComponent))
      .map((host) => {
        return host.injector.get(GfTestDashboardModuleHostComponent);
      });
  };

  const renderedModuleTypes = (): DashboardModuleType[] => {
    return moduleHostComponents().map(
      ({ definition }) => definition?.moduleType
    );
  };

  const placedGeometry = () => {
    return component.modules.map(({ cols, moduleType, rows, x, y }) => ({
      cols,
      moduleType,
      rows,
      x,
      y
    }));
  };

  const placedMinimums = () => {
    return component.modules.map(
      ({ minItemCols, minItemRows, moduleType }) => ({
        minItemCols,
        minItemRows,
        moduleType
      })
    );
  };

  const gridChangeCallbacks = (): ((
    aItem: GridsterItemConfig,
    aItemComponent: GridsterItem
  ) => void)[] => {
    return [
      component.options.itemChangeCallback,
      component.options.itemInitCallback,
      component.options.itemRemovedCallback,
      component.options.itemResizeCallback
    ];
  };

  const dropOnEmptyCell = (
    aModuleType: string | null,
    aCell: { x: number; y: number } = { x: 0, y: 0 }
  ) => {
    const getData = jest.fn((aFormat: string) => {
      return aFormat === 'text/plain' ? aModuleType : null;
    });

    const dropCallback: (
      aEvent: MouseEvent,
      aItem: GridsterItemConfig
    ) => void = component.options.emptyCellDropCallback;

    dropCallback(
      Object.assign(new MouseEvent('drop'), {
        dataTransfer: aModuleType === null ? null : { getData }
      }),
      { cols: 4, rows: 4, x: aCell.x, y: aCell.y }
    );

    return getData;
  };

  beforeEach(() => {
    definitions = createDefinitions();

    confirmsAutomatically = true;
    confirmParams = undefined;
    discardResponse = of(undefined);

    // jsdom implements no `scrollIntoView`. The canvas already calls it optionally,
    // so its absence cannot fault the reveal path - but it also cannot be observed,
    // and revealing a module that is already placed is behaviour worth asserting.
    // The descriptor is captured rather than the method so that whatever was there,
    // including nothing at all, is put back exactly as it was.
    originalScrollIntoViewDescriptor = Object.getOwnPropertyDescriptor(
      Element.prototype,
      'scrollIntoView'
    );
    scrollIntoViewMock = jest.fn();
    Element.prototype.scrollIntoView = scrollIntoViewMock;

    // Same treatment for the same reason: jsdom ships no `ResizeObserver`, and the
    // canvas skips the path entirely when it is missing.
    GfTestResizeObserver.instances = [];
    originalResizeObserverDescriptor = Object.getOwnPropertyDescriptor(
      globalThis,
      'ResizeObserver'
    );
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver =
      GfTestResizeObserver;
  });

  afterEach(() => {
    // Restored rather than left behind: a patched prototype poisons every later
    // spec in the run, and does so somewhere else.
    if (originalScrollIntoViewDescriptor) {
      Object.defineProperty(
        Element.prototype,
        'scrollIntoView',
        originalScrollIntoViewDescriptor
      );
    } else {
      Reflect.deleteProperty(Element.prototype, 'scrollIntoView');
    }

    if (originalResizeObserverDescriptor) {
      Object.defineProperty(
        globalThis,
        'ResizeObserver',
        originalResizeObserverDescriptor
      );
    } else {
      Reflect.deleteProperty(globalThis, 'ResizeObserver');
    }
  });

  it('should create', async () => {
    await createCanvas();
    paint();

    expect(component).toBeTruthy();
  });

  describe('a first visit with no saved arrangement', () => {
    it('should mark the canvas ready once the viewer and their arrangement have resolved', async () => {
      await createCanvas({ layout: of(null) });
      paint();

      expect(component.isInitialized).toBe(true);
      expect(component.isSignedOut).toBe(false);
      expect(component.isPublicPortfolio).toBe(false);
    });

    it('should open the module catalog before the canvas is first painted', async () => {
      await createCanvas({ layout: of(null) });

      expect(component.isCatalogOpen).toBe(true);
      expect(component.isInitialized).toBe(true);
    });

    it('should render the empty notice with the catalog panel already open', async () => {
      await createCanvas({ layout: of(null) });
      paint();

      expect(queryElement('gf-empty-canvas-state')).toBeTruthy();
      expect(queryElement('mat-sidenav.mat-drawer-opened')).toBeTruthy();
      expect(queryElement('gf-module-catalog')).toBeTruthy();
    });

    it('should place nothing on the canvas', async () => {
      await createCanvas({ layout: of(null) });
      paint();

      expect(component.modules).toEqual([]);
      expect(queryElements('gridster-item')).toHaveLength(0);
      expect(queryElements('gf-dashboard-module-host')).toHaveLength(0);
    });

    it('should keep the grid mounted beneath the empty notice', async () => {
      await createCanvas({ layout: of(null) });
      paint();

      expect(queryElement('gridster')).toBeTruthy();
    });

    it('should report no layout change while nothing has been arranged', async () => {
      await createCanvas({ layout: of(null) });
      paint();

      expect(dashboardLayoutServiceMock.scheduleSave).not.toHaveBeenCalled();
    });

    it('should read the arrangement without bypassing the cache', async () => {
      await createCanvas({ layout: of(null) });
      paint();

      expect(dashboardLayoutServiceMock.get).toHaveBeenCalledTimes(1);
      expect(dashboardLayoutServiceMock.get).toHaveBeenCalledWith(false);
    });

    it('should issue no navigation', async () => {
      await createCanvas({ layout: of(null) });
      paint();

      expect(routerMock.navigate).not.toHaveBeenCalled();
    });
  });

  /**
   * The interval between the viewer answering and their arrangement answering.
   *
   * Two reads stand between opening the application and knowing what is on this
   * canvas, and they are serialized. Drawing nothing until the second of them
   * answers left the browser with a background and no content for the whole of
   * that interval, which on a cold cache is measured in seconds - even though the
   * viewer is already known and every capability on the control bar is already
   * available. What is drawn here is exactly what does not depend on the
   * arrangement, and nothing that does.
   */
  describe('an arrangement that has not answered yet', () => {
    const pendingCanvas = async () => {
      // A read that never answers, so the canvas is held in the interval under
      // test rather than passing through it.
      await createCanvas({ layout: EMPTY });
      paint();
    };

    it('should draw the control bar as soon as there is a viewer to draw it for', async () => {
      await pendingCanvas();

      expect(component.hasResolvedViewer).toBe(true);
      expect(component.isInitialized).toBe(false);
      expect(queryElement('gf-dashboard-toolbar')).toBeTruthy();
    });

    it('should stand the arrangement in with placeholders', async () => {
      await pendingCanvas();

      // Text-free on purpose, so this state adds no message to translate;
      // `aria-busy` is what reports that the region is mid-update.
      expect(queryElement('[aria-busy="true"]')).toBeTruthy();
      expect(queryElements('ngx-skeleton-loader').length).toBeGreaterThan(0);
    });

    it('should claim nothing about an arrangement nobody has answered with', async () => {
      await pendingCanvas();

      // Neither of the two things that WOULD be a claim: the empty notice says the
      // viewer has nothing arranged, and the failed-read card says the read went
      // wrong. Neither is known here.
      expect(queryElement('gf-empty-canvas-state')).toBeNull();
      expect(component.hasLayoutError).toBe(false);
      expect(queryElements('gridster-item')).toHaveLength(0);
      expect(component.modules).toEqual([]);
    });

    /**
     * Rule 10 turns on this. An empty arrangement has to find the catalog already
     * open the first time the canvas is painted, which holds only while the drawer
     * is created AFTER the open state is known. Creating it in this state -
     * necessarily closed, because the arrangement has not answered - would turn
     * that into an animation the viewer watches instead.
     */
    it('should create neither the drawer nor its trigger before the arrangement is known', async () => {
      await pendingCanvas();

      expect(queryElement('mat-sidenav')).toBeNull();
      expect(queryElement('gf-module-catalog')).toBeNull();
      expect(queryElement('.gf-dashboard-catalog-trigger')).toBeNull();
      expect(queryElement('gridster')).toBeNull();
    });

    it('should write nothing while the arrangement is outstanding', async () => {
      await pendingCanvas();

      expect(dashboardLayoutServiceMock.scheduleSave).not.toHaveBeenCalled();
    });

    // Nobody has answered at all, so there is no viewer to draw a control bar for
    // either. This is the one state with genuinely nothing to draw, and it is what
    // the branch above must not be confused with.
    it('should draw nothing at all before the viewer has answered', async () => {
      await createCanvas({ viewer: undefined, viewerRequest: EMPTY });
      paint();

      expect(component.hasResolvedViewer).toBe(false);
      expect(queryElement('gf-dashboard-toolbar')).toBeNull();
      expect(queryElement('[aria-busy="true"]')).toBeNull();
      expect(queryElement('gf-sign-in-prompt')).toBeNull();
    });

    /**
     * The control bar is created once and outlives the arrangement arriving.
     *
     * It is drawn from outside the branch that switches on the arrangement
     * precisely so that it is not torn down and rebuilt when the answer lands -
     * a rebuild would make every capability on it resolve a second time, which is
     * the opposite of the saving this state exists to make.
     */
    it('should keep the same control bar when the arrangement arrives', async () => {
      const layout = new Subject<UserDashboardLayout>();

      await createCanvas({ layout: layout.asObservable() });
      paint();

      const toolbarBefore = fixture.debugElement
        .query(By.directive(GfTestDashboardToolbarComponent))
        .injector.get(GfTestDashboardToolbarComponent);

      layout.next({
        modules: [{ cols: 5, moduleType: 'holdings', rows: 4, x: 0, y: 0 }],
        version: 1
      });
      paint();

      const toolbarAfter = fixture.debugElement
        .query(By.directive(GfTestDashboardToolbarComponent))
        .injector.get(GfTestDashboardToolbarComponent);

      expect(component.isInitialized).toBe(true);
      expect(toolbarAfter).toBe(toolbarBefore);
      expect(queryElement('[aria-busy="true"]')).toBeNull();
      expect(queryElement('gridster')).toBeTruthy();
      expect(renderedModuleTypes()).toEqual([DashboardModuleType.HOLDINGS]);
    });
  });

  describe('a saved arrangement that names no modules', () => {
    it('should treat an empty module list exactly as no saved arrangement', async () => {
      await createCanvas({ layout: of({ modules: [], version: 1 }) });

      expect(component.isCatalogOpen).toBe(true);

      paint();

      expect(component.modules).toEqual([]);
      expect(queryElement('gf-empty-canvas-state')).toBeTruthy();
      expect(queryElement('mat-sidenav.mat-drawer-opened')).toBeTruthy();
    });
  });

  describe('a returning viewer', () => {
    const savedLayout: UserDashboardLayout = {
      modules: [
        { cols: 5, moduleType: 'holdings', rows: 7, x: 0, y: 3 },
        { cols: 6, moduleType: 'markets', rows: 2, x: 5, y: 0 }
      ],
      version: 1
    };

    it('should hydrate every module at exactly the cell and size that were saved', async () => {
      await createCanvas({ layout: of(savedLayout) });
      paint();

      expect(placedGeometry()).toEqual([
        {
          cols: 5,
          moduleType: DashboardModuleType.HOLDINGS,
          rows: 7,
          x: 0,
          y: 3
        },
        {
          cols: 6,
          moduleType: DashboardModuleType.MARKETS,
          rows: 2,
          x: 5,
          y: 0
        }
      ]);
    });

    it('should copy the declared minimum footprint onto every hydrated module', async () => {
      await createCanvas({ layout: of(savedLayout) });
      paint();

      expect(placedMinimums()).toEqual([
        {
          minItemCols: 2,
          minItemRows: 2,
          moduleType: DashboardModuleType.HOLDINGS
        },
        {
          minItemCols: 3,
          minItemRows: 2,
          moduleType: DashboardModuleType.MARKETS
        }
      ]);
    });

    it('should leave the catalog closed', async () => {
      await createCanvas({ layout: of(savedLayout) });

      expect(component.isCatalogOpen).toBe(false);

      paint();

      expect(queryElement('mat-sidenav.mat-drawer-opened')).toBeNull();
    });

    it('should not render the empty notice', async () => {
      await createCanvas({ layout: of(savedLayout) });
      paint();

      expect(queryElement('gf-empty-canvas-state')).toBeNull();
    });

    it('should render one grid cell per hydrated module', async () => {
      await createCanvas({ layout: of(savedLayout) });
      paint();

      expect(gridsterItemComponents()).toHaveLength(2);
      expect(renderedModuleTypes()).toEqual([
        DashboardModuleType.HOLDINGS,
        DashboardModuleType.MARKETS
      ]);
    });

    it('should resolve no module component while hydrating', async () => {
      await createCanvas({ layout: of(savedLayout) });
      paint();

      for (const { loadComponent } of definitions) {
        expect(loadComponent).not.toHaveBeenCalled();
      }
    });

    it('should hand the module chrome the registry own definition object', async () => {
      await createCanvas({ layout: of(savedLayout) });
      paint();

      const [holdings, markets] = definitions;

      expect(moduleHostComponents()[0].definition).toBe(holdings);
      expect(moduleHostComponents()[1].definition).toBe(markets);
    });

    it('should report no layout change merely by hydrating', async () => {
      await createCanvas({ layout: of(savedLayout) });
      paint();

      expect(dashboardLayoutServiceMock.scheduleSave).not.toHaveBeenCalled();
    });
  });

  describe('a saved arrangement the registry can no longer honour', () => {
    it('should drop a discriminator the registry no longer knows and keep the rest', async () => {
      await createCanvas({
        layout: of({
          modules: [
            { cols: 5, moduleType: 'holdings', rows: 4, x: 0, y: 0 },
            { cols: 4, moduleType: 'legacy-net-worth', rows: 4, x: 5, y: 0 }
          ],
          version: 1
        })
      });
      paint();

      expect(renderedModuleTypes()).toEqual([DashboardModuleType.HOLDINGS]);
      expect(component.modules).toHaveLength(1);
    });

    it('should not throw while rendering an arrangement with an unknown discriminator', async () => {
      await createCanvas({
        layout: of({
          modules: [
            { cols: 4, moduleType: 'legacy-net-worth', rows: 4, x: 0, y: 0 }
          ],
          version: 1
        })
      });

      expect(() => paint()).not.toThrow();
    });

    it('should resolve every placed discriminator through the registry', async () => {
      await createCanvas({
        layout: of({
          modules: [{ cols: 5, moduleType: 'holdings', rows: 4, x: 0, y: 0 }],
          version: 1
        })
      });
      paint();

      expect(registryServiceMock.getAll).toHaveBeenCalled();
      expect(renderedModuleTypes()).toEqual([DashboardModuleType.HOLDINGS]);
    });

    it('should drop a discriminator that appears twice', async () => {
      await createCanvas({
        layout: of({
          modules: [
            { cols: 5, moduleType: 'holdings', rows: 4, x: 0, y: 0 },
            { cols: 4, moduleType: 'holdings', rows: 4, x: 5, y: 0 }
          ],
          version: 1
        })
      });
      paint();

      expect(placedGeometry()).toEqual([
        {
          cols: 5,
          moduleType: DashboardModuleType.HOLDINGS,
          rows: 4,
          x: 0,
          y: 0
        }
      ]);
    });

    it('should open the catalog when every saved module had to be dropped', async () => {
      await createCanvas({
        layout: of({
          modules: [
            { cols: 4, moduleType: 'legacy-net-worth', rows: 4, x: 0, y: 0 }
          ],
          version: 1
        })
      });

      expect(component.isCatalogOpen).toBe(true);

      paint();

      expect(queryElement('gf-empty-canvas-state')).toBeTruthy();
    });

    describe('reporting what was dropped', () => {
      let warn: jest.SpyInstance;

      beforeEach(() => {
        warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      });

      afterEach(() => {
        warn.mockRestore();
      });

      it('should report every discarded entry once, as a count', async () => {
        await createCanvas({
          layout: of({
            modules: [
              { cols: 5, moduleType: 'holdings', rows: 4, x: 0, y: 0 },
              { cols: 4, moduleType: 'legacy-net-worth', rows: 4, x: 5, y: 0 },
              { cols: 4, moduleType: 'holdings', rows: 4, x: 0, y: 4 },
              {
                cols: 4,
                moduleType: 'markets',
                rows: Number.NaN,
                x: 0,
                y: 8
              } as never
            ],
            version: 1
          })
        });
        paint();

        // Two entries could not be carried over - the repeat, and the one whose
        // geometry describes no cell - and the next grid change the viewer makes
        // persists the arrangement without them. Silence was the avoidable part:
        // one line makes an arrangement that arrived larger than it was drawn
        // visible, instead of leaving it to be inferred from missing modules.
        //
        // The retired discriminator is deliberately NOT among them. This build not
        // recognising a module type says nothing about whether the type exists, so
        // the entry is retained in the saved document and merely not drawn - which
        // is why the count is two while only one module renders.
        expect(renderedModuleTypes()).toEqual([DashboardModuleType.HOLDINGS]);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledWith(
          'GF-DASHBOARD-LAYOUT-ITEMS-DROPPED (count 2)'
        );
      });

      it('should report nothing at all when the whole arrangement resolved', async () => {
        await createCanvas({
          layout: of({
            modules: [{ cols: 5, moduleType: 'holdings', rows: 4, x: 0, y: 0 }],
            version: 1
          })
        });
        paint();

        expect(warn).not.toHaveBeenCalled();
      });

      it('should name no discriminator it discarded', async () => {
        await createCanvas({
          layout: of({
            modules: [
              {
                cols: 4,
                moduleType: '<img src=x onerror=alert(1)>',
                rows: Number.NaN,
                x: 0,
                y: 0
              } as never
            ],
            version: 1
          })
        });
        paint();

        // The value comes out of a stored document that the owner's own client
        // wrote, and the console is readable by every script on the page and
        // captured verbatim by session tooling. A fixed identifier and a count are
        // what an operator acts on; the offending value is not.
        expect(warn).toHaveBeenCalledWith(
          'GF-DASHBOARD-LAYOUT-ITEMS-DROPPED (count 1)'
        );
        expect(JSON.stringify(warn.mock.calls)).not.toContain('onerror');
      });
    });
  });

  describe('module visibility', () => {
    const gatedLayout: UserDashboardLayout = {
      modules: [
        { cols: 8, moduleType: 'admin-overview', rows: 6, x: 0, y: 0 },
        { cols: 4, moduleType: 'markets', rows: 3, x: 8, y: 0 },
        { cols: 5, moduleType: 'ai-chat', rows: 6, x: 0, y: 6 },
        { cols: 7, moduleType: 'markets-premium', rows: 5, x: 5, y: 6 }
      ],
      version: 1
    };

    it('should render only the modules a viewer entitled to nothing may see', async () => {
      await createCanvas({
        layout: of(gatedLayout),
        viewer: { id: 'viewer-1', permissions: [] }
      });
      paint();

      expect(renderedModuleTypes()).toEqual([DashboardModuleType.MARKETS]);
    });

    it('should render an administrative module for a viewer who holds the permission', async () => {
      await createCanvas({
        layout: of(gatedLayout),
        viewer: {
          id: 'viewer-1',
          permissions: [permissions.accessAdminControl]
        }
      });
      paint();

      expect(renderedModuleTypes()).toEqual([
        DashboardModuleType.ADMIN_OVERVIEW,
        DashboardModuleType.MARKETS
      ]);
    });

    it('should render the assistant module only for a viewer who may read prompts', async () => {
      await createCanvas({
        layout: of(gatedLayout),
        viewer: { id: 'viewer-1', permissions: [permissions.readAiPrompt] }
      });
      paint();

      expect(renderedModuleTypes()).toEqual([
        DashboardModuleType.MARKETS,
        DashboardModuleType.AI_CHAT
      ]);
    });

    it('should render every gated module for a fully entitled viewer', async () => {
      await createCanvas({
        layout: of(gatedLayout),
        viewer: {
          id: 'viewer-1',
          permissions: [
            permissions.accessAdminControl,
            permissions.readAiPrompt,
            permissions.readMarketDataOfMarkets
          ]
        }
      });
      paint();

      expect(renderedModuleTypes()).toEqual([
        DashboardModuleType.ADMIN_OVERVIEW,
        DashboardModuleType.MARKETS,
        DashboardModuleType.AI_CHAT,
        DashboardModuleType.MARKETS_PREMIUM
      ]);
    });

    it('should open the catalog for a viewer whose whole arrangement is gated away', async () => {
      await createCanvas({
        layout: of({
          modules: [
            { cols: 8, moduleType: 'admin-overview', rows: 6, x: 0, y: 0 }
          ],
          version: 1
        }),
        viewer: { id: 'viewer-1', permissions: [] }
      });

      expect(component.isCatalogOpen).toBe(true);

      paint();

      expect(renderedModuleTypes()).toEqual([]);
      expect(queryElement('gf-empty-canvas-state')).toBeTruthy();
    });

    it('should take a placed module off the canvas when its permission is withdrawn', async () => {
      await createCanvas({
        layout: of(gatedLayout),
        viewer: {
          id: 'viewer-1',
          permissions: [permissions.accessAdminControl]
        }
      });
      paint();

      expect(renderedModuleTypes()).toEqual([
        DashboardModuleType.ADMIN_OVERVIEW,
        DashboardModuleType.MARKETS
      ]);

      // The same identity, with one entitlement fewer. A permission can lapse while
      // the canvas is up - a subscription expiring, an administrative role being
      // taken away - and the modules placed while it was held must not keep drawing
      // their content.
      userServiceMock.stateChanged.next({
        user: { id: 'viewer-1', permissions: [] }
      });
      paint();

      expect(renderedModuleTypes()).toEqual([DashboardModuleType.MARKETS]);
    });

    it('should not persist an arrangement that a withdrawn permission reduced', async () => {
      await createCanvas({
        layout: of(gatedLayout),
        viewer: {
          id: 'viewer-1',
          permissions: [permissions.accessAdminControl]
        }
      });
      paint();

      userServiceMock.stateChanged.next({
        user: { id: 'viewer-1', permissions: [] }
      });
      paint();

      // Reconciling by re-reading and re-filtering is what makes this safe: the
      // hydration path reports no layout change, so a lapsed entitlement removes a
      // module from view without a write that would remove it for good - and the
      // module returns of its own accord if the entitlement does.
      expect(dashboardLayoutServiceMock.scheduleSave).not.toHaveBeenCalled();
    });

    it('should keep a module the viewer may not see in the arrangement it persists', async () => {
      await createCanvas({
        layout: of(gatedLayout),
        viewer: { id: 'viewer-1', permissions: [] }
      });
      await paintAndSettle();

      // Only one of the four is drawable for this viewer; the other three are
      // known modules they are simply not entitled to. Reporting the canvas as the
      // whole arrangement would delete all three from the stored document the very
      // first time the viewer dragged the one they can see - permanently, and as a
      // side effect of moving something unrelated.
      expect(renderedModuleTypes()).toEqual([DashboardModuleType.MARKETS]);

      const [itemComponent] = gridsterItemComponents();

      component.modules[0].x = 2;

      component.options.itemChangeCallback(component.modules[0], itemComponent);

      expect(dashboardLayoutServiceMock.scheduleSave).toHaveBeenCalledTimes(1);

      const [, reported] = dashboardLayoutServiceMock.scheduleSave.mock
        .calls[0] as [
        string,
        {
          cols: number;
          moduleType: string;
          rows: number;
          x: number;
          y: number;
        }[]
      ];

      expect(reported.map(({ moduleType }) => moduleType).sort()).toEqual(
        [
          DashboardModuleType.ADMIN_OVERVIEW,
          DashboardModuleType.AI_CHAT,
          DashboardModuleType.MARKETS,
          DashboardModuleType.MARKETS_PREMIUM
        ].sort()
      );

      // The visible module carries the geometry the grid just committed, exactly
      // where the viewer put it. That half is not negotiable: the module they can
      // see and did move keeps its cells.
      expect(reported).toEqual(
        expect.arrayContaining([
          {
            cols: 4,
            moduleType: DashboardModuleType.MARKETS,
            rows: 3,
            x: 2,
            y: 0
          }
        ])
      );

      // The hidden module was saved at column 0 row 0 and the drag above moved the
      // visible one on top of it, so it cannot still be there - the whole reason
      // this matters is that the grid engine does not know the cells are taken, so
      // nothing else was going to notice.
      const adminOverview = reported.find(
        ({ moduleType }) => moduleType === DashboardModuleType.ADMIN_OVERVIEW
      );

      expect(adminOverview).toEqual({
        cols: 8,
        moduleType: DashboardModuleType.ADMIN_OVERVIEW,
        rows: 6,
        x: 0,
        y: 3
      });

      // The invariant, asserted over the whole arrangement rather than over the one
      // pair this test happens to create: nothing in the persisted document
      // overlaps anything else in it. A stored overlap is durable and silent, and it
      // surfaces only when the entitlement returns and two modules claim the same
      // cells - by which point the arrangement the viewer sees depends on which one
      // the engine relocated.
      for (const module of reported) {
        for (const other of reported) {
          if (module === other) {
            continue;
          }

          const isOverlapping =
            module.x < other.x + other.cols &&
            other.x < module.x + module.cols &&
            module.y < other.y + other.rows &&
            other.y < module.y + module.rows;

          expect({
            isOverlapping,
            pair: `${module.moduleType}/${other.moduleType}`
          }).toEqual({
            isOverlapping: false,
            pair: `${module.moduleType}/${other.moduleType}`
          });
        }
      }
    });

    it('should forget a module the viewer removed while keeping one they may not see', async () => {
      await createCanvas({
        layout: of(gatedLayout),
        viewer: {
          id: 'viewer-1',
          permissions: [permissions.accessAdminControl]
        }
      });
      paint();

      expect(renderedModuleTypes()).toEqual([
        DashboardModuleType.ADMIN_OVERVIEW,
        DashboardModuleType.MARKETS
      ]);

      const [itemComponent] = gridsterItemComponents();
      const removedItem = component.modules[0];

      moduleHostComponents()[0].remove.emit();
      component.options.itemRemovedCallback(removedItem, itemComponent);

      const [, reported] = dashboardLayoutServiceMock.scheduleSave.mock
        .calls[0] as [string, { moduleType: string }[]];

      // Both the removed module and the two gated ones are absent from the canvas,
      // and permission is the only thing that tells them apart. Removing a module
      // the viewer *could* see is an instruction to forget it; a module they cannot
      // see was never theirs to remove.
      expect(reported.map(({ moduleType }) => moduleType).sort()).toEqual(
        [
          DashboardModuleType.AI_CHAT,
          DashboardModuleType.MARKETS,
          DashboardModuleType.MARKETS_PREMIUM
        ].sort()
      );
      expect(reported).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            moduleType: DashboardModuleType.ADMIN_OVERVIEW
          })
        ])
      );
    });

    it('should persist the arrangement as it stands now rather than as it was fetched', async () => {
      await createCanvas({
        layout: of(gatedLayout),
        viewer: { id: 'viewer-1', permissions: [] }
      });
      await paintAndSettle();

      const [itemComponent] = gridsterItemComponents();

      component.modules[0].x = 1;

      component.options.itemChangeCallback(component.modules[0], itemComponent);

      component.modules[0].x = 5;

      component.options.itemChangeCallback(component.modules[0], itemComponent);

      expect(dashboardLayoutServiceMock.scheduleSave).toHaveBeenCalledTimes(2);

      const [, secondReported] = dashboardLayoutServiceMock.scheduleSave.mock
        .calls[1] as [string, { moduleType: DashboardModuleType; x: number }[]];

      // The second report has to describe the second move. Holding the arrangement
      // as it was *fetched* and merging into that would have gone stale from the
      // first edit onwards, so every later snapshot would have re-sent the loaded
      // position.
      expect(
        secondReported.find(
          ({ moduleType }) => moduleType === DashboardModuleType.MARKETS
        ).x
      ).toBe(5);
    });

    it('should neither re-read nor write when a permission is granted', async () => {
      await createCanvas({
        layout: of(gatedLayout),
        viewer: { id: 'viewer-1', permissions: [] }
      });
      paint();

      expect(renderedModuleTypes()).toEqual([DashboardModuleType.MARKETS]);

      userServiceMock.stateChanged.next({
        user: {
          id: 'viewer-1',
          permissions: [permissions.accessAdminControl]
        }
      });
      paint();

      // Re-screened from the arrangement as fetched, which is remembered for
      // exactly this purpose, so the module returns at the cell it was saved at
      // and nothing already on screen moves. What must NOT happen is either half
      // of the expensive answer: re-reading would discard whatever the viewer has
      // moved since, and writing would record a correction the canvas made for
      // itself as though the viewer had made it.
      expect(renderedModuleTypes()).toEqual([
        DashboardModuleType.MARKETS,
        DashboardModuleType.ADMIN_OVERVIEW
      ]);
      expect(dashboardLayoutServiceMock.get).toHaveBeenCalledTimes(1);
      expect(dashboardLayoutServiceMock.scheduleSave).not.toHaveBeenCalled();
    });

    it('should still report a genuine change made after a permission was withdrawn', async () => {
      await createCanvas({
        layout: of(gatedLayout),
        viewer: {
          id: 'viewer-1',
          permissions: [permissions.accessAdminControl]
        }
      });
      await paintAndSettle();

      userServiceMock.stateChanged.next({
        user: { id: 'viewer-1', permissions: [] }
      });
      paint();

      expect(dashboardLayoutServiceMock.scheduleSave).not.toHaveBeenCalled();

      const [itemComponent] = gridsterItemComponents();

      // What a drag leaves behind: the engine writes the committed coordinates
      // straight onto the object inside the array and only then raises its
      // callback.
      component.modules[0].x = 3;

      component.options.itemChangeCallback(component.modules[0], itemComponent);

      // The suppression is exact rather than open-ended: it re-baselines against
      // the arrangement the withdrawal actually produced and nothing beyond it, so
      // the very next thing the viewer does is still saved.
      expect(dashboardLayoutServiceMock.scheduleSave).toHaveBeenCalledTimes(1);
    });

    it('should not read the arrangement again merely because a permission changed', async () => {
      await createCanvas({
        layout: of(gatedLayout),
        viewer: {
          id: 'viewer-1',
          permissions: [permissions.accessAdminControl]
        }
      });
      paint();

      userServiceMock.stateChanged.next({
        user: { id: 'viewer-1', permissions: [] }
      });
      paint();

      // The arrangement on screen is still this viewer's; only part of it is no
      // longer theirs to see. Editing what is placed is both cheaper and safer
      // than re-reading, which would also discard unsaved movement.
      expect(dashboardLayoutServiceMock.get).toHaveBeenCalledTimes(1);

      // The write authorisation is re-stated on every viewer emission, because
      // adopting the identity already held is a no-op by contract. What must hold
      // is that no emission named a *different* viewer and that no transition was
      // begun - either would have thrown away a pending write that is still this
      // viewer's to save.
      expect(dashboardLayoutServiceMock.adoptIdentity).toHaveBeenCalled();
      expect(
        dashboardLayoutServiceMock.adoptIdentity.mock.calls.every(
          ([userId]) => userId === 'viewer-1'
        )
      ).toBe(true);
      expect(
        dashboardLayoutServiceMock.beginIdentityTransition
      ).not.toHaveBeenCalled();
    });

    it('should resolve no module for a placed item the viewer may no longer see', async () => {
      await createCanvas({
        layout: of(gatedLayout),
        viewer: {
          id: 'viewer-1',
          permissions: [permissions.accessAdminControl]
        }
      });
      paint();

      userServiceMock.stateChanged.next({
        user: { id: 'viewer-1', permissions: [] }
      });

      // The render path is gated as well as the hydration path, and the difference
      // is the point of doing both: the template asks for a definition on every
      // change-detection pass, and an item that outlived its entitlement must
      // resolve to nothing, so the chrome draws its own notice and the gated
      // component is never instantiated - whatever left the item in the array.
      // Asked of `isModuleRenderable`, which is what the template consults per
      // cell. `getModuleDefinition` deliberately does not screen: it hands back the
      // registry's own object so the module host can compare definitions by
      // reference and avoid refetching a component class on every pass.
      const asPlaced = (
        moduleType: DashboardModuleType
      ): DashboardLayoutItem => {
        return { cols: 4, moduleType, rows: 4, x: 0, y: 0 };
      };

      expect(
        component.isModuleRenderable(asPlaced(DashboardModuleType.MARKETS))
      ).toBe(true);
      expect(
        component.isModuleRenderable(
          asPlaced(DashboardModuleType.ADMIN_OVERVIEW)
        )
      ).toBe(false);
    });
  });

  /**
   * Module visibility is screened on every path that mints a grid item, but those
   * paths only run when an arrangement is fetched or a module is added. What a
   * viewer is entitled to, however, changes while they are signed in - a lapsed
   * subscription, a revoked role - and the store re-emits the same viewer when it
   * does.
   *
   * These are therefore the tests for the *second* time the gate closes. A gate
   * that only ever screens once leaves a module the viewer has just lost
   * entitlement to on screen for the rest of the session.
   *
   * The two directions are asserted separately because they draw on different
   * sources: a revocation is answered from what is on the canvas now, a grant from
   * the arrangement as it was saved. Both are asserted through the rendered chrome
   * as well as through the array, and both assert that nothing was persisted -
   * losing a permission must not erase the module from the viewer's saved
   * arrangement.
   */
  describe('a permission change for the viewer already on the canvas', () => {
    /**
     * One free module and one behind each of the three permissions the real
     * registry uses, in disjoint column ranges so that whichever subset survives
     * is placeable exactly as saved.
     */
    const gatedLayout: UserDashboardLayout = {
      modules: [
        { cols: 8, moduleType: 'admin-overview', rows: 6, x: 0, y: 0 },
        { cols: 4, moduleType: 'markets', rows: 3, x: 8, y: 0 },
        { cols: 5, moduleType: 'ai-chat', rows: 6, x: 0, y: 6 }
      ],
      version: 1
    };

    /** Re-emits the same viewer with a different permission set. */
    const changePermissionsTo = (aPermissions: string[]) => {
      userServiceMock.stateChanged.next({
        user: { id: 'viewer-1', permissions: aPermissions }
      });

      paint();
    };

    it('should stop rendering a module whose permission was revoked', async () => {
      await createCanvas({
        layout: of(gatedLayout),
        viewer: {
          id: 'viewer-1',
          permissions: [permissions.accessAdminControl]
        }
      });
      paint();

      expect(renderedModuleTypes()).toEqual([
        DashboardModuleType.ADMIN_OVERVIEW,
        DashboardModuleType.MARKETS
      ]);

      changePermissionsTo([]);

      // Both halves matter: the array is what the grid engine and the persistence
      // projection read, and the chrome is what the viewer can actually reach.
      expect(placedGeometry()).toEqual([
        {
          cols: 4,
          moduleType: DashboardModuleType.MARKETS,
          rows: 3,
          x: 8,
          y: 0
        }
      ]);
      expect(renderedModuleTypes()).toEqual([DashboardModuleType.MARKETS]);
    });

    it('should render a module whose permission was granted, at its saved cell', async () => {
      await createCanvas({
        layout: of(gatedLayout),
        viewer: { id: 'viewer-1', permissions: [] }
      });
      paint();

      expect(renderedModuleTypes()).toEqual([DashboardModuleType.MARKETS]);

      changePermissionsTo([permissions.accessAdminControl]);

      // Appended rather than inserted, so nothing already on screen moves, and
      // carrying the geometry the arrangement was saved with - which is the whole
      // reason the fetched arrangement is remembered rather than discarded once
      // its permitted entries have been placed.
      expect(placedGeometry()).toEqual([
        {
          cols: 4,
          moduleType: DashboardModuleType.MARKETS,
          rows: 3,
          x: 8,
          y: 0
        },
        {
          cols: 8,
          moduleType: DashboardModuleType.ADMIN_OVERVIEW,
          rows: 6,
          x: 0,
          y: 0
        }
      ]);
      expect(renderedModuleTypes()).toEqual([
        DashboardModuleType.MARKETS,
        DashboardModuleType.ADMIN_OVERVIEW
      ]);
    });

    it('should carry the declared minimum onto a newly admitted module', async () => {
      await createCanvas({
        layout: of(gatedLayout),
        viewer: { id: 'viewer-1', permissions: [] }
      });
      paint();

      changePermissionsTo([permissions.accessAdminControl]);

      // The engine measures a placement against these two members and they are
      // optional on the grid item, so a module admitted through this path has to
      // carry them exactly as one placed through hydration does.
      expect(placedMinimums()).toEqual([
        {
          minItemCols: 3,
          minItemRows: 2,
          moduleType: DashboardModuleType.MARKETS
        },
        {
          minItemCols: 4,
          minItemRows: 4,
          moduleType: DashboardModuleType.ADMIN_OVERVIEW
        }
      ]);
    });

    it('should place no module twice while permissions are granted one at a time', async () => {
      await createCanvas({
        layout: of(gatedLayout),
        viewer: { id: 'viewer-1', permissions: [] }
      });
      paint();

      changePermissionsTo([permissions.accessAdminControl]);
      changePermissionsTo([
        permissions.accessAdminControl,
        permissions.readAiPrompt
      ]);

      // Cells are keyed on the discriminator, so a repeat would collide. Every
      // grant re-screens the whole arrangement, which is exactly why it has to
      // deduplicate against what is already placed.
      expect(renderedModuleTypes()).toEqual([
        DashboardModuleType.MARKETS,
        DashboardModuleType.ADMIN_OVERVIEW,
        DashboardModuleType.AI_CHAT
      ]);
    });

    it('should keep a module the viewer added this session and the position they moved it to', async () => {
      await createCanvas({
        layout: of(gatedLayout),
        viewer: { id: 'viewer-1', permissions: [] }
      });
      paint();

      moduleCatalogComponent().moduleAdded.emit(DashboardModuleType.HOLDINGS);
      paint();

      // What a drag leaves behind: the engine writes coordinates straight onto the
      // object inside the array, and re-screening must not undo that.
      component.modules[0].x = 2;
      component.modules[0].y = 5;

      dashboardLayoutServiceMock.scheduleSave.mockClear();

      changePermissionsTo([permissions.accessAdminControl]);

      // Neither the module the viewer added this session nor the position they
      // moved another one to is in the fetched arrangement, so re-screening from
      // that arrangement alone would lose both.
      expect(renderedModuleTypes()).toEqual([
        DashboardModuleType.MARKETS,
        DashboardModuleType.HOLDINGS,
        DashboardModuleType.ADMIN_OVERVIEW
      ]);
      expect(placedGeometry().slice(0, 2)).toEqual([
        {
          cols: 4,
          moduleType: DashboardModuleType.MARKETS,
          rows: 3,
          x: 2,
          y: 5
        },
        {
          cols: 6,
          moduleType: DashboardModuleType.HOLDINGS,
          rows: 4,
          x: 0,
          y: 0
        }
      ]);

      // The admitted module's own cell is deliberately not asserted here: its
      // saved cell overlaps the one the session module occupies, and resolving
      // that collision is the engine's business rather than this component's.
      expect(placedGeometry()[2]).toMatchObject({
        cols: 8,
        moduleType: DashboardModuleType.ADMIN_OVERVIEW,
        rows: 6
      });
    });

    it('should keep the one array it owns', async () => {
      await createCanvas({
        layout: of(gatedLayout),
        viewer: {
          id: 'viewer-1',
          permissions: [permissions.accessAdminControl]
        }
      });
      paint();

      const modules = component.modules;

      changePermissionsTo([]);

      // Emptied and refilled, never replaced: the array's identity is part of the
      // contract with the grid engine, which holds on to it.
      expect(component.modules).toBe(modules);
    });

    it('should report no layout change in either direction', async () => {
      await createCanvas({
        layout: of(gatedLayout),
        viewer: {
          id: 'viewer-1',
          permissions: [permissions.accessAdminControl]
        }
      });
      paint();

      dashboardLayoutServiceMock.scheduleSave.mockClear();

      changePermissionsTo([]);
      changePermissionsTo([permissions.accessAdminControl]);

      // A change in what a viewer is allowed to see is not a change the viewer
      // made. Persisting it would delete the module from their saved arrangement
      // the moment a subscription lapsed, and re-adding it on renewal would be too
      // late.
      expect(dashboardLayoutServiceMock.scheduleSave).not.toHaveBeenCalled();
      expect(dataServiceMock.patchUserDashboardLayout).not.toHaveBeenCalled();
    });

    it('should re-screen without reading the arrangement again', async () => {
      await createCanvas({
        layout: of(gatedLayout),
        viewer: {
          id: 'viewer-1',
          permissions: [permissions.accessAdminControl]
        }
      });
      paint();

      changePermissionsTo([]);

      // The server holds no new arrangement, and refetching would discard the
      // positions the viewer has moved since it was fetched.
      expect(dashboardLayoutServiceMock.get).toHaveBeenCalledTimes(1);
    });

    it('should open the catalog when the whole arrangement is gated away', async () => {
      await createCanvas({
        layout: of({
          modules: [
            { cols: 8, moduleType: 'admin-overview', rows: 6, x: 0, y: 0 }
          ],
          version: 1
        }),
        viewer: {
          id: 'viewer-1',
          permissions: [permissions.accessAdminControl]
        }
      });
      paint();

      component.isCatalogOpen = false;

      changePermissionsTo([]);

      // Same rule as on hydration: a viewer left with nothing placed needs the
      // catalog as their way back rather than a blank canvas.
      expect(renderedModuleTypes()).toEqual([]);
      expect(component.isCatalogOpen).toBe(true);
      expect(queryElement('gf-empty-canvas-state')).toBeTruthy();
    });

    it('should leave the canvas untouched when the same permissions arrive reordered', async () => {
      await createCanvas({
        layout: of(gatedLayout),
        viewer: {
          id: 'viewer-1',
          permissions: [
            permissions.accessAdminControl,
            permissions.readAiPrompt
          ]
        }
      });
      paint();

      registryServiceMock.getAll.mockClear();

      changePermissionsTo([
        permissions.readAiPrompt,
        permissions.accessAdminControl
      ]);

      // The store hands back a fresh array on every emission and the order inside
      // it is not part of the contract, so permissions are compared as sets. This
      // is the mechanical form of "nothing was re-screened": re-screening reads the
      // registry's whole catalogue to rebuild the arrangement, and it did not.
      expect(registryServiceMock.getAll).not.toHaveBeenCalled();
      expect(renderedModuleTypes()).toEqual([
        DashboardModuleType.ADMIN_OVERVIEW,
        DashboardModuleType.MARKETS,
        DashboardModuleType.AI_CHAT
      ]);
    });
  });

  describe('a portfolio shared by access link', () => {
    it('should render only the shared portfolio', async () => {
      await createCanvas({ queryParams: { accessId: 'abc' }, viewer: null });
      await paintDeferredBlocks();

      expect(queryElement('gf-public-portfolio')).toBeTruthy();

      expect(queryElement('gf-dashboard-toolbar')).toBeNull();
      expect(queryElement('gridster')).toBeNull();
      expect(queryElement('gf-module-catalog')).toBeNull();
      expect(queryElement('gf-sign-in-prompt')).toBeNull();
      expect(queryElement('.gf-dashboard-catalog-trigger')).toBeNull();
    });

    it('should let a shared link win over the viewer own session', async () => {
      await createCanvas({ queryParams: { accessId: 'abc' } });
      await paintDeferredBlocks();

      expect(component.isPublicPortfolio).toBe(true);
      expect(queryElement('gf-public-portfolio')).toBeTruthy();
      expect(queryElement('gridster')).toBeNull();
    });

    it('should neither request a viewer nor read an arrangement while a shared portfolio is shown', async () => {
      await createCanvas({
        queryParams: { accessId: 'abc' },
        viewer: undefined
      });
      paint();

      expect(userServiceMock.get).not.toHaveBeenCalled();
      expect(dashboardLayoutServiceMock.get).not.toHaveBeenCalled();
    });

    it('should show the share even when a foreign module leaves a dialog flag in the address', async () => {
      // The address an anonymous visitor can genuinely arrive at: somebody's share
      // link, opened in a browser whose last visit left a generic dialog flag
      // behind. The root state used to be decided partly by that flag, so this
      // visitor was shown the sign-in prompt instead of the portfolio that had been
      // shared with them.
      await createCanvas({
        queryParams: {
          accessId: 'abc',
          dialogModule: DashboardModuleType.ACCOUNTS,
          editDialog: 'true'
        },
        viewer: null
      });
      // The share is behind a deferred block, so it needs the same settle its
      // siblings above take; a plain paint leaves the placeholder in the DOM.
      await paintDeferredBlocks();

      expect(component.isPublicPortfolio).toBe(true);
      expect(queryElement('gf-public-portfolio')).toBeTruthy();
      expect(queryElement('gridster')).toBeNull();
      expect(queryElement('gf-sign-in-prompt')).toBeNull();
    });

    it('should stay on the canvas while the access module edits one of its own grants', async () => {
      // The access module addresses its edit dialog with `accessDialogId`, which is
      // not the root's discriminator, so the canvas is untouched by it.
      await createCanvas({
        layout: of({
          modules: [{ cols: 5, moduleType: 'holdings', rows: 4, x: 0, y: 0 }],
          version: 1
        }),
        queryParams: {
          accessDialogId: 'abc',
          dialogModule: DashboardModuleType.ACCOUNT_ACCESS,
          editDialog: 'true'
        }
      });
      paint();

      expect(component.isPublicPortfolio).toBe(false);
      expect(queryElement('gf-public-portfolio')).toBeNull();
      expect(renderedModuleTypes()).toEqual([DashboardModuleType.HOLDINGS]);
    });

    it('should not hand a signed-in canvas to a share when a dialog flag is cleared beneath it', async () => {
      // The second half of the defect, and the damaging half. A signed-in viewer
      // editing one of their own access grants held both parameters; the moment any
      // other module merged `editDialog: null` into the address, the root state
      // flipped to "shared portfolio" and their canvas was torn down and replaced
      // with a stranger's. With the dialog on its own parameter, clearing a generic
      // flag cannot move the root state at all.
      await createCanvas({
        layout: of({
          modules: [{ cols: 5, moduleType: 'holdings', rows: 4, x: 0, y: 0 }],
          version: 1
        }),
        queryParams: {
          accessDialogId: 'abc',
          dialogModule: DashboardModuleType.ACCOUNT_ACCESS,
          editDialog: 'true'
        }
      });
      paint();

      expect(component.isPublicPortfolio).toBe(false);

      queryParamsSubject.next({ accessDialogId: 'abc' });
      paint();

      expect(component.isPublicPortfolio).toBe(false);
      expect(component.isSignedOut).toBe(false);
      expect(queryElement('gf-public-portfolio')).toBeNull();
      expect(renderedModuleTypes()).toEqual([DashboardModuleType.HOLDINGS]);
    });

    it('should adopt a cached viewer once the share parameter is dropped', async () => {
      // The store already holds a viewer - the route guard fetched one - and the
      // real user service answers that from its cache *without* dispatching
      // through the store. Emissions are ignored while the shared portfolio is
      // shown, so when the parameter goes away this cached answer is the only
      // notification the canvas will ever get about who is looking.
      await createCanvas({
        layout: of({
          modules: [{ cols: 5, moduleType: 'holdings', rows: 4, x: 0, y: 0 }],
          version: 1
        }),
        queryParams: { accessId: 'abc' },
        viewerRequest: of(signedInViewer)
      });
      paint();

      expect(component.isPublicPortfolio).toBe(true);
      expect(dashboardLayoutServiceMock.get).not.toHaveBeenCalled();

      queryParamsSubject.next({});
      paint();

      // Consuming only the failure channel would leave the canvas with no viewer,
      // no arrangement and none of its states matching - a blank screen for anyone
      // who followed a share link and then dismissed it.
      expect(component.isPublicPortfolio).toBe(false);
      expect(component.isSignedOut).toBe(false);
      expect(component.isInitialized).toBe(true);
      expect(dashboardLayoutServiceMock.get).toHaveBeenCalledTimes(1);
      expect(renderedModuleTypes()).toEqual([DashboardModuleType.HOLDINGS]);
      expect(queryElement('gf-public-portfolio')).toBeNull();
    });

    it('should fall through to the sign-in prompt when the session is rejected after a share link', async () => {
      await createCanvas({
        queryParams: { accessId: 'abc' },
        // A rejected session, not merely a failed request: only the former
        // establishes "not signed in", which the sibling block below pins in both
        // directions.
        viewerRequest: throwError(
          () =>
            new HttpErrorResponse({
              status: StatusCodes.UNAUTHORIZED,
              statusText: 'Unauthorized'
            })
        )
      });
      paint();

      queryParamsSubject.next({});
      paint();

      expect(component.isSignedOut).toBe(true);
      expect(queryElement('gf-sign-in-prompt')).toBeTruthy();
    });
  });

  describe('a viewer who is not signed in', () => {
    it('should render only the sign-in prompt once the viewer resolved as absent', async () => {
      await createCanvas({ viewer: null });
      paint();

      expect(component.isSignedOut).toBe(true);
      expect(queryElement('gf-sign-in-prompt')).toBeTruthy();
      expect(queryElement('gf-dashboard-toolbar')).toBeNull();
      expect(queryElement('gridster')).toBeNull();
      expect(queryElement('gf-module-catalog')).toBeNull();
      expect(queryElement('gf-public-portfolio')).toBeNull();
    });

    it('should not read an arrangement for a viewer who is not signed in', async () => {
      await createCanvas({ viewer: null });
      paint();

      expect(dashboardLayoutServiceMock.get).not.toHaveBeenCalled();
    });

    it('should render neither the prompt nor the canvas while the viewer is unresolved', async () => {
      await createCanvas({ viewer: undefined, viewerRequest: EMPTY });
      paint();

      expect(component.isSignedOut).toBe(false);
      expect(component.isInitialized).toBe(false);
      expect(queryElement('gf-sign-in-prompt')).toBeNull();
      expect(queryElement('gridster')).toBeNull();
      expect(queryElement('gf-public-portfolio')).toBeNull();
    });

    it('should ask for an unresolved viewer exactly once', async () => {
      await createCanvas({ viewer: undefined, viewerRequest: EMPTY });
      paint();

      expect(userServiceMock.get).toHaveBeenCalledTimes(1);
    });

    it('should mark the viewer signed out when their session is rejected', async () => {
      await createCanvas({
        viewer: undefined,
        viewerRequest: throwError(
          () =>
            new HttpErrorResponse({
              status: StatusCodes.UNAUTHORIZED,
              statusText: 'Unauthorized'
            })
        )
      });
      paint();

      // A REJECTED session establishes "not signed in"; a success arrives through the
      // store instead. Nothing weaker qualifies - see the sibling test below.
      expect(component.isSignedOut).toBe(true);
      expect(component.hasViewerError).toBe(false);
      expect(queryElement('gf-sign-in-prompt')).toBeTruthy();
    });

    it('should not mistake a failed request for the viewer for a session that ended', async () => {
      await createCanvas({
        viewer: undefined,
        viewerRequest: throwError(
          () =>
            new HttpErrorResponse({
              status: StatusCodes.INTERNAL_SERVER_ERROR,
              statusText: 'Internal Server Error'
            })
        )
      });
      paint();

      // Credentials that were never rejected are still valid, so a server fault must
      // not put the viewer in front of the sign-in prompt and strand them there. The
      // failure is reported as what it is, with the one affordance that can help.
      expect(component.isSignedOut).toBe(false);
      expect(component.hasViewerError).toBe(true);
      expect(queryElement('gf-sign-in-prompt')).toBeNull();
      expect(queryElement('gridster')).toBeNull();
    });

    it('should ask for the viewer again when the failure is retried', async () => {
      await createCanvas({
        viewer: undefined,
        viewerRequest: throwError(
          () =>
            new HttpErrorResponse({
              status: StatusCodes.SERVICE_UNAVAILABLE,
              statusText: 'Service Unavailable'
            })
        )
      });
      paint();

      expect(userServiceMock.get).toHaveBeenCalledTimes(1);

      // The retried request succeeds. The viewer itself still arrives through the
      // store, exactly as it does on a first load, because the user service sets its
      // state synchronously as the response lands.
      userServiceMock.get.mockImplementation(() => {
        userServiceMock.stateChanged.next({ user: signedInViewer });

        return of(signedInViewer);
      });

      component.onRetryViewer();
      paint();

      // The retry has to release the ask-once guard, or it would resolve to nothing at
      // all and the notice would never clear.
      expect(userServiceMock.get).toHaveBeenCalledTimes(2);
      expect(component.hasViewerError).toBe(false);
      expect(component.isSignedOut).toBe(false);
      expect(queryElement('gridster')).toBeTruthy();
    });

    it('should not ask for a viewer who has already resolved', async () => {
      await createCanvas();
      paint();

      expect(userServiceMock.get).not.toHaveBeenCalled();
    });
  });

  /**
   * The one describe block in this file that permits the canvas to navigate.
   * Every `createCanvas` call below therefore declares `allowsNavigation`; the
   * default harness throws instead, which is what makes a navigation from any
   * other branch fail loudly rather than accumulate in a spy nobody reads.
   */
  describe('the spent jwt parameter', () => {
    it('should strip only the jwt parameter, merging every other', async () => {
      await createCanvas({
        allowsNavigation: true,
        queryParams: { holdingDetailDialog: 'true', jwt: 'a-signed-token' }
      });
      paint();

      // The empty command array is this workspace's route-agnostic convention - it
      // rewrites the current URL rather than addressing anything - and merging is what
      // preserves every other parameter, a shared portfolio id and each dialog flag
      // among them. Nulling the single key is how it is dropped.
      //
      // `replaceUrl` is asserted because it is a security property, not a preference:
      // the address being replaced carries a session token, and an entry left in
      // history keeps that credential reachable through Back long after it was spent.
      expect(routerMock.navigate).toHaveBeenCalledTimes(1);
      expect(routerMock.navigate).toHaveBeenCalledWith([], {
        queryParams: { jwt: null },
        queryParamsHandling: 'merge',
        relativeTo: activatedRouteMock,
        replaceUrl: true
      });
    });

    it('should not adopt the token a second time', async () => {
      await createCanvas({
        allowsNavigation: true,
        queryParams: { jwt: 'a-signed-token' }
      });
      paint();

      expect(tokenStorageServiceMock.saveToken).not.toHaveBeenCalled();
    });

    it('should strip a jwt parameter that carries no value', async () => {
      await createCanvas({
        allowsNavigation: true,
        queryParams: { jwt: '' }
      });
      paint();

      // The clean-up asks whether the parameter is THERE, not whether it holds
      // anything. Keyed on truthiness, an empty value short-circuited the method
      // and `?jwt=` survived in the address bar - a URL still advertising a token
      // hand-off, in direct contradiction of the contract that a spent `jwt` is
      // always removed. The value is not this method's business in any case: the
      // route guard has already dealt with whatever it held, so an empty one and a
      // spent one are the same case.
      expect(routerMock.navigate).toHaveBeenCalledTimes(1);
      expect(routerMock.navigate).toHaveBeenCalledWith([], {
        queryParams: { jwt: null },
        queryParamsHandling: 'merge',
        relativeTo: activatedRouteMock,
        replaceUrl: true
      });
    });

    it('should keep every other parameter while dropping a valueless jwt', async () => {
      await createCanvas({
        allowsNavigation: true,
        queryParams: {
          accessId: 'a-share-id',
          jwt: '',
          utm_source: 'newsletter'
        }
      });
      paint();

      // Merging is what preserves them, so the empty case must go through the same
      // navigation shape as a populated one rather than a bespoke one that happens
      // to clear the URL.
      expect(routerMock.navigate).toHaveBeenCalledTimes(1);

      // Destructured with no assertion at all: the mock is declared with the
      // router's own parameter tuple, so this reads back as the command list and
      // the extras the method really takes.
      const [commands, options] = routerMock.navigate.mock.calls[0];

      expect(commands).toEqual([]);
      expect(options.queryParams).toEqual({ jwt: null });
      expect(options.queryParamsHandling).toBe('merge');
    });

    it('should issue no navigation when no jwt is present', async () => {
      // Permitted and then not used: this is the assertion that the clean-up is
      // conditional rather than unconditional, so the capability has to be
      // available for its absence to mean anything.
      //
      // It is also what keeps the presence check from becoming an unconditional
      // navigation: every ordinary visit to the root route reaches this method, and
      // replacing the history entry of a URL that never carried a token would be a
      // navigation nobody asked for.
      await createCanvas({
        allowsNavigation: true,
        queryParams: { holdingDetailDialog: 'true' }
      });
      paint();

      expect(routerMock.navigate).not.toHaveBeenCalled();
    });

    it('should issue no navigation for a canvas reached with no parameters at all', async () => {
      await createCanvas({ allowsNavigation: true });
      paint();

      expect(routerMock.navigate).not.toHaveBeenCalled();
    });
  });

  describe('a federated sign-in the provider refused', () => {
    /** What the canvas passed to the prompt it renders. */
    const signInPrompt = () => {
      return fixture.debugElement.query(
        By.directive(GfTestSignInPromptComponent)
      )?.componentInstance as GfTestSignInPromptComponent;
    };

    it('should tell the prompt, so the visitor is not returned to an unchanged screen', async () => {
      await createCanvas({
        allowsNavigation: true,
        queryParams: { signInError: 'provider' },
        viewer: null
      });
      paint();

      // The whole point of the marker: this branch is also what a first visit
      // renders, so without it a refusal is indistinguishable from never having
      // tried, and the visitor presses the same button again.
      expect(component.hasSignInError).toBe(true);
      expect(signInPrompt().hasSignInError).toBe(true);
    });

    it('should strip only the marker, merging every other parameter', async () => {
      await createCanvas({
        allowsNavigation: true,
        queryParams: { signInError: 'provider', utm_source: 'newsletter' },
        viewer: null
      });
      paint();

      // `replaceUrl` for a reason that is not security this time but truthfulness:
      // left as its own history entry, pressing Back would replay a refusal that
      // already happened as though it had just happened again.
      expect(routerMock.navigate).toHaveBeenCalledTimes(1);
      expect(routerMock.navigate).toHaveBeenCalledWith([], {
        queryParams: { signInError: null },
        queryParamsHandling: 'merge',
        relativeTo: activatedRouteMock,
        replaceUrl: true
      });
    });

    it('should keep saying it after the marker has been removed from the address', async () => {
      await createCanvas({
        allowsNavigation: true,
        queryParams: { signInError: 'provider' },
        viewer: null
      });
      paint();

      // Latched rather than derived. The removal happens immediately, so a flag read
      // from the URL would be true for one frame and the notice would vanish
      // underneath the visitor.
      queryParamsSubject.next({});
      paint();

      expect(component.hasSignInError).toBe(true);
      expect(signInPrompt().hasSignInError).toBe(true);
    });

    it.each([
      { description: 'a value outside the contract', signInError: 'oidc' },
      { description: 'an empty value', signInError: '' },
      {
        description: 'a sentence somebody wrote themselves',
        signInError: 'Your account was closed. Call 555-0100.'
      },
      { description: 'markup', signInError: '<img src=x onerror=alert(1)>' }
    ])('should ignore $description', async ({ signInError }) => {
      await createCanvas({
        allowsNavigation: true,
        queryParams: { signInError },
        viewer: null
      });
      paint();

      // This parameter arrives in an address anybody can write and send. Compared
      // against the one value the contract defines - never displayed - so a forged
      // one puts no sentence on the sign-in card. It is also left in the URL rather
      // than stripped, because a consumer clears what it handled and this was not
      // handled.
      expect(component.hasSignInError).toBe(false);
      expect(signInPrompt().hasSignInError).toBe(false);
      expect(routerMock.navigate).not.toHaveBeenCalled();
    });

    it('should say nothing on an ordinary visit', async () => {
      await createCanvas({ allowsNavigation: true, viewer: null });
      paint();

      expect(component.hasSignInError).toBe(false);
      expect(routerMock.navigate).not.toHaveBeenCalled();
    });

    it('should strip the marker alongside a spent token in a single navigation each', async () => {
      await createCanvas({
        allowsNavigation: true,
        queryParams: { jwt: 'a-signed-token', signInError: 'provider' },
        viewer: null
      });
      paint();

      // Both can be present at once only if a provider redirect were malformed, but
      // each clean-up nulls its own key and merges, so neither erases the other's
      // work. Asserted because the alternative - one replacing the whole parameter
      // set - is what the merge convention exists to prevent.
      const cleared = routerMock.navigate.mock.calls.map(([, options]) => {
        return options.queryParams;
      });

      expect(cleared).toEqual([{ signInError: null }, { jwt: null }]);
    });
  });

  describe('adding a module from the catalog', () => {
    it('should place the module in the cell the grid engine reports', async () => {
      await createCanvas();
      paint();

      const gridster = gridsterComponent();

      jest
        .spyOn(gridster, 'getNextPossiblePosition')
        .mockImplementation((aNewItem) => {
          aNewItem.x = 2;
          aNewItem.y = 4;

          return true;
        });

      moduleCatalogComponent().moduleAdded.emit(DashboardModuleType.HOLDINGS);

      expect(placedGeometry()).toEqual([
        {
          cols: 6,
          moduleType: DashboardModuleType.HOLDINGS,
          rows: 4,
          x: 2,
          y: 4
        }
      ]);
    });

    it('should ask with the footprint the registry declared', async () => {
      await createCanvas();
      paint();

      const gridster = gridsterComponent();

      jest.spyOn(gridster, 'getNextPossiblePosition').mockReturnValue(true);

      moduleCatalogComponent().moduleAdded.emit(DashboardModuleType.HOLDINGS);

      expect(gridster.getNextPossiblePosition).toHaveBeenCalledTimes(1);
      expect(gridster.getNextPossiblePosition).toHaveBeenCalledWith({
        cols: 6,
        minItemCols: 2,
        minItemRows: 2,
        moduleType: DashboardModuleType.HOLDINGS,
        rows: 4,
        x: 0,
        y: 0
      });
    });

    it('should move the module the viewer cannot see out from under the one they added', async () => {
      // One module the viewer is not entitled to see, saved across the top-left of
      // the grid. It draws no card, so the grid engine has no item there and every
      // cell it covers looks free to the engine's own scan.
      await createCanvas({
        layout: of({
          modules: [
            { cols: 8, moduleType: 'admin-overview', rows: 6, x: 0, y: 0 }
          ],
          version: 1
        }),
        viewer: { id: 'viewer-1', permissions: [] }
      });
      await paintAndSettle();

      expect(renderedModuleTypes()).toEqual([]);

      const gridster = gridsterComponent();

      jest
        .spyOn(gridster, 'getNextPossiblePosition')
        .mockImplementation((aNewItem) => {
          aNewItem.x = 0;
          aNewItem.y = 0;

          return true;
        });

      dashboardLayoutServiceMock.scheduleSave.mockClear();

      moduleCatalogComponent().moduleAdded.emit(DashboardModuleType.HOLDINGS);
      paint();

      // In a browser the pushed item renders a cell whose initialization the engine
      // announces through `itemInitCallback`; in this environment gridster raises
      // none of its own callbacks, so it is announced here - through the very
      // configuration the canvas handed the engine.
      component.options.itemInitCallback(
        component.modules[0],
        gridsterItemComponents()[0]
      );

      // The module the viewer added goes exactly where the engine put it. Screening
      // the engine's answer against the hidden cells instead was measured and
      // rejected: a lapsed subscription hides several saved modules, so every
      // addition would be pushed below all of them and the viewer would get two
      // cards with eleven empty rows between them.
      expect(placedGeometry()).toEqual([
        {
          cols: 6,
          moduleType: DashboardModuleType.HOLDINGS,
          rows: 4,
          x: 0,
          y: 0
        }
      ]);

      const [, reported] = dashboardLayoutServiceMock.scheduleSave.mock
        .calls[0] as [
        string,
        {
          cols: number;
          moduleType: string;
          rows: number;
          x: number;
          y: number;
        }[]
      ];

      // And the arrangement that reaches the server has no overlap in it, because
      // the module the viewer cannot see is the one that moved. Its saved cell was
      // column 0 row 0; the addition took rows 0 to 3, so it settles at row 4 - the
      // first cell, scanning left to right and then down, that is free.
      expect(reported).toEqual([
        {
          cols: 6,
          moduleType: DashboardModuleType.HOLDINGS,
          rows: 4,
          x: 0,
          y: 0
        },
        {
          cols: 8,
          moduleType: DashboardModuleType.ADMIN_OVERVIEW,
          rows: 6,
          x: 0,
          y: 4
        }
      ]);
    });

    it('should leave a hidden module exactly where it was saved when nothing took its cells', async () => {
      await createCanvas({
        layout: of({
          modules: [
            { cols: 8, moduleType: 'admin-overview', rows: 6, x: 0, y: 6 }
          ],
          version: 1
        }),
        viewer: { id: 'viewer-1', permissions: [] }
      });
      await paintAndSettle();

      const gridster = gridsterComponent();

      jest
        .spyOn(gridster, 'getNextPossiblePosition')
        .mockImplementation((aNewItem) => {
          aNewItem.x = 0;
          aNewItem.y = 0;

          return true;
        });

      dashboardLayoutServiceMock.scheduleSave.mockClear();

      moduleCatalogComponent().moduleAdded.emit(DashboardModuleType.HOLDINGS);
      paint();

      component.options.itemInitCallback(
        component.modules[0],
        gridsterItemComponents()[0]
      );

      const [, reported] = dashboardLayoutServiceMock.scheduleSave.mock
        .calls[0] as [string, { moduleType: string; y: number }[]];

      // Nothing landed on it, so nothing moves. A relocation that fired whenever a
      // hidden module merely existed would rewrite a saved position the viewer chose,
      // for no reason and with no way for them to see it happen.
      expect(reported).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            moduleType: DashboardModuleType.ADMIN_OVERVIEW,
            y: 6
          })
        ])
      );
    });

    it('should add nothing when the engine reports no free cell', async () => {
      await createCanvas();
      paint();

      jest
        .spyOn(gridsterComponent(), 'getNextPossiblePosition')
        .mockReturnValue(false);

      moduleCatalogComponent().moduleAdded.emit(DashboardModuleType.HOLDINGS);

      expect(component.modules).toEqual([]);
      expect(dashboardLayoutServiceMock.scheduleSave).not.toHaveBeenCalled();
    });

    it('should consult the grid component instance rather than the api surface', async () => {
      await createCanvas();
      paint();

      const gridster = gridsterComponent();

      jest.spyOn(gridster, 'getNextPossiblePosition').mockReturnValue(true);
      jest.spyOn(gridster.api, 'getNextPossiblePosition');

      moduleCatalogComponent().moduleAdded.emit(DashboardModuleType.HOLDINGS);

      expect(gridster.getNextPossiblePosition).toHaveBeenCalledTimes(1);
      expect(gridster.api.getNextPossiblePosition).not.toHaveBeenCalled();
    });

    it('should take its grid instance from the configuration init callback', async () => {
      await createCanvas();
      paint();

      const rendered = gridsterComponent();
      const replacement = TestBed.createComponent(Gridster);

      replacement.componentRef.setInput('options', {});

      const replacementGridster = replacement.componentInstance;

      jest.spyOn(rendered, 'getNextPossiblePosition');
      jest
        .spyOn(replacementGridster, 'getNextPossiblePosition')
        .mockReturnValue(true);

      component.options.initCallback(
        replacementGridster,
        replacementGridster.api
      );

      // Adopting a grid is itself a reason to ask it what still fits - it is the
      // first moment there is anybody to ask - so the scan that answers the
      // catalog is cleared here and the assertion below measures the ADD alone,
      // which is what this test is about.
      jest.mocked(replacementGridster.getNextPossiblePosition).mockClear();

      moduleCatalogComponent().moduleAdded.emit(DashboardModuleType.HOLDINGS);

      expect(replacementGridster.getNextPossiblePosition).toHaveBeenCalledTimes(
        1
      );
      expect(rendered.getNextPossiblePosition).not.toHaveBeenCalled();
      expect(component.modules).toHaveLength(1);
    });

    it('should reveal a module that is already placed instead of placing it twice', async () => {
      await createCanvas({
        layout: of({
          modules: [{ cols: 5, moduleType: 'holdings', rows: 4, x: 0, y: 0 }],
          version: 1
        })
      });
      paint();

      const positionSpy = jest.spyOn(
        gridsterComponent(),
        'getNextPossiblePosition'
      );

      moduleCatalogComponent().moduleAdded.emit(DashboardModuleType.HOLDINGS);

      expect(component.modules).toHaveLength(1);
      expect(positionSpy).not.toHaveBeenCalled();
      expect(scrollIntoViewMock).toHaveBeenCalledWith({
        behavior: 'smooth',
        block: 'nearest'
      });
      expect(dashboardLayoutServiceMock.scheduleSave).not.toHaveBeenCalled();
    });

    it('should ignore a discriminator the registry does not know', async () => {
      await createCanvas();
      paint();

      component.onAddModule(DashboardModuleType.X_RAY);

      expect(component.modules).toEqual([]);
      expect(dashboardLayoutServiceMock.scheduleSave).not.toHaveBeenCalled();
    });

    it('should ignore a module the viewer may not see', async () => {
      await createCanvas({ viewer: { id: 'viewer-1', permissions: [] } });
      paint();

      moduleCatalogComponent().moduleAdded.emit(
        DashboardModuleType.ADMIN_OVERVIEW
      );

      expect(component.modules).toEqual([]);
    });
  });

  /**
   * The grid is a bounded surface, so "there is nowhere left to put this" is a
   * reachable outcome rather than an error. The engine's response to it is simply to
   * decline, which from the viewer's side is indistinguishable from a click that
   * never registered - no module, no message, no reason - so the refusal has to be
   * reported.
   */
  describe('an add the grid has no room for', () => {
    /**
     * Makes the engine refuse the next placement, exactly as a full grid does.
     *
     * Driven through `getNextPossiblePosition`, because that is the single method
     * whose `false` is the engine's way of saying a footprint fits nowhere - the
     * same answer a genuinely full grid gives, produced without having to fill a
     * hundred rows to get it.
     */
    const refuseNextPlacement = () => {
      jest
        .spyOn(gridsterComponent(), 'getNextPossiblePosition')
        .mockReturnValue(false);
    };

    it('should add nothing, and say why, when the engine refuses', async () => {
      await createCanvas();
      paint();

      refuseNextPlacement();

      moduleCatalogComponent().moduleAdded.emit(DashboardModuleType.HOLDINGS);
      paint();

      // Adding nothing is correct and deliberate: the array is the authoritative one
      // and would be persisted, so an item the engine will not position must not
      // reach it.
      expect(component.modules).toEqual([]);
      expect(dashboardLayoutServiceMock.scheduleSave).not.toHaveBeenCalled();

      // What must NOT happen silently. Both channels carry it: the flag paints a
      // notice, and the live region tells a screen-reader user the same thing.
      expect(component.hasCapacityError).toBe(true);
      expect(component.canvasAnnouncement).toContain('no room');
      expect(component.canvasAnnouncement).toContain('Holdings');
    });

    it('should paint a notice naming the way out', async () => {
      await createCanvas();
      paint();

      refuseNextPlacement();

      moduleCatalogComponent().moduleAdded.emit(DashboardModuleType.HOLDINGS);
      paint();

      const notice = queryElements('[role="status"]').find(
        ({ textContent }) => {
          return textContent.includes('no room');
        }
      );

      // A remedy rather than only a diagnosis: the viewer can always resolve this
      // themselves, and both routes are theirs to take.
      expect(notice).toBeDefined();
      expect(notice.textContent).toContain('smaller');
      expect(notice.textContent).toContain('remove');
    });

    it('should stop claiming there is no room once something is placed', async () => {
      await createCanvas();
      paint();

      refuseNextPlacement();

      moduleCatalogComponent().moduleAdded.emit(DashboardModuleType.HOLDINGS);
      paint();

      expect(component.hasCapacityError).toBe(true);

      jest
        .spyOn(gridsterComponent(), 'getNextPossiblePosition')
        .mockReturnValue(true);

      moduleCatalogComponent().moduleAdded.emit(DashboardModuleType.MARKETS);
      paint();

      // The condition is gone, so the notice has to go with it - a notice that
      // outlives what it describes is worse than none.
      expect(component.modules).toHaveLength(1);
      expect(component.hasCapacityError).toBe(false);

      // Read through the same typed predicate the positive assertion above uses.
      // `toContainEqual(expect.objectContaining(...))` was both untyped and a poor
      // fit here: it structurally walks a live DOM node, so it can report a match
      // or a miss for reasons that have nothing to do with the notice's wording.
      const notice = queryElements('[role="status"]').find(
        ({ textContent }) => {
          return textContent.includes('no room');
        }
      );

      expect(notice).toBeUndefined();
    });

    it('should stop claiming there is no room once a module is removed', async () => {
      await createCanvas({
        layout: of({
          modules: [{ cols: 5, moduleType: 'holdings', rows: 4, x: 0, y: 0 }],
          version: 1
        })
      });
      paint();

      refuseNextPlacement();

      moduleCatalogComponent().moduleAdded.emit(DashboardModuleType.MARKETS);
      paint();

      expect(component.hasCapacityError).toBe(true);

      // Removing frees the very space the notice was about.
      moduleHostComponents()[0].remove.emit();
      paint();

      expect(component.hasCapacityError).toBe(false);
    });

    /**
     * Dismissing the notice destroys the button that dismissed it, so these read
     * `document.activeElement` rather than a spy on `focus()`. A spy would report
     * success even where the browser did nothing, because `focus()` on a detached
     * or hidden element is a silent no-op - and the whole point of the handler is
     * that focus genuinely lands somewhere rather than falling to the body.
     */
    describe('dismissing the notice', () => {
      const dismissButton = () => {
        return queryElement<HTMLButtonElement>(
          '.gf-dashboard-canvas-notice button'
        );
      };

      const triggerButton = () => {
        return queryElement<HTMLButtonElement>(
          '.gf-dashboard-catalog-trigger button'
        );
      };

      const raiseNotice = async () => {
        await createCanvas({
          layout: of({
            modules: [{ cols: 5, moduleType: 'holdings', rows: 4, x: 0, y: 0 }],
            version: 1
          })
        });
        paint();

        refuseNextPlacement();

        moduleCatalogComponent().moduleAdded.emit(DashboardModuleType.MARKETS);
        paint();

        expect(component.hasCapacityError).toBe(true);
      };

      it('should hand focus to the catalog trigger when the dismissed control held it', async () => {
        await raiseNotice();

        dismissButton().focus();

        expect(document.activeElement).toBe(dismissButton());

        dismissButton().click();
        paint();

        expect(component.hasCapacityError).toBe(false);

        // The trigger, and specifically NOT `document.body` - which is where the
        // browser drops focus when the element holding it is removed and nothing
        // claims it, costing a keyboard viewer their position in the page.
        expect(document.activeElement).toBe(triggerButton());
      });

      it('should leave focus where it was when the dismissed control did not hold it', async () => {
        await raiseNotice();

        // Captured rather than named, because which element holds focus here is
        // not the point - the point is that dismissing does not MOVE it. A pointer
        // dismissal from elsewhere on the canvas must leave the viewer wherever
        // they actually were.
        const before = document.activeElement;

        expect(before).not.toBe(dismissButton());

        component.onDismissCapacityNotice();
        paint();

        expect(component.hasCapacityError).toBe(false);
        expect(document.activeElement).toBe(before);
        expect(document.activeElement).not.toBe(triggerButton());
      });
    });

    it('should tell the catalog which modules it has no room for', async () => {
      await createCanvas();
      paint();

      refuseNextPlacement();

      component.onOpenCatalog();
      paint();

      // Every registered module the viewer may see, none of them placed and none of
      // them placeable, so the catalog can mark each row before it is clicked
      // rather than leaving the viewer to discover it.
      expect(moduleCatalogComponent().unavailableModuleTypes).toEqual(
        definitions.map(({ moduleType }) => moduleType)
      );
    });

    it('should never call a placed module unavailable', async () => {
      await createCanvas({
        layout: of({
          modules: [{ cols: 5, moduleType: 'holdings', rows: 4, x: 0, y: 0 }],
          version: 1
        })
      });
      paint();

      refuseNextPlacement();

      component.onOpenCatalog();
      paint();

      // A placed module's row reveals what is already on the canvas rather than
      // adding anything, so it always has somewhere to go no matter how full the
      // grid is. Reporting it as having no room would mislabel the one row that
      // cannot fail.
      expect(moduleCatalogComponent().unavailableModuleTypes).not.toContain(
        DashboardModuleType.HOLDINGS
      );
      expect(moduleCatalogComponent().placedModuleTypes).toEqual([
        DashboardModuleType.HOLDINGS
      ]);
    });

    // Answered on the way open, not on every change-detection pass: the question
    // costs one grid scan per unplaced module, which is affordable once per user
    // action and ruinous per pass.
    it('should re-answer availability each time the catalog opens', async () => {
      await createCanvas();
      paint();

      const positionSpy = jest
        .spyOn(gridsterComponent(), 'getNextPossiblePosition')
        .mockReturnValue(false);

      component.onOpenCatalog();
      paint();

      // Twice per module, because every definition in this fixture declares a
      // minimum smaller than its default: a refusal at the default is followed by
      // a second offer at the minimum, since the minimum is the size the module
      // is contracted to work at and the default is only the size it prefers.
      expect(positionSpy).toHaveBeenCalledTimes(2 * definitions.length);

      positionSpy.mockClear().mockReturnValue(true);

      component.onToggleCatalog();
      component.onToggleCatalog();
      paint();

      expect(component.isCatalogOpen).toBe(true);
      expect(positionSpy).toHaveBeenCalledTimes(definitions.length);
      expect(moduleCatalogComponent().unavailableModuleTypes).toEqual([]);
    });

    /**
     * A default footprint is a preference; a minimum is a contract. Judging
     * capacity on the preference alone told a viewer the dashboard was full while
     * a hole the module's own minimum fits twice over sat open on the grid - QA
     * measured exactly that, on a twelve-by-seven module with a six-by-four
     * minimum against a six-wide hole, and then watched a different module take
     * that same hole.
     */
    describe('a module that fits only at its declared minimum', () => {
      // Accepts a footprint no wider than three columns, which is the shape of a
      // grid with one narrow hole left in it. Every default in the fixture is
      // wider than that; four of the five minimums are not, and `admin-overview`
      // - four columns at its narrowest - is the one module this grid genuinely
      // has no room for.
      const acceptOnlyNarrowFootprints = () => {
        jest
          .spyOn(gridsterComponent(), 'getNextPossiblePosition')
          .mockImplementation((aNewItem) => {
            return aNewItem.cols <= 3;
          });
      };

      it('should add it at that minimum rather than refusing it', async () => {
        await createCanvas();
        paint();

        acceptOnlyNarrowFootprints();

        // Declares 4x3 by default and 3x2 as its minimum, so the default is
        // refused and the minimum is not.
        moduleCatalogComponent().moduleAdded.emit(DashboardModuleType.MARKETS);
        paint();

        expect(component.hasCapacityError).toBe(false);
        expect(
          component.modules.map(({ cols, moduleType, rows }) => ({
            cols,
            moduleType,
            rows
          }))
        ).toEqual([
          { cols: 3, moduleType: DashboardModuleType.MARKETS, rows: 2 }
        ]);
      });

      it('should never place it below the minimum it declares', async () => {
        await createCanvas();
        paint();

        // Nothing fits at all, so the fallback has nowhere left to go - and the
        // one thing it must not do is keep shrinking. Rule 6 makes the minimum a
        // floor the engine enforces, so a refusal at the minimum is final.
        jest
          .spyOn(gridsterComponent(), 'getNextPossiblePosition')
          .mockReturnValue(false);

        moduleCatalogComponent().moduleAdded.emit(DashboardModuleType.MARKETS);
        paint();

        expect(component.hasCapacityError).toBe(true);
        expect(component.modules).toEqual([]);
      });

      it('should not tell the catalog it has no room for it', async () => {
        await createCanvas();
        paint();

        acceptOnlyNarrowFootprints();

        component.onOpenCatalog();
        paint();

        // What the catalog shows and what a click does have to agree, so both
        // answers come from one routine. Four of the five modules reach three
        // columns or fewer at their minimums and are therefore still addable;
        // only `admin-overview`, which bottoms out at four, is not - and before
        // this fallback existed all five would have been reported as having no
        // room, because all five are refused at their defaults.
        expect(moduleCatalogComponent().unavailableModuleTypes).toEqual([
          DashboardModuleType.ADMIN_OVERVIEW
        ]);
      });
    });
  });

  /**
   * What a screen-reader user can find on this canvas without knowing it is there,
   * and what it is called when they do.
   *
   * The route-per-screen shell used to supply all of this for nothing: a `<header>`
   * element was a banner landmark, and every screen opened with a page heading.
   * Collapsing the shell removed both - measured on the finished canvas as five
   * landmarks with no heading of any level anywhere in the document - which takes
   * away the two shortcuts a reader reaches for first: jump to a landmark, and walk
   * the headings to see what is here.
   */
  describe('the outline and the landmarks the canvas provides', () => {
    const twoModuleLayout: UserDashboardLayout = {
      modules: [
        { cols: 4, moduleType: 'holdings', rows: 4, x: 0, y: 0 },
        { cols: 3, moduleType: 'markets', rows: 4, x: 5, y: 0 }
      ],
      version: 1
    };

    it('should root the heading hierarchy its modules hang from', async () => {
      await createCanvas({ layout: of(twoModuleLayout) });
      paint();

      const heading = queryElement('h1');

      // A document whose shallowest heading is a level two has no root, and a rotor
      // drawing an outline from it starts halfway down one.
      expect(heading).toBeTruthy();
      expect(heading.textContent.trim()).toBe('Dashboard');

      // Announced, never drawn: every square of this canvas belongs to a module, and
      // a visible title band would take that space from the arrangement.
      expect(heading.classList.contains('sr-only')).toBe(true);
    });

    // Outside every state branch, because a reader who arrives while the arrangement
    // is still being read - or after reading it failed - is exactly the reader who
    // needs to know where they are.
    it('should carry that heading before any arrangement has arrived', async () => {
      await createCanvas({ layout: of(null) });
      paint();

      expect(component.modules).toEqual([]);
      expect(queryElement('h1')).toBeTruthy();
    });

    it('should name the catalog panel and make it a landmark', async () => {
      await createCanvas({ layout: of(twoModuleLayout) });
      paint();

      const drawer = queryElement('mat-sidenav');

      // A drawer is a plain `div` as far as assistive technology is concerned. Without
      // these it could be reached only by walking in from the control that opens it,
      // and a reader who had arrowed away from that control had no way back.
      expect(drawer).toBeTruthy();
      expect(drawer.getAttribute('role')).toBe('region');
      expect(drawer.getAttribute('aria-label')).toBe('Module catalog');
    });

    /**
     * The heading level the module chrome declares is asserted in the chrome's own
     * spec, where the element that carries it lives. What belongs here is the
     * relationship: the canvas is the level above whatever its modules are, so the
     * two levels have to be one apart. Read from the chrome's template rather than
     * from a rendered module, because this file replaces the chrome with a stand-in.
     */
    it('should sit exactly one level above its module headings', () => {
      const chrome = readFileSync(
        join(__dirname, 'dashboard-module-host', 'dashboard-module-host.html'),
        'utf8'
      );

      expect(chrome).toContain('aria-level="2"');
      expect(chrome).toContain('role="heading"');
    });
  });

  /**
   * Every message the canvas speaks names the module it is about, and the name it
   * uses has to be the one on the card the viewer is looking at.
   *
   * Two registry entries are titled `Markets` and two are titled `Settings`, because
   * each name is the route registry's own title reused verbatim to keep all thirteen
   * locales translated. On one canvas both of a pair can be placed at once, so a
   * message saying only `Markets` names either of them - and the announcement is
   * exactly the channel whose audience cannot glance at the card to see which.
   */
  describe('naming the module an announcement is about', () => {
    const collidingNameLayout: UserDashboardLayout = {
      modules: [
        { cols: 7, moduleType: 'markets-premium', rows: 5, x: 0, y: 0 },
        { cols: 3, moduleType: 'markets', rows: 4, x: 8, y: 0 }
      ],
      version: 1
    };

    const announcement = () => {
      return queryElement('[role="status"].sr-only').textContent.trim();
    };

    const premiumViewer: CanvasViewer = {
      id: 'viewer-1',
      permissions: [permissions.readMarketDataOfMarkets]
    };

    it('should qualify a name two modules share when removing one', async () => {
      await createCanvas({
        layout: of(collidingNameLayout),
        viewer: premiumViewer
      });
      paint();

      moduleHostComponents()[0].remove.emit();
      paint();

      // The card is headed `Markets · Market Data`, so this is what the reader has to
      // hear. `Markets removed from the dashboard` was true of either module.
      expect(announcement()).toBe(
        'Markets · Market Data removed from the dashboard'
      );
    });

    it('should qualify it when reporting where a module went', async () => {
      await createCanvas({
        layout: of(collidingNameLayout),
        viewer: premiumViewer
      });
      paint();

      moduleHostComponents()[0].move.emit({ deltaCols: 0, deltaRows: 1 });
      fixture.detectChanges();

      expect(announcement()).toBe(
        'Markets · Market Data moved to column 1, row 2'
      );
    });

    it('should qualify it when refusing a step', async () => {
      await createCanvas({
        layout: of(collidingNameLayout),
        viewer: premiumViewer
      });
      paint();

      moduleHostComponents()[0].move.emit({ deltaCols: -1, deltaRows: 0 });
      fixture.detectChanges();

      expect(announcement()).toBe(
        'Markets · Market Data cannot be moved left: there is no room'
      );
    });

    it('should qualify it when adding one', async () => {
      await createCanvas({ layout: of(null), viewer: premiumViewer });
      paint();

      moduleCatalogComponent().moduleAdded.emit(
        DashboardModuleType.MARKETS_PREMIUM
      );
      paint();

      expect(announcement()).toContain('Markets · Market Data');
      expect(announcement()).toContain('added to the dashboard');
    });

    // The one name a module type this build does not recognise has. Nothing can be
    // said about it beyond the discriminator, and saying `undefined` would be worse
    // than saying that.
    /**
     * The stored discriminator is the only name a module has once the registry no
     * longer describes it, and it is a better thing to say than `undefined`.
     *
     * Reached by taking the definition away from a module that is already placed,
     * because that is the only way to reach it: an arrangement naming a module type
     * this build never knew is retained in the saved document but is never made into
     * a grid item, so it cannot be removed through the chrome at all - which is why
     * the failed-read state offers a discard instead.
     */
    it('should fall back to the stored discriminator when a name is gone', async () => {
      await createCanvas({
        layout: of({
          modules: [{ cols: 4, moduleType: 'holdings', rows: 4, x: 0, y: 0 }],
          version: 1
        })
      });
      paint();

      definitions.splice(
        definitions.findIndex(({ moduleType }) => {
          return moduleType === DashboardModuleType.HOLDINGS;
        }),
        1
      );

      component.onRemoveModule(component.modules[0]);
      paint();

      expect(component.modules).toEqual([]);
      expect(announcement()).toBe('holdings removed from the dashboard');
    });
  });

  /**
   * A live region is announced when its contents CHANGE, which makes a repeated
   * message inaudible: writing the same sentence twice changes nothing the second
   * time, so the second press that produced it is indistinguishable from a press
   * that never registered.
   *
   * That is not a corner case. It is what holding an arrow key against the edge of
   * the grid does on every press after the first, and it was measured at eleven
   * announcements across nineteen presses - nine of them silent.
   */
  describe('a message the canvas has just given', () => {
    const cornerLayout: UserDashboardLayout = {
      modules: [{ cols: 4, moduleType: 'holdings', rows: 4, x: 0, y: 0 }],
      version: 1
    };

    const announcement = () => {
      return queryElement('[role="status"].sr-only').textContent.trim();
    };

    const refuseLeftwardStep = () => {
      moduleHostComponents()[0].move.emit({ deltaCols: -1, deltaRows: 0 });

      fixture.detectChanges();
    };

    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('should be emptied and given again when it repeats', async () => {
      await createCanvas({ layout: of(cornerLayout) });
      paint();

      refuseLeftwardStep();

      const refusal = 'Holdings cannot be moved left: there is no room';

      // First press: nothing was standing, so it is written straight through.
      expect(announcement()).toBe(refusal);

      refuseLeftwardStep();

      // Second press: the region is emptied FIRST. This is the whole mechanism - the
      // clear is a change, and it is what lets the identical sentence be a change too
      // when it lands.
      expect(announcement()).toBe('');

      jest.runOnlyPendingTimers();
      fixture.detectChanges();

      expect(announcement()).toBe(refusal);
    });

    /**
     * The refill has to be a separate task. Emptying and refilling inside one task
     * is coalesced into whatever the DOM holds when it next paints, so the
     * accessibility tree only ever sees the final value - the clear would be
     * invisible and nothing would have changed after all.
     */
    it('should defer that repeat rather than rewrite it at once', async () => {
      await createCanvas({ layout: of(cornerLayout) });
      paint();

      refuseLeftwardStep();
      refuseLeftwardStep();

      // Still empty after everything synchronous has run, which is the assertion: a
      // second assignment in the same task would have put the sentence back here and
      // the reader would have been told nothing.
      expect(announcement()).toBe('');
      expect(component.canvasAnnouncement).toBe('');
    });

    // A different sentence needs no help: it is a change already, and deferring it
    // would flicker the region through empty for no reason and delay every message.
    it('should write a different message straight through', async () => {
      await createCanvas({ layout: of(cornerLayout) });
      paint();

      refuseLeftwardStep();

      moduleHostComponents()[0].move.emit({ deltaCols: 1, deltaRows: 0 });
      fixture.detectChanges();

      expect(announcement()).toBe('Holdings moved to column 2, row 1');

      // Nothing was deferred, so nothing can arrive afterwards to undo it.
      jest.runOnlyPendingTimers();
      fixture.detectChanges();

      expect(announcement()).toBe('Holdings moved to column 2, row 1');
    });

    // The last message wins, and two of them can never arrive out of order.
    it('should abandon a pending repeat when something newer is said', async () => {
      await createCanvas({ layout: of(cornerLayout) });
      paint();

      refuseLeftwardStep();
      refuseLeftwardStep();

      expect(announcement()).toBe('');

      moduleHostComponents()[0].move.emit({ deltaCols: 1, deltaRows: 0 });
      fixture.detectChanges();

      expect(announcement()).toBe('Holdings moved to column 2, row 1');

      jest.runOnlyPendingTimers();
      fixture.detectChanges();

      // The refusal did not arrive after the move it preceded.
      expect(announcement()).toBe('Holdings moved to column 2, row 1');
    });

    it('should leave no pending message behind when it is destroyed', async () => {
      await createCanvas({ layout: of(cornerLayout) });
      paint();

      refuseLeftwardStep();
      refuseLeftwardStep();

      expect(component.canvasAnnouncement).toBe('');

      fixture.destroy();

      jest.runOnlyPendingTimers();

      // The refill was cancelled with the component rather than firing against a
      // destroyed view and marking it for a check that will never come.
      expect(component.canvasAnnouncement).toBe('');
    });
  });

  /**
   * The two gestures that changed something and said nothing.
   *
   * A reveal of a module that is already placed does not add anything, so unless it
   * speaks it reads as a control that did nothing at all - and when the module was
   * already fully in view, nothing visible happens either. A pointer drag or resize
   * was announced by nobody: the keyboard path spoke for itself, so the live region
   * went on holding whatever the last keyboard step had put there while the viewer
   * moved cards around with a mouse.
   */
  describe('gestures the canvas used to make silently', () => {
    const twoModuleLayout: UserDashboardLayout = {
      modules: [
        { cols: 4, moduleType: 'holdings', rows: 4, x: 0, y: 0 },
        { cols: 3, moduleType: 'markets', rows: 4, x: 5, y: 0 }
      ],
      version: 1
    };

    const announcement = () => {
      return queryElement('[role="status"].sr-only').textContent.trim();
    };

    /**
     * The engine reporting a settled geometry, exactly as a released pointer drag
     * does.
     *
     * Driven through the configuration the canvas hands the engine rather than through
     * a handler, so the wiring is part of what is covered - and through
     * `itemChangeCallback` specifically, because that is the one the engine raises
     * once per settled change.
     */
    const reportSettledGeometry = (aItem: DashboardLayoutItem) => {
      component.options.itemChangeCallback(aItem, undefined);

      fixture.detectChanges();
    };

    // The first paint of every module, which is what the engine does before anything
    // can be dragged, and what gives the canvas a geometry to compare against.
    const reportFirstPaint = () => {
      for (const item of component.modules) {
        component.options.itemInitCallback(item, undefined);
      }
    };

    it('should say that a revealed module is already placed', async () => {
      await createCanvas({ layout: of(twoModuleLayout) });
      paint();

      revealModuleSubject.next(DashboardModuleType.MARKETS);
      fixture.detectChanges();

      // Nothing was added, nothing was moved and the module may well have been on
      // screen the whole time, so this sentence is the only evidence the request was
      // received at all.
      expect(component.modules).toHaveLength(2);
      expect(announcement()).toBe('Markets is already on the dashboard');
    });

    it('should say so even when it cannot put focus on the module', async () => {
      await createCanvas({ layout: of(twoModuleLayout) });
      paint();

      // No chrome to take focus, which is what a module still resolving its component
      // looks like. The announcement is the half that must not depend on the other:
      // whether focus landed is not something the viewer asked about.
      component.moduleHosts = {
        forEach: () => undefined,
        toArray: () => []
      } as unknown as typeof component.moduleHosts;

      revealModuleSubject.next(DashboardModuleType.HOLDINGS);
      fixture.detectChanges();

      expect(announcement()).toBe('Holdings is already on the dashboard');
    });

    it('should report where a module dragged with a pointer landed', async () => {
      await createCanvas({ layout: of(twoModuleLayout) });
      await paintAndSettle();
      reportFirstPaint();

      const holdings = component.modules[0];

      holdings.x = 2;
      holdings.y = 3;

      reportSettledGeometry(holdings);

      // The same sentence the keyboard path gives for the same outcome, because it is
      // the same outcome: the viewer moved a module and it landed somewhere.
      expect(announcement()).toBe('Holdings moved to column 3, row 4');
    });

    it('should report a resize done with a pointer as a resize', async () => {
      await createCanvas({ layout: of(twoModuleLayout) });
      await paintAndSettle();
      reportFirstPaint();

      const markets = component.modules[1];

      markets.cols = 5;

      reportSettledGeometry(markets);

      // Told apart from a move by what changed rather than by which hook reported it -
      // the engine raises one hook for both and carries no before-state, so the kind
      // is derived from the geometry this module was last seen holding.
      expect(announcement()).toBe('Markets resized to 5 columns by 4 rows');
    });

    it('should stay quiet about a module the engine merely re-reports', async () => {
      await createCanvas({ layout: of(twoModuleLayout) });
      await paintAndSettle();
      reportFirstPaint();

      reportSettledGeometry(component.modules[0]);

      // Nothing changed, so there is nothing to say. The engine re-reports items while
      // it settles an arrangement, and each of those would otherwise be an
      // announcement about a module that had not moved.
      expect(announcement()).toBe('');
    });

    /**
     * One gesture can settle two modules: dropping a card on an occupied cell swaps
     * the pair. The engine commits the dragged one first and the displaced one second,
     * so the LAST report of the task is about a module the viewer never touched -
     * which is why the first one is the one that is kept.
     */
    it('should report the module the viewer had hold of, not the one it displaced', async () => {
      await createCanvas({ layout: of(twoModuleLayout) });
      await paintAndSettle();
      reportFirstPaint();

      const [holdings, markets] = component.modules;

      holdings.x = 5;
      markets.x = 0;

      reportSettledGeometry(holdings);
      reportSettledGeometry(markets);

      expect(announcement()).toBe('Holdings moved to column 6, row 1');
    });

    it('should say nothing about a module arriving that it has already announced', async () => {
      await createCanvas({ layout: of(null) });
      await paintAndSettle();

      jest
        .spyOn(gridsterComponent(), 'getNextPossiblePosition')
        .mockReturnValue(true);

      moduleCatalogComponent().moduleAdded.emit(DashboardModuleType.HOLDINGS);
      paint();

      const added = announcement();

      expect(added).toContain('added to the dashboard');

      // The engine reports an auto-positioned arrival as a CHANGE before it reports the
      // module's first paint, so without the arrival being recognised as one the add
      // would be announced twice - the second time as a move.
      reportSettledGeometry(component.modules[0]);

      expect(announcement()).toBe(added);
    });

    it('should say that a refresh is under way', async () => {
      await createCanvas({ layout: of(twoModuleLayout) });
      paint();

      shouldReloadContentSubject.next();
      fixture.detectChanges();

      // Every module discards its content and fetches it again, which for a viewer is
      // the whole screen blinking through skeletons and for a reader was nothing: the
      // control reports only its own name, and the arrangement it acts on is
      // elsewhere. Said once for the canvas, because one gesture happened.
      expect(announcement()).toBe('Refreshing the dashboard');
    });
  });

  describe('removing a module', () => {
    const twoModuleLayout: UserDashboardLayout = {
      modules: [
        { cols: 4, moduleType: 'holdings', rows: 4, x: 0, y: 0 },
        { cols: 3, moduleType: 'markets', rows: 4, x: 5, y: 0 }
      ],
      version: 1
    };

    it('should announce which module was removed', async () => {
      await createCanvas({ layout: of(twoModuleLayout) });
      paint();

      moduleHostComponents()[0].remove.emit();
      paint();

      expect(component.modules).toHaveLength(1);
      expect(component.canvasAnnouncement).toContain('Holdings');
      expect(component.canvasAnnouncement).toContain('removed');
    });

    // Emptying the canvas puts the viewer back exactly where a first visit puts
    // them: nothing placed, and the only way forward is to place something. So it
    // gets the same treatment - the catalog comes to them rather than leaving a
    // bare canvas whose one affordance is a floating button.
    it('should open the catalog when the last module goes', async () => {
      await createCanvas({ layout: of(twoModuleLayout) });
      paint();

      expect(component.isCatalogOpen).toBe(false);

      moduleHostComponents()[0].remove.emit();
      paint();

      // Not on the way to empty - only on arrival. A viewer thinning out a busy
      // canvas must not have a panel thrown open at them after every removal.
      expect(component.modules).toHaveLength(1);
      expect(component.isCatalogOpen).toBe(false);

      moduleHostComponents()[0].remove.emit();
      paint();

      expect(component.modules).toEqual([]);
      expect(component.isCatalogOpen).toBe(true);
    });

    it('should leave a removal that matches nothing alone', async () => {
      await createCanvas({ layout: of(twoModuleLayout) });
      paint();

      component.onRemoveModule({
        cols: 2,
        moduleType: DashboardModuleType.FIRE,
        rows: 2,
        x: 0,
        y: 0
      });
      paint();

      expect(component.modules).toHaveLength(2);
      expect(component.canvasAnnouncement).toBe('');
      expect(component.isCatalogOpen).toBe(false);
    });
  });

  describe('keyboard move and resize', () => {
    /**
     * Two modules side by side, each well clear of the grid's edges and of each
     * other, so that a single one-cell step in any direction is legal to begin with
     * and every refusal below is caused by the one condition its test is about.
     *
     * `markets` is placed at exactly its own declared minimum width - the registry
     * gives it three columns where the grid-wide floor is two - so shrinking it is
     * refused by the stricter of the two limits rather than by the floor.
     */
    const twoModuleLayout: UserDashboardLayout = {
      modules: [
        { cols: 4, moduleType: 'holdings', rows: 4, x: 0, y: 1 },
        { cols: 3, moduleType: 'markets', rows: 4, x: 5, y: 1 }
      ],
      version: 1
    };

    /** The placed module the geometry requests below are aimed at. */
    const holdings = () => component.modules[0];

    const markets = () => component.modules[1];

    /**
     * Emits a geometry step the way the real module chrome does.
     *
     * Driven through the chrome's output rather than by calling the handler, so the
     * canvas's own template binding is part of what every assertion covers.
     */
    const requestMove = (
      aHostIndex: number,
      aStep: DashboardModuleGeometryStep
    ) => {
      moduleHostComponents()[aHostIndex].move.emit(aStep);

      fixture.detectChanges();
    };

    const requestResize = (
      aHostIndex: number,
      aStep: DashboardModuleGeometryStep
    ) => {
      moduleHostComponents()[aHostIndex].resize.emit(aStep);

      fixture.detectChanges();
    };

    /**
     * What the canvas is currently announcing, read off the rendered live region.
     *
     * Qualified by `sr-only` because the canvas carries two status regions and they
     * are not interchangeable: this one is permanent and never visible, while the
     * unsaved-arrangement notice is visible and conditional. Selecting on the role
     * alone would let either test match the other's region.
     */
    const announcement = () => {
      return queryElement('[role="status"].sr-only').textContent.trim();
    };

    it('should carry a polite live region for announcing the outcome', async () => {
      await createCanvas({ layout: of(twoModuleLayout) });
      paint();

      const liveRegion = queryElement('[role="status"].sr-only');

      // Polite rather than assertive on purpose: a stream of one-cell steps must not
      // interrupt whatever is being read, and each announcement supersedes the last.
      expect(liveRegion).toBeTruthy();
      expect(liveRegion.getAttribute('aria-live')).toBe('polite');

      // Announced, never shown. The class is Bootstrap's own, which this workspace
      // already ships, so the region is genuinely off-screen rather than merely
      // small.
      expect(liveRegion.classList.contains('sr-only')).toBe(true);

      // Nothing to say before anything has been asked for.
      expect(announcement()).toBe('');
    });

    it('should move a module by one cell and report the change once', async () => {
      await createCanvas({ layout: of(twoModuleLayout) });
      paint();

      requestMove(0, { deltaCols: 1, deltaRows: 0 });

      expect(placedGeometry()[0]).toEqual({
        cols: 4,
        moduleType: DashboardModuleType.HOLDINGS,
        rows: 4,
        x: 1,
        y: 1
      });

      // One write per settled step, and it arrives the same way a drag's does: the
      // engine commits the geometry and raises `itemChangeCallback`, which is the
      // single write origin. A keyboard path that scheduled its own save would show
      // up here as a second call.
      expect(dashboardLayoutServiceMock.scheduleSave).toHaveBeenCalledTimes(1);
    });

    it('should announce where a moved module landed, counting from one', async () => {
      await createCanvas({ layout: of(twoModuleLayout) });
      paint();

      requestMove(0, { deltaCols: 0, deltaRows: 1 });

      // The grid counts cells from zero; a person counting columns does not. The
      // module name is the registry's own, already translated.
      expect(announcement()).toBe('Holdings moved to column 1, row 3');
    });

    it('should refuse a move that would leave the grid', async () => {
      await createCanvas({ layout: of(twoModuleLayout) });
      paint();

      requestMove(0, { deltaCols: -1, deltaRows: 0 });

      // Held at the edge rather than clamped silently: the module stays exactly
      // where it was, nothing is persisted, and the refusal is spoken - otherwise a
      // key that did nothing is indistinguishable from one that never registered.
      expect(placedGeometry()[0].x).toBe(0);
      expect(dashboardLayoutServiceMock.scheduleSave).not.toHaveBeenCalled();

      // The direction is named. `cannot be moved any further` was the same sentence
      // for all four arrow keys, which told a reader who could not see the module
      // nothing about which of their presses had been refused.
      expect(announcement()).toBe(
        'Holdings cannot be moved left: there is no room'
      );
    });

    it('should refuse a move that would overlap a sibling', async () => {
      await createCanvas({ layout: of(twoModuleLayout) });
      paint();

      // Two columns right would put holdings' right edge inside markets' left one.
      requestMove(0, { deltaCols: 1, deltaRows: 0 });
      requestMove(0, { deltaCols: 1, deltaRows: 0 });

      expect(placedGeometry()[0].x).toBe(1);
      expect(placedGeometry()[1].x).toBe(5);

      // The first step was legal, so exactly one write was scheduled; the second was
      // refused and added none.
      expect(dashboardLayoutServiceMock.scheduleSave).toHaveBeenCalledTimes(1);

      // A neighbour rather than the boundary of the grid, and the wording covers
      // both deliberately: `there is no room` is true either way, whereas naming an
      // edge would be wrong here - this module is nowhere near one.
      expect(announcement()).toBe(
        'Holdings cannot be moved right: there is no room'
      );
    });

    it('should resize a module by one cell and announce its new size', async () => {
      await createCanvas({ layout: of(twoModuleLayout) });
      paint();

      requestResize(1, { deltaCols: 0, deltaRows: 1 });

      expect(placedGeometry()[1]).toEqual({
        cols: 3,
        moduleType: DashboardModuleType.MARKETS,
        rows: 5,
        x: 5,
        y: 1
      });

      // Size, not position: a resize grows the bottom-right corner, which is the
      // pair of edges the pointer handles expose, so the two input methods cannot
      // disagree about which way a module grows.
      expect(announcement()).toBe('Markets resized to 3 columns by 5 rows');
      expect(dashboardLayoutServiceMock.scheduleSave).toHaveBeenCalledTimes(1);
    });

    it('should refuse a resize below the module’s declared minimum', async () => {
      await createCanvas({ layout: of(twoModuleLayout) });
      paint();

      expect(placedMinimums()[1]).toEqual({
        minItemCols: 3,
        minItemRows: 2,
        moduleType: DashboardModuleType.MARKETS
      });

      requestResize(1, { deltaCols: -1, deltaRows: 0 });

      // This is the registry's declared floor becoming an enforced one, on the
      // keyboard path as much as on the pointer path: markets asks for three columns
      // and is already at three, so it cannot give one up even though the grid-wide
      // floor would still allow two.
      expect(placedGeometry()[1].cols).toBe(3);
      expect(dashboardLayoutServiceMock.scheduleSave).not.toHaveBeenCalled();
      expect(announcement()).toBe('Markets is already as narrow as it goes');
    });

    it('should refuse a resize that would run past the grid edge', async () => {
      await createCanvas({
        layout: of({
          modules: [{ cols: 4, moduleType: 'holdings', rows: 4, x: 8, y: 0 }],
          version: 1
        })
      });
      paint();

      // Flush against the right-hand edge: eight plus four is the full twelve
      // columns, so one more cannot fit.
      requestResize(0, { deltaCols: 1, deltaRows: 0 });

      expect(placedGeometry()[0].cols).toBe(4);
      expect(dashboardLayoutServiceMock.scheduleSave).not.toHaveBeenCalled();
      // A growth refused by the width of the grid, which reads the same as a growth
      // refused by a neighbour and deliberately so: `there is no room` is true of
      // both, and the viewer's next move is the same either way. A shrink is the case
      // that names its limit instead, because only the module's own minimum can stop
      // one - see the test above.
      expect(announcement()).toBe(
        'Holdings cannot be made wider: there is no room'
      );
    });

    it('should let the grid engine be the only judge of a geometry request', async () => {
      await createCanvas({ layout: of(twoModuleLayout) });
      paint();

      // A step that every limit would otherwise allow, refused solely because the
      // engine's own gate was made to refuse it. That is the whole assertion: the
      // canvas applies no validation of its own, so there is no second opinion here
      // to drift away from the one the pointer path already obeys.
      component.options.itemValidateCallback = () => false;

      requestMove(0, { deltaCols: 0, deltaRows: 1 });

      expect(placedGeometry()[0].y).toBe(1);
      expect(dashboardLayoutServiceMock.scheduleSave).not.toHaveBeenCalled();

      // Named after the step that was asked for rather than after the reason it was
      // refused, which is the only thing the viewer knows they did.
      expect(announcement()).toBe(
        'Holdings cannot be moved down: there is no room'
      );
    });

    it('should ignore a geometry request for a module the grid is not holding', async () => {
      await createCanvas({ layout: of(twoModuleLayout) });
      paint();

      const stranger: DashboardLayoutItem = {
        cols: 4,
        minItemCols: 2,
        minItemRows: 2,
        moduleType: DashboardModuleType.WATCHLIST,
        rows: 4,
        x: 0,
        y: 0
      };

      // A request naming an item the grid never rendered - a cell removed while its
      // keystroke was still in flight. Nothing is placed, nothing is written and
      // nothing faults.
      expect(() => {
        component.onMoveModule(stranger, { deltaCols: 1, deltaRows: 0 });
        component.onResizeModule(stranger, { deltaCols: 1, deltaRows: 0 });
      }).not.toThrow();

      expect(placedGeometry()).toHaveLength(2);
      expect(dashboardLayoutServiceMock.scheduleSave).not.toHaveBeenCalled();
      expect(announcement()).toBe('');
    });

    it('should never write the arrangement itself on a geometry request', async () => {
      await createCanvas({ layout: of(twoModuleLayout) });
      paint();

      requestMove(0, { deltaCols: 1, deltaRows: 0 });
      requestResize(1, { deltaCols: 0, deltaRows: 1 });

      // Both steps went through the layout service, and neither reached the HTTP
      // facade: the debounce that collapses a burst of steps into one request lives
      // there, and a canvas that patched directly would defeat it.
      expect(dataServiceMock.patchUserDashboardLayout).not.toHaveBeenCalled();
      expect(dataServiceMock.fetchUserDashboardLayout).not.toHaveBeenCalled();
      expect(dashboardLayoutServiceMock.scheduleSave).toHaveBeenCalledTimes(2);
    });

    it('should keep holding the same array a geometry step mutated', async () => {
      await createCanvas({ layout: of(twoModuleLayout) });
      paint();

      const before = component.modules;
      const movedItem = holdings();
      const untouchedItem = markets();

      requestMove(0, { deltaCols: 1, deltaRows: 0 });

      // One array, one item object per cell, mutated in place by the engine. A
      // canvas that answered a step by rebuilding either would remount every module
      // on the grid and lose the engine's own handle on the item it was told to
      // move.
      expect(component.modules).toBe(before);
      expect(holdings()).toBe(movedItem);
      expect(markets()).toBe(untouchedItem);
    });
  });

  describe('the single persistence path', () => {
    const singleModuleLayout: UserDashboardLayout = {
      modules: [{ cols: 5, moduleType: 'holdings', rows: 4, x: 0, y: 0 }],
      version: 1
    };

    it('should report a layout change when a module is added from the catalog', async () => {
      await createCanvas();
      paint();

      jest
        .spyOn(gridsterComponent(), 'getNextPossiblePosition')
        .mockReturnValue(true);

      moduleCatalogComponent().moduleAdded.emit(DashboardModuleType.HOLDINGS);
      paint();

      // Mutating the array is not itself a report, and this is the assertion that says
      // so. In a browser the pushed item renders a cell whose initialization the engine
      // announces through `itemInitCallback`; in this environment gridster raises none
      // of its own callbacks, so it is announced here instead - through the very
      // configuration the canvas handed the engine, which is the only wiring that could
      // carry it.
      expect(dashboardLayoutServiceMock.scheduleSave).not.toHaveBeenCalled();

      component.options.itemInitCallback(
        component.modules[0],
        gridsterItemComponents()[0]
      );

      expect(dashboardLayoutServiceMock.scheduleSave).toHaveBeenCalledTimes(1);
      expect(
        dashboardLayoutServiceMock.scheduleSave.mock.calls[0][1]
      ).toHaveLength(1);
    });

    it('should report a layout change when a module is removed from its chrome', async () => {
      await createCanvas({ layout: of(singleModuleLayout) });
      paint();

      moduleHostComponents()[0].remove.emit();

      // Splicing the array is not itself a report either.
      expect(component.modules).toEqual([]);
      expect(dashboardLayoutServiceMock.scheduleSave).not.toHaveBeenCalled();

      // Painting destroys the spliced module's cell, and the engine announces that
      // destruction through `itemRemovedCallback` on its own - `GridsterItem.ngOnDestroy`
      // calls `removeItem`, which raises the callback unconditionally. So unlike the add
      // path this one is genuinely end-to-end here, and it is the report.
      paint();

      expect(dashboardLayoutServiceMock.scheduleSave).toHaveBeenCalledTimes(1);
      expect(dashboardLayoutServiceMock.scheduleSave.mock.calls[0][1]).toEqual(
        []
      );
    });

    it('should report a layout change when a module is dropped onto an empty cell', async () => {
      await createCanvas();
      paint();

      dropOnEmptyCell(DashboardModuleType.HOLDINGS, { x: 3, y: 5 });
      paint();

      // The cell comes from the candidate the engine had already positioned under the
      // pointer; the size comes from the definition. Neither is computed here, and the
      // released cell is kept because the engine accepts the definition-sized item
      // there.
      expect(placedGeometry()).toEqual([
        {
          cols: 6,
          moduleType: DashboardModuleType.HOLDINGS,
          rows: 4,
          x: 3,
          y: 5
        }
      ]);

      // A drop is an add, and it reaches persistence the same single way an add does.
      expect(dashboardLayoutServiceMock.scheduleSave).not.toHaveBeenCalled();

      component.options.itemInitCallback(
        component.modules[0],
        gridsterItemComponents()[0]
      );

      expect(dashboardLayoutServiceMock.scheduleSave).toHaveBeenCalledTimes(1);
    });

    it('should screen a dropped module at its own footprint rather than the preview', async () => {
      await createCanvas();
      paint();

      const gridster = gridsterComponent();
      const collisionSpy = jest.spyOn(gridster, 'checkCollision');

      dropOnEmptyCell(DashboardModuleType.HOLDINGS, { x: 3, y: 5 });

      // The candidate the library hands over is its own, minted at the configured
      // default footprint because it cannot know which module is on the pointer. The
      // item that actually goes onto the canvas carries the registry's declared
      // footprint instead, so it is that item - with its minimums attached, or the
      // engine's validation would measure the placement against nothing - that has to
      // be screened.
      expect(collisionSpy).toHaveBeenCalledTimes(1);
      expect(collisionSpy).toHaveBeenCalledWith({
        cols: 6,
        minItemCols: 2,
        minItemRows: 2,
        moduleType: DashboardModuleType.HOLDINGS,
        rows: 4,
        x: 3,
        y: 5
      });
    });

    it('should relocate a dropped module whose footprint overflows the released cell', async () => {
      await createCanvas({
        viewer: {
          id: 'viewer-1',
          permissions: [permissions.readMarketDataOfMarkets]
        }
      });
      paint();

      // Seven columns released at column six needs thirteen, and the grid is locked to
      // twelve. Nothing is mocked here: the engine reaches that conclusion itself, and
      // the fallback relocation is its own answer too.
      dropOnEmptyCell(DashboardModuleType.MARKETS_PREMIUM, { x: 6, y: 0 });

      expect(placedGeometry()).toEqual([
        {
          cols: 7,
          moduleType: DashboardModuleType.MARKETS_PREMIUM,
          rows: 5,
          x: 0,
          y: 0
        }
      ]);
    });

    it('should look for room at or below the released row', async () => {
      await createCanvas();
      paint();

      const gridster = gridsterComponent();

      jest.spyOn(gridster, 'checkCollision').mockReturnValue(true);

      const positionSpy = jest
        .spyOn(gridster, 'getNextPossiblePosition')
        .mockReturnValue(true);

      dropOnEmptyCell(DashboardModuleType.HOLDINGS, { x: 3, y: 5 });

      // A module that will not fit where it was let go should appear near where it was
      // let go, not at the top of a canvas the viewer may have scrolled far past.
      expect(positionSpy).toHaveBeenCalledWith(expect.anything(), { y: 5 });
    });

    it('should add nothing when a dropped module fits nowhere', async () => {
      await createCanvas();
      paint();

      const gridster = gridsterComponent();

      jest.spyOn(gridster, 'checkCollision').mockReturnValue(true);
      jest.spyOn(gridster, 'getNextPossiblePosition').mockReturnValue(false);

      dropOnEmptyCell(DashboardModuleType.HOLDINGS, { x: 3, y: 5 });

      // The array this would have been appended to is the authoritative one and is what
      // gets persisted, so an item the engine will not accept anywhere must not enter
      // it - and must not be scheduled for a write either.
      expect(component.modules).toEqual([]);
      expect(dashboardLayoutServiceMock.scheduleSave).not.toHaveBeenCalled();
    });

    it('should keep the origin when there is no grid to ask yet', async () => {
      // Deliberately unpainted: the canvas finishes resolving its viewer and their
      // arrangement while it is being constructed, so this is the one window in which a
      // module can be added before any grid exists to place it.
      await createCanvas();

      component.onAddModule(DashboardModuleType.HOLDINGS);

      // Nothing is guessed in the engine's absence. The item keeps the origin it was
      // minted with, and the engine settles it through this very routine when it
      // initialises and adds the item itself.
      expect(placedGeometry()).toEqual([
        {
          cols: 6,
          moduleType: DashboardModuleType.HOLDINGS,
          rows: 4,
          x: 0,
          y: 0
        }
      ]);
    });

    it('should let a native drop on the grid reach the canvas at all', async () => {
      await createCanvas();
      paint();

      const gridster = gridsterComponent();

      // A real layout engine would have measured these; nothing does here, and a zero
      // column width turns the library's own cell arithmetic into `NaN`. Supplying them
      // is what makes the cell this drop resolves to assertable.
      gridster.curColWidth = 100;
      gridster.curRowHeight = 80;

      const drop = Object.assign(
        new MouseEvent('drop', { bubbles: true, clientX: 250, clientY: 160 }),
        {
          dataTransfer: {
            getData: (aFormat: string) =>
              aFormat === 'text/plain' ? DashboardModuleType.HOLDINGS : null
          }
        }
      );

      gridster.el.dispatchEvent(drop);

      // The only test in this file that drives the drop through the engine rather than
      // through the configuration's callback directly, and it exists for one reason: the
      // library screens its own drag-over candidate with
      // `if (!$options.enableOccupiedCellDrop && checkCollision(item))` and that
      // candidate carries no per-item minimums, so a minimum predicate that refused it
      // would leave `emptyCellDropCallback` unreachable - drag-to-add silently dead in
      // every browser while every other assertion in this file still passed. Holding a
      // contract-less candidate to the grid floor is what keeps this path alive, and
      // reaching the canvas at all is therefore the point of this test.
      //
      // The cell it lands in is the engine's own arithmetic, reproduced here so that a
      // change to it would be visible: the outer margin of ten pixels is subtracted
      // before the division, so 250px resolves to column `floor(240 / 100)` and 160px to
      // row `floor(150 / 80)`. The footprint comes from the registry definition, exactly
      // as on every other path that places a module.
      expect(placedGeometry()).toEqual([
        {
          cols: 6,
          moduleType: DashboardModuleType.HOLDINGS,
          rows: 4,
          x: 2,
          y: 1
        }
      ]);
    });

    it('should leave a native drop onto an occupied cell to the engine to refuse', async () => {
      await createCanvas({ layout: of(singleModuleLayout) });
      paint();

      const gridster = gridsterComponent();

      gridster.curColWidth = 100;
      gridster.curRowHeight = 80;

      // A module that is NOT already on the canvas, so what is being asserted is the
      // refusal of the cell rather than the canvas declining to place something twice.
      const drop = Object.assign(
        new MouseEvent('drop', { bubbles: true, clientX: 20, clientY: 20 }),
        {
          dataTransfer: {
            getData: (aFormat: string) =>
              aFormat === 'text/plain' ? DashboardModuleType.MARKETS : null
          }
        }
      );

      gridster.el.dispatchEvent(drop);
      paint();

      // The engine screens its own drag-over candidate with `checkCollision` and answers
      // a cell that is already taken by returning nothing at all, so
      // `emptyCellDropCallback` is never reached and the canvas is never asked. That is
      // the engine's default and the frozen configuration keeps it: `dropEffect` reads
      // `none` over an occupied cell while the drag is still in flight, so the refusal is
      // visible to the viewer before they release rather than silent afterwards.
      expect(placedGeometry()).toEqual([
        {
          cols: 5,
          moduleType: DashboardModuleType.HOLDINGS,
          rows: 4,
          x: 0,
          y: 0
        }
      ]);
    });

    it('should read the drop payload from the text/plain key', async () => {
      await createCanvas();
      paint();

      const getData = dropOnEmptyCell(DashboardModuleType.HOLDINGS);

      expect(getData).toHaveBeenCalledWith('text/plain');
      expect(component.modules).toHaveLength(1);
    });

    it('should report a layout change from each of the grid four change triggers', async () => {
      await createCanvas({ layout: of(singleModuleLayout) });
      await paintAndSettle();

      const [itemComponent] = gridsterItemComponents();
      const callbacks = gridChangeCallbacks();

      expect(callbacks).toHaveLength(4);

      let expectedSaves = 0;

      for (const [index, callback] of callbacks.entries()) {
        expect(typeof callback).toBe('function');

        // Each trigger is given a genuinely different arrangement to report,
        // because a trigger that carries no change is deliberately not a write -
        // see 'should not report a layout change that changes nothing'. Widening
        // the module by one column per iteration is the smallest such difference
        // and keeps every trigger individually observable.
        component.modules[0].cols = 4 + index;

        callback(component.modules[0], itemComponent);

        expectedSaves += 1;

        expect(dashboardLayoutServiceMock.scheduleSave).toHaveBeenCalledTimes(
          expectedSaves
        );
      }

      expect(dashboardLayoutServiceMock.scheduleSave).toHaveBeenCalledTimes(4);
    });

    it('should bring a newly placed module into view and nothing else', async () => {
      await createCanvas({ layout: of(singleModuleLayout) });
      paint();

      // Hydration is drawn first, and each of its cells reports a first paint. The
      // library's own `scrollToNewItems` is applied from that same place and so cannot
      // tell a restored module from an added one, so the canvas withholds it while it
      // draws them: a returning viewer's canvas must not scroll as it loads. The
      // configuration itself ships the option ON - that is grid policy, and it is
      // asserted in `architectural invariants` - which is exactly why withholding it
      // here has to be asserted too.
      expect(scrollIntoViewMock).not.toHaveBeenCalled();
      expect(component.options.scrollToNewItems).toBe(false);

      moduleCatalogComponent().moduleAdded.emit(DashboardModuleType.MARKETS);
      paint();

      // Released for the cell the viewer asked for, before it is drawn, because the
      // engine reads the option on entry to the size computation that draws it.
      expect(component.options.scrollToNewItems).toBe(true);

      const added = component.modules.find(({ moduleType }) => {
        return moduleType === DashboardModuleType.MARKETS;
      });

      // The cell does not exist at the moment the module is placed, so the grid
      // reporting its first paint is the earliest it can be revealed.
      component.options.itemInitCallback(added, gridsterItemComponents()[0]);

      expect(scrollIntoViewMock).toHaveBeenCalledTimes(1);

      // And only once: a later first paint - the next hydration's, for instance -
      // finds nothing marked for reveal.
      component.options.itemInitCallback(added, gridsterItemComponents()[0]);
      component.options.itemInitCallback(
        component.modules[0],
        gridsterItemComponents()[0]
      );

      expect(scrollIntoViewMock).toHaveBeenCalledTimes(1);
    });

    it('should not report a layout change that changes nothing', async () => {
      await createCanvas({ layout: of(singleModuleLayout) });
      await paintAndSettle();

      const [itemComponent] = gridsterItemComponents();

      // The grid does not only report intent: it fires its init callback once per
      // cell while a saved arrangement is drawn and its resize callback on every
      // pixel reflow, so merely opening the catalog drawer produces one trigger
      // per placed module. None of those moves anything, and scheduling a write
      // for them would overwrite a returning viewer's stored arrangement with
      // whatever happened to be on screen.
      component.options.itemInitCallback(component.modules[0], itemComponent);
      component.options.itemResizeCallback(component.modules[0], itemComponent);
      component.options.itemChangeCallback(component.modules[0], itemComponent);

      expect(dashboardLayoutServiceMock.scheduleSave).not.toHaveBeenCalled();

      component.modules[0].x = 3;

      component.options.itemChangeCallback(component.modules[0], itemComponent);

      // A real change still reports, on the very first trigger that carries it.
      expect(dashboardLayoutServiceMock.scheduleSave).toHaveBeenCalledTimes(1);
    });

    it('should keep owning one array while reporting the arrangement as its own projection', async () => {
      await createCanvas({ layout: of(singleModuleLayout) });
      await paintAndSettle();

      const ownedArray = component.modules;
      const [itemComponent] = gridsterItemComponents();
      const placedItem = ownedArray[0];

      ownedArray[0].cols = 8;

      component.options.itemChangeCallback(ownedArray[0], itemComponent);
      moduleHostComponents()[0].remove.emit();
      component.options.itemRemovedCallback(placedItem, itemComponent);

      // The array's identity is still part of the contract with the grid engine,
      // which writes coordinates straight onto the objects inside it, so it is
      // mutated in place and never replaced.
      expect(component.modules).toBe(ownedArray);
      expect(dashboardLayoutServiceMock.scheduleSave.mock.calls).toHaveLength(
        2
      );

      for (const [, reported] of dashboardLayoutServiceMock.scheduleSave.mock
        .calls) {
        // What is *reported* is deliberately not that array. The complete
        // arrangement is not necessarily all on the canvas - a module the viewer
        // is not entitled to see has a saved position and no cell - so handing
        // over the grid array would describe the visible subset as the whole
        // arrangement and the server would delete the rest. Each report is
        // therefore the canvas's own five-field projection, which is also what
        // stops the grid mutating a snapshot after it was taken.
        expect(reported).not.toBe(ownedArray);

        for (const module of reported as unknown[]) {
          expect(Object.keys(module as object).sort()).toEqual([
            'cols',
            'moduleType',
            'rows',
            'x',
            'y'
          ]);
        }
      }

      // The first report carries the resized module; the second carries the empty
      // canvas the removal left, which is a state the viewer can legitimately
      // reach and must be persistable.
      const [[, firstReported], [, secondReported]] =
        dashboardLayoutServiceMock.scheduleSave.mock.calls;

      expect(firstReported).toEqual([
        {
          cols: 8,
          moduleType: DashboardModuleType.HOLDINGS,
          rows: singleModuleLayout.modules[0].rows,
          x: singleModuleLayout.modules[0].x,
          y: singleModuleLayout.modules[0].y
        }
      ]);
      expect(secondReported).toEqual([]);
    });

    it('should never write the layout itself', async () => {
      await createCanvas({ layout: of(singleModuleLayout) });
      paint();

      const [itemComponent] = gridsterItemComponents();
      const placedItem = component.modules[0];

      component.options.itemResizeCallback(placedItem, itemComponent);
      dropOnEmptyCell(DashboardModuleType.MARKETS, { x: 6, y: 0 });
      moduleHostComponents()[0].remove.emit();
      component.options.itemRemovedCallback(placedItem, itemComponent);

      expect(dashboardLayoutServiceMock.scheduleSave).toHaveBeenCalled();
      expect(dataServiceMock.patchUserDashboardLayout).not.toHaveBeenCalled();
      expect(dataServiceMock.fetchUserDashboardLayout).not.toHaveBeenCalled();
    });

    it('should ignore a drop that carries no transfer object', async () => {
      await createCanvas();
      paint();

      expect(() => dropOnEmptyCell(null)).not.toThrow();

      expect(component.modules).toEqual([]);
      expect(dashboardLayoutServiceMock.scheduleSave).not.toHaveBeenCalled();
    });

    it('should ignore a drop whose payload names an unknown module', async () => {
      await createCanvas();
      paint();

      dropOnEmptyCell('legacy-net-worth');

      expect(component.modules).toEqual([]);
      expect(dashboardLayoutServiceMock.scheduleSave).not.toHaveBeenCalled();
    });

    it('should ignore a drop whose payload names a module the viewer may not see', async () => {
      await createCanvas({ viewer: { id: 'viewer-1', permissions: [] } });
      paint();

      dropOnEmptyCell(DashboardModuleType.ADMIN_OVERVIEW);

      expect(component.modules).toEqual([]);
      expect(dashboardLayoutServiceMock.scheduleSave).not.toHaveBeenCalled();
    });

    it('should ignore the removal of an item that is not on the canvas', async () => {
      await createCanvas({ layout: of(singleModuleLayout) });
      paint();

      const foreignItem: DashboardLayoutItem = {
        cols: 4,
        minItemCols: 3,
        minItemRows: 2,
        moduleType: DashboardModuleType.MARKETS,
        rows: 3,
        x: 6,
        y: 0
      };

      component.onRemoveModule(foreignItem);

      expect(component.modules).toHaveLength(1);
      expect(dashboardLayoutServiceMock.scheduleSave).not.toHaveBeenCalled();
    });

    it('should report nothing once the viewer has signed out', async () => {
      await createCanvas({ layout: of(singleModuleLayout) });
      paint();

      const [itemComponent] = gridsterItemComponents();
      const placedItem = component.modules[0];

      userServiceMock.stateChanged.next({ user: null });

      component.options.itemRemovedCallback(placedItem, itemComponent);

      // Signing out tears the canvas down, and every destroyed cell invokes the
      // item-removed callback on its way out. Those are teardown rather than intent, so
      // reporting them would schedule a write of an empty arrangement and erase what
      // the viewer had saved. Writes are refused before the arrangement is cleared, and
      // then again for as long as the canvas is signed out, so the guard holds whichever
      // order the destructions arrive in.
      expect(component.isSignedOut).toBe(true);
      expect(component.isInitialized).toBe(false);
      expect(component.modules).toHaveLength(0);
      expect(dashboardLayoutServiceMock.scheduleSave).not.toHaveBeenCalled();
      expect(component.modules).toEqual([]);
      // Signing out ends an identity, so the layout service is told to withdraw write
      // authorisation and discard anything still pending rather than letting it be sent
      // with a token that no longer exists.
      expect(
        dashboardLayoutServiceMock.beginIdentityTransition
      ).toHaveBeenCalled();
    });

    it('should report nothing before the canvas has finished initializing', async () => {
      await createCanvas({ viewer: undefined, viewerRequest: EMPTY });
      paint();

      revealModuleSubject.next(DashboardModuleType.HOLDINGS);

      expect(component.isInitialized).toBe(false);
      expect(component.modules).toEqual([]);
      expect(dashboardLayoutServiceMock.scheduleSave).not.toHaveBeenCalled();
    });
  });

  /**
   * The control bar's refresh, answered where the modules actually are.
   *
   * The chrome that mounts a module is stood in for throughout this spec, so these
   * tests reach the query the canvas holds rather than the rendered chrome: they
   * substitute recording hosts for it and then push the shell's bus. That is the
   * whole of the canvas's own responsibility here - the re-mounting itself belongs
   * to the chrome and is covered by its own spec - and the last test below is what
   * keeps the two halves named the same thing.
   */
  describe('refreshing what is on the canvas', () => {
    const twoModuleLayout: UserDashboardLayout = {
      modules: [
        { cols: 5, moduleType: 'holdings', rows: 4, x: 0, y: 0 },
        { cols: 4, moduleType: 'markets', rows: 3, x: 5, y: 0 }
      ],
      version: 1
    };

    /**
     * Replaces the canvas's own view query with hosts that record being reloaded.
     *
     * Assigned rather than rendered because every module chrome in this spec is a
     * stand-in, so the real query - which matches the real chrome type - resolves
     * to nothing here. Nothing is painted after this returns, which is what keeps
     * the substitution in place: the next change-detection pass would refresh the
     * query and discard it.
     */
    const substituteRecordingHosts = (count: number) => {
      const hosts = Array.from({ length: count }, () => ({
        reload: jest.fn<Promise<void>, []>(() => Promise.resolve())
      }));

      // Both members, because the real query offers both and the canvas needs the
      // array form: a refresh now waits for every module to finish re-mounting
      // before it reports itself over, and waiting means collecting the promises.
      // A double that offered only `forEach` made the canvas see no hosts at all.
      component.moduleHosts = {
        forEach: (callback: (host: (typeof hosts)[number]) => void) => {
          hosts.forEach(callback);
        },
        toArray: () => hosts
      } as unknown as typeof component.moduleHosts;

      return hosts;
    };

    it('should re-mount every module that is currently placed', async () => {
      await createCanvas({ layout: of(twoModuleLayout) });
      paint();

      const hosts = substituteRecordingHosts(2);

      shouldReloadContentSubject.next();

      expect(hosts.map(({ reload }) => reload.mock.calls.length)).toEqual([
        1, 1
      ]);
    });

    it('should not report a layout change for a refresh', async () => {
      await createCanvas({ layout: of(twoModuleLayout) });
      paint();

      const geometryBefore = placedGeometry();

      dashboardLayoutServiceMock.scheduleSave.mockClear();
      substituteRecordingHosts(2);

      shouldReloadContentSubject.next();

      // Re-reading data is not a change to the arrangement, so a refresh must
      // leave every cell where it is and must not reach the write path at all -
      // otherwise the control would quietly cost a request against the layout
      // endpoint every time it was pressed.
      expect(placedGeometry()).toEqual(geometryBefore);
      expect(dashboardLayoutServiceMock.scheduleSave).not.toHaveBeenCalled();
      expect(dataServiceMock.patchUserDashboardLayout).not.toHaveBeenCalled();
    });

    it('should survive a refresh asked for with nothing placed', async () => {
      await createCanvas();
      paint();

      expect(component.modules).toEqual([]);

      // An empty canvas is the state a first-time viewer is in, and the control is
      // reachable from it, so this has to be silent rather than an error.
      expect(() => {
        shouldReloadContentSubject.next();
      }).not.toThrow();

      expect(dashboardLayoutServiceMock.scheduleSave).not.toHaveBeenCalled();
    });

    it('should stop answering the bus once the canvas is gone', async () => {
      await createCanvas({ layout: of(twoModuleLayout) });
      paint();

      const hosts = substituteRecordingHosts(2);

      fixture.destroy();

      shouldReloadContentSubject.next();

      // The bus outlives this canvas - the shell owns it - so an unterminated
      // subscription would keep re-mounting modules that are no longer on screen.
      expect(hosts.map(({ reload }) => reload.mock.calls.length)).toEqual([
        0, 0
      ]);
    });

    it('should target a chrome that can actually be re-mounted', () => {
      // The bridge between this spec and the chrome's own. Every host here is a
      // stand-in, so nothing above would notice if the real chrome stopped
      // exposing the method the canvas calls on it - and `strictTemplates` is off
      // in this project, so the compiler would not either.
      expect(typeof GfDashboardModuleHostComponent.prototype.reload).toBe(
        'function'
      );
    });
  });

  /**
   * The footprint the grid engine draws while a catalog row is dragged over it.
   *
   * The engine mints its drop-indicator candidate as `{ x, y, cols:
   * defaultItemCols, rows: defaultItemRows }` - two grid-wide members it reads from
   * the configuration and nowhere else - so every module was previewed at 4x4
   * while the item appended on drop carried the registry's own footprint. Placement
   * was never wrong; only the indicator was, and only for a module whose registered
   * default is not 4x4.
   */
  describe('the drop indicator for a dragged catalog row', () => {
    const savedLayoutForPreview: UserDashboardLayout = {
      modules: [{ cols: 6, moduleType: 'holdings', rows: 4, x: 0, y: 0 }],
      version: 1
    };

    const readPreviewFootprint = () => {
      return {
        cols: component.options.defaultItemCols,
        rows: component.options.defaultItemRows
      };
    };

    it('should describe the engine default before any drag', async () => {
      await createCanvas();
      paint();

      expect(readPreviewFootprint()).toEqual({ cols: 4, rows: 4 });
    });

    it('should describe the dragged module own registered footprint', async () => {
      await createCanvas();
      paint();

      // `markets-premium` is registered 7x5 in this fixture, so it disagrees with
      // the engine default on BOTH axes - which is what makes the assertion about
      // the registry rather than about one lucky number.
      component.onCatalogDragStart(DashboardModuleType.MARKETS_PREMIUM);

      expect(readPreviewFootprint()).toEqual({ cols: 7, rows: 5 });
    });

    it('should re-issue the configuration as a new object rather than writing into it', async () => {
      await createCanvas();
      paint();

      const before = component.options;

      component.onCatalogDragStart(DashboardModuleType.MARKETS_PREMIUM);

      // Identity is the mechanism, not an implementation detail. The engine takes
      // its configuration as a required signal input and derives what it reads
      // through a `computed` over it, so a mutation in place would change nothing
      // the engine ever consults again and the indicator would stay 4x4.
      expect(component.options).not.toBe(before);
    });

    it('should carry the engine own bookkeeping across the swap', async () => {
      await createCanvas();
      paint();

      // Everything the configuration factory put there has to survive, because
      // the engine writes its own runtime state onto the very object it was
      // handed. Rebuilding a fresh configuration instead would silently discard it.
      const before = component.options;

      component.onCatalogDragStart(DashboardModuleType.MARKETS_PREMIUM);

      expect(component.options.itemChangeCallback).toBe(
        before.itemChangeCallback
      );
      expect(component.options.emptyCellDropCallback).toBe(
        before.emptyCellDropCallback
      );
      expect(component.options.itemValidateCallback).toBe(
        before.itemValidateCallback
      );
      expect(component.options.minCols).toBe(12);
      expect(component.options.maxCols).toBe(12);
      expect(component.options.mobileBreakpoint).toBe(0);
      expect(component.options.enableEmptyCellDrop).toBe(true);

      // The per-item ceilings belong in this list too. The swap raises the drop
      // preview's default footprint and must touch nothing else; were it to drop
      // these, the engine would fall back to its own 50 and start refusing tall
      // modules for the duration of a catalog drag.
      expect(component.options.maxItemCols).toBe(GRID_COLUMNS);
      expect(component.options.maxItemRows).toBe(GRID_ROWS);
    });

    /**
     * The notice laid over an empty grid must stop intercepting the drag.
     *
     * It is `pointer-events: none` with each of its controls taking pointers back,
     * and those controls sit in the centre of the card - which is the middle of the
     * empty canvas and exactly where a row gets dropped. So the very controls that
     * have to answer a click were taking the `dragover` and `drop` the grid needed,
     * and on a first visit that is the whole of drag-to-add failing in silence.
     */
    it('should stop the empty-canvas notice intercepting a drag', async () => {
      await createCanvas({ layout: of(null) });
      paint();

      expect(component.isCatalogDragInProgress).toBe(false);

      component.onCatalogDragStart(DashboardModuleType.MARKETS_PREMIUM);
      paint();

      expect(component.isCatalogDragInProgress).toBe(true);

      component.onCatalogDragEnd();
      paint();

      expect(component.isCatalogDragInProgress).toBe(false);
    });

    /**
     * Raised BEFORE the registry is consulted. A type this build cannot size a
     * preview for still has to be droppable, so releasing the notice must not sit
     * behind a lookup that returns nothing.
     */
    it('should release the notice even for a module it cannot size', async () => {
      await createCanvas({ layout: of(null) });
      paint();

      component.onCatalogDragStart(
        'legacy-unknown-module' as DashboardModuleType
      );

      expect(component.isCatalogDragInProgress).toBe(true);
    });

    it('should hand the drag state to the notice that has to yield to it', async () => {
      await createCanvas({ layout: of(null) });
      paint();

      const notice = () => {
        return fixture.debugElement.query(
          By.directive(GfEmptyCanvasStateComponent)
        );
      };

      expect(notice()).toBeTruthy();
      expect(notice().componentInstance.isDragInProgress()).toBe(false);

      component.onCatalogDragStart(DashboardModuleType.MARKETS_PREMIUM);
      paint();

      // Through the binding rather than the flag, because the flag alone would go
      // on passing if the template were never wired to it.
      expect(notice().componentInstance.isDragInProgress()).toBe(true);

      component.onCatalogDragEnd();
      paint();

      expect(notice().componentInstance.isDragInProgress()).toBe(false);
    });

    it('should return to the engine default when the drag ends', async () => {
      await createCanvas();
      paint();

      component.onCatalogDragStart(DashboardModuleType.MARKETS_PREMIUM);
      component.onCatalogDragEnd();

      expect(readPreviewFootprint()).toEqual({ cols: 4, rows: 4 });
    });

    it('should return to the default after a drag that dropped nothing', async () => {
      await createCanvas();
      paint();

      component.onCatalogDragStart(DashboardModuleType.MARKETS_PREMIUM);

      // A cancelled drag raises only the end event, and the restore has to happen
      // there or the NEXT module would be previewed at this one's size.
      component.onCatalogDragEnd();
      component.onCatalogDragStart(DashboardModuleType.HOLDINGS);

      expect(readPreviewFootprint()).toEqual({ cols: 6, rows: 4 });
    });

    it('should leave the default alone for a module type the registry does not know', async () => {
      await createCanvas();
      paint();

      component.onCatalogDragStart(
        'not-a-module' as unknown as DashboardModuleType
      );

      // There is no footprint to preview, so the engine's own default is the
      // honest answer - the same treatment a stale persisted entry gets.
      expect(readPreviewFootprint()).toEqual({ cols: 4, rows: 4 });
    });

    it('should report no layout change for a preview adjustment', async () => {
      await createCanvas({ layout: of(savedLayoutForPreview) });
      paint();

      const geometryBefore = placedGeometry();

      dashboardLayoutServiceMock.scheduleSave.mockClear();

      component.onCatalogDragStart(DashboardModuleType.MARKETS_PREMIUM);
      component.onCatalogDragEnd();

      // Nothing is created, moved, resized or removed, so none of the four
      // persistence callbacks can fire - a drag that is abandoned must cost
      // nothing at all.
      expect(placedGeometry()).toEqual(geometryBefore);
      expect(dashboardLayoutServiceMock.scheduleSave).not.toHaveBeenCalled();
      expect(dataServiceMock.patchUserDashboardLayout).not.toHaveBeenCalled();
    });

    it('should not place anything merely because a drag began', async () => {
      await createCanvas();
      paint();

      component.onCatalogDragStart(DashboardModuleType.MARKETS_PREMIUM);

      expect(component.modules).toEqual([]);
    });
  });

  describe('the reveal-module intent bus', () => {
    /**
     * Replaces the canvas's view query with hosts that record the focus request.
     *
     * Hand-built rather than read from the rendered stand-ins, and deliberately so:
     * this environment lays nothing out, so a real handle reports that focus did not
     * land and the canvas would be judged on a no-op it never made. Recording that
     * the request was made, and for which module, is the half of the contract that
     * belongs to the canvas.
     */
    const recordFocusRequests = () => {
      const requests: DashboardModuleType[] = [];
      const hosts = component.modules.map(({ moduleType }) => ({
        definition: component.getModuleDefinition(moduleType),
        focusDragHandle: jest.fn<boolean, []>(() => {
          requests.push(moduleType);

          return true;
        }),
        reload: jest.fn<void, []>()
      }));

      component.moduleHosts = {
        forEach: (aCallback: (host: (typeof hosts)[number]) => void) => {
          hosts.forEach(aCallback);
        },
        toArray: () => hosts
      } as unknown as typeof component.moduleHosts;

      return requests;
    };

    it('should place a module published on the bus', async () => {
      await createCanvas();
      paint();

      jest
        .spyOn(gridsterComponent(), 'getNextPossiblePosition')
        .mockReturnValue(true);

      revealModuleSubject.next(DashboardModuleType.MARKETS);
      paint();

      expect(renderedModuleTypes()).toEqual([DashboardModuleType.MARKETS]);
    });

    it('should reveal a module published on the bus that is already placed', async () => {
      await createCanvas({
        layout: of({
          modules: [{ cols: 5, moduleType: 'holdings', rows: 4, x: 0, y: 0 }],
          version: 1
        })
      });
      paint();

      revealModuleSubject.next(DashboardModuleType.HOLDINGS);

      expect(component.modules).toHaveLength(1);
      expect(scrollIntoViewMock).toHaveBeenCalledWith({
        behavior: 'smooth',
        block: 'nearest'
      });
    });

    /**
     * Where focus goes when a module the viewer asked for is already placed.
     *
     * Scrolling alone is not an answer, for two reasons that compound. The module
     * is often already fully in view, and `scrollIntoView` with `nearest` is by
     * definition a no-op when it is - so the request produces no observable effect
     * whatsoever. And the assistant that published it closes its own panel without
     * restoring focus, which was harmless while the same selection was a
     * navigation, because the router placed focus; on one canvas nothing navigates,
     * so focus is dropped to the document body and the only way back is to Tab from
     * the top of the application.
     */
    it('should hand focus to a module that was already placed', async () => {
      await createCanvas({
        layout: of({
          modules: [
            { cols: 5, moduleType: 'holdings', rows: 4, x: 0, y: 0 },
            { cols: 5, moduleType: 'markets', rows: 4, x: 5, y: 0 }
          ],
          version: 1
        })
      });
      paint();

      const requests = recordFocusRequests();

      revealModuleSubject.next(DashboardModuleType.MARKETS);

      // The module asked for, not the first one on the canvas: the hosts are matched
      // by module type rather than by position, because the grid owns the order of
      // its own children.
      expect(requests).toEqual([DashboardModuleType.MARKETS]);
      expect(component.modules).toHaveLength(2);
    });

    it('should not hand focus to a module it has just added', async () => {
      await createCanvas();
      paint();

      jest
        .spyOn(gridsterComponent(), 'getNextPossiblePosition')
        .mockReturnValue(true);

      const requests = recordFocusRequests();

      revealModuleSubject.next(DashboardModuleType.MARKETS);
      paint();

      // A fresh add is a different act from a reveal. The viewer is usually adding
      // from the catalog and often adding more than one, so taking focus out of the
      // panel and onto the canvas would cost them their place in the list after
      // every single row.
      expect(renderedModuleTypes()).toEqual([DashboardModuleType.MARKETS]);
      expect(requests).toEqual([]);
    });

    it('should ignore an unknown discriminator published on the bus', async () => {
      await createCanvas();
      paint();

      expect(() =>
        revealModuleSubject.next(DashboardModuleType.ACCOUNTS)
      ).not.toThrow();

      expect(component.modules).toEqual([]);
    });

    it('should ignore a gated module published on the bus', async () => {
      await createCanvas({ viewer: { id: 'viewer-1', permissions: [] } });
      paint();

      revealModuleSubject.next(DashboardModuleType.AI_CHAT);

      expect(component.modules).toEqual([]);
    });

    it('should ignore a gated module published before the viewer resolved', async () => {
      await createCanvas({ viewer: undefined, viewerRequest: EMPTY });
      paint();

      revealModuleSubject.next(DashboardModuleType.ADMIN_OVERVIEW);

      expect(component.modules).toEqual([]);
    });

    it('should not fault when revealing a module the grid has not drawn yet', async () => {
      await createCanvas();
      paint();

      jest
        .spyOn(gridsterComponent(), 'getNextPossiblePosition')
        .mockReturnValue(true);

      revealModuleSubject.next(DashboardModuleType.HOLDINGS);

      expect(() =>
        revealModuleSubject.next(DashboardModuleType.HOLDINGS)
      ).not.toThrow();

      expect(component.modules).toHaveLength(1);
      expect(scrollIntoViewMock).not.toHaveBeenCalled();
    });

    it('should not fault on an intent that arrives before the first paint', async () => {
      await createCanvas({
        layout: of({
          modules: [{ cols: 5, moduleType: 'holdings', rows: 4, x: 0, y: 0 }],
          version: 1
        })
      });

      expect(() =>
        revealModuleSubject.next(DashboardModuleType.HOLDINGS)
      ).not.toThrow();

      expect(component.modules).toHaveLength(1);
      expect(scrollIntoViewMock).not.toHaveBeenCalled();
      expect(dashboardLayoutServiceMock.scheduleSave).not.toHaveBeenCalled();
    });
  });

  describe('a stored arrangement that does not hold to the contract', () => {
    it.each([
      {
        description: 'a modules member that is not an array',
        layout: { modules: 'not-an-array', version: 1 }
      },
      {
        description: 'a version this build does not know',
        layout: {
          modules: [{ cols: 5, moduleType: 'holdings', rows: 4, x: 0, y: 0 }],
          version: 2
        }
      }
    ])(
      'should treat $description as an unreadable arrangement rather than an empty one',
      async ({ layout }) => {
        await createCanvas({
          layout: of(layout as unknown as UserDashboardLayout)
        });

        // Unscreened, both are walked straight into: the first throws while it is
        // iterated, inside the success handler of the read - the one place a
        // failure must not surface, because the canvas has already concluded the
        // read succeeded - and the second would let this build rewrite a document
        // a newer one wrote, in an older shape.
        //
        // The error state is the safe answer to both. It offers a retry and
        // permits no write at all, so the stored arrangement survives; reporting
        // it as empty would open the catalog as though this were a first visit and
        // the first module added afterwards would overwrite the very document that
        // could not be read.
        expect(component.hasLayoutError).toBe(true);
        expect(component.isInitialized).toBe(true);
        expect(component.isCatalogOpen).toBe(false);
        expect(component.modules).toEqual([]);

        paint();

        expect(queryElement('gf-empty-canvas-state')).toBeNull();
        expect(dashboardLayoutServiceMock.scheduleSave).not.toHaveBeenCalled();
      }
    );

    it('should grow a stored footprint that is smaller than its module declares', async () => {
      await createCanvas({
        // Both entries clear the grid-wide 2x2 floor and both are still below the
        // minimum their own module declares in the registry - three columns for the
        // markets module, four rows for the assistant. The engine enforces those
        // declared minimums for every resize and every drop, but it is never
        // consulted for an item that arrives already placed, so without normalizing
        // here a document written by hand would draw a module at a size no person
        // could have resized it to.
        layout: of({
          modules: [
            { cols: 2, moduleType: 'markets', rows: 3, x: 0, y: 0 },
            { cols: 5, moduleType: 'ai-chat', rows: 2, x: 4, y: 0 }
          ],
          version: 1
        }),
        viewer: { id: 'viewer-1', permissions: [permissions.readAiPrompt] }
      });
      paint();

      expect(component.modules).toHaveLength(2);

      const placed = new Map(
        component.modules.map((item) => [item.moduleType, item])
      );

      expect(placed.get(DashboardModuleType.MARKETS).cols).toBe(3);
      expect(placed.get(DashboardModuleType.MARKETS).rows).toBe(3);
      expect(placed.get(DashboardModuleType.AI_CHAT).cols).toBe(5);
      expect(placed.get(DashboardModuleType.AI_CHAT).rows).toBe(4);

      // The correction is not an edit. It is recorded as the arrangement last
      // reported, so it reaches the server only when the viewer next changes
      // something themselves.
      expect(dashboardLayoutServiceMock.scheduleSave).not.toHaveBeenCalled();
    });

    it('should fit a stored geometry that overflows the grid back inside it', async () => {
      await createCanvas({
        layout: of({
          modules: [{ cols: 20, moduleType: 'holdings', rows: 4, x: 9, y: -3 }],
          version: 1
        })
      });
      paint();

      const [item] = component.modules;

      expect(item.cols).toBe(12);
      expect(item.x).toBe(0);
      expect(item.y).toBe(0);
      expect(item.x + item.cols).toBeLessThanOrEqual(12);
      expect(dashboardLayoutServiceMock.scheduleSave).not.toHaveBeenCalled();
    });

    it('should drop a stored entry whose coordinates are not whole numbers', async () => {
      await createCanvas({
        layout: of({
          modules: [
            { cols: 4, moduleType: 'holdings', rows: 4, x: 0, y: 0 },
            {
              cols: 4,
              moduleType: 'markets',
              rows: Number.NaN,
              x: 0,
              y: 4
            } as never
          ],
          version: 1
        })
      });
      paint();

      // A coordinate that is not a whole number describes no cell, so there is
      // nothing to clamp it to. One unreadable entry costs its own module and
      // nothing else.
      expect(renderedModuleTypes()).toEqual([DashboardModuleType.HOLDINGS]);
      expect(component.hasLayoutError).toBe(false);
    });
  });

  describe('a failed read of the saved arrangement', () => {
    const restoredLayout: UserDashboardLayout = {
      modules: [{ cols: 5, moduleType: 'holdings', rows: 4, x: 0, y: 0 }],
      version: 1
    };

    it('should mark the canvas ready without opening the catalog', async () => {
      await createCanvas({
        layout: throwError(() => new Error('service unavailable'))
      });

      // A failed read is not an empty arrangement and must not be reported as one:
      // doing so would open the catalog as though this were a first visit, telling a
      // returning viewer their canvas is new when in fact it merely could not be
      // fetched.
      expect(component.hasLayoutError).toBe(true);
      expect(component.isInitialized).toBe(true);
      expect(component.hasLayoutError).toBe(true);
      expect(component.isCatalogOpen).toBe(false);

      paint();

      expect(queryElement('mat-sidenav.mat-drawer-opened')).toBeNull();
    });

    it('should offer a retry instead of the empty notice', async () => {
      await createCanvas({
        layout: throwError(() => new Error('service unavailable'))
      });
      paint();

      // The empty notice would invite the viewer to start building a dashboard they
      // already have, and the catalog trigger would let them do it - so neither is
      // drawn, and neither is the grid they would be dropped onto.
      expect(queryElement('gf-empty-canvas-state')).toBeNull();
      expect(queryElement('.gf-dashboard-catalog-trigger')).toBeNull();
      expect(queryElement('gridster')).toBeNull();
      expect(queryElement('[role="alert"]')).toBeTruthy();
    });

    it('should offer a retry and a way out, and nothing else', async () => {
      await createCanvas({
        layout: throwError(() => new Error('service unavailable'))
      });
      paint();

      const actions = queryElements('[role="alert"] button');

      // Two actions, and neither writes anything. A control that emptied the
      // arrangement and wrote the emptied one back would be a fifth persistence
      // trigger - a layout write may originate only from a grid state change, so
      // drag, resize, add and remove are the whole set - and it would be the only
      // affordance in the application able to destroy an arrangement the canvas has
      // never successfully read. Asking again is first because it is what recovers a
      // transient failure; abandoning the saved arrangement is offered beside it
      // because a document the server refuses outright fails the same way every
      // time, and without it the only remedies were signing out or waiting for an
      // operator.
      expect(actions).toHaveLength(2);
      expect(actions[0].textContent.trim()).toBe('Try again');
      expect(actions[1].textContent.trim()).toBe(
        'Start with a blank dashboard'
      );
    });

    it('should hand back an empty canvas when the saved arrangement is abandoned', async () => {
      await createCanvas({
        layout: throwError(() => new Error('service unavailable'))
      });
      paint();

      queryElements('[role="alert"] button')[1].click();
      paint();

      // The whole point of the affordance: the arrangement, the catalog and its
      // trigger are all reachable again, and the catalog is open for the same reason
      // a first visit opens it - an empty canvas with the panel shut offers nothing
      // to do.
      expect(component.hasLayoutError).toBe(false);
      expect(component.isInitialized).toBe(true);
      expect(component.isCatalogOpen).toBe(true);
      expect(component.modules).toHaveLength(0);
      expect(queryElement('[role="alert"]')).toBeNull();
      expect(queryElement('gridster')).toBeTruthy();
      expect(queryElement('gf-empty-canvas-state')).toBeTruthy();
      expect(queryElement('.gf-dashboard-catalog-trigger')).toBeTruthy();
      expect(queryElement('mat-sidenav.mat-drawer-opened')).toBeTruthy();
    });

    it('should write nothing when the saved arrangement is abandoned', async () => {
      await createCanvas({
        layout: throwError(() => new Error('service unavailable'))
      });
      paint();

      queryElements('[role="alert"] button')[1].click();
      paint();

      // Abandoning is not a write. The stored document - the one that could not be
      // read - survives untouched until the viewer places something, so nothing is
      // destroyed by pressing a control, and the read is not reissued either: the
      // viewer has said they are done asking.
      expect(dashboardLayoutServiceMock.scheduleSave).not.toHaveBeenCalled();
      expect(dashboardLayoutServiceMock.get).toHaveBeenCalledTimes(1);

      // Whatever was being held for retry belongs to the arrangement just left
      // behind, so it is given up rather than offered against the blank one.
      expect(
        dashboardLayoutServiceMock.discardFailedSave
      ).toHaveBeenCalledTimes(1);
    });

    it('should persist the first module placed on the abandoned canvas', async () => {
      await createCanvas({
        layout: throwError(() => new Error('service unavailable'))
      });
      paint();

      queryElements('[role="alert"] button')[1].click();
      paint();

      jest
        .spyOn(gridsterComponent(), 'getNextPossiblePosition')
        .mockReturnValue(true);

      component.onAddModule(DashboardModuleType.HOLDINGS);
      paint();

      expect(renderedModuleTypes()).toEqual([DashboardModuleType.HOLDINGS]);

      // Announced through the engine's own init callback, as everywhere else in
      // this suite: gridster raises none of its callbacks in this environment, so
      // the cell's initialization is delivered through the very configuration the
      // canvas handed it.
      component.options.itemInitCallback(
        component.modules[0],
        gridsterItemComponents()[0]
      );

      // This is what replaces the unreadable document, and it is an ordinary grid
      // state change reaching the one write path rather than anything the recovery
      // control did - which is precisely why the destruction is the viewer's own
      // deliberate act.
      expect(dashboardLayoutServiceMock.scheduleSave).toHaveBeenCalledTimes(1);

      const [, reported] =
        dashboardLayoutServiceMock.scheduleSave.mock.calls.at(-1);

      expect(reported.map(({ moduleType }) => moduleType)).toEqual([
        DashboardModuleType.HOLDINGS
      ]);
    });

    it('should refuse to place a module over an arrangement it could not read', async () => {
      await createCanvas({
        layout: throwError(() => new Error('service unavailable'))
      });
      paint();

      component.onAddModule(DashboardModuleType.PORTFOLIO_OVERVIEW);
      revealModuleSubject.next(DashboardModuleType.HOLDINGS);
      dropOnEmptyCell(DashboardModuleType.MARKETS, { x: 0, y: 0 });

      // The array is empty because the read failed, not because the viewer has
      // nothing placed. Appending here would make the next write claim that one
      // module is their entire dashboard and erase everything that could not be
      // fetched.
      expect(component.modules).toHaveLength(0);
      expect(dashboardLayoutServiceMock.scheduleSave).not.toHaveBeenCalled();
    });

    it('should read the arrangement again when the failure is retried', async () => {
      await createCanvas({
        layout: throwError(() => new Error('service unavailable'))
      });
      paint();

      expect(dashboardLayoutServiceMock.get).toHaveBeenCalledTimes(1);

      dashboardLayoutServiceMock.get.mockReturnValue(of(restoredLayout));

      component.onRetryLayout();
      paint();

      // Bypassing the cache is required: the layout store caches on its slice being
      // defined, so a retry that accepted the cache would be answered by the very
      // failure it is retrying.
      expect(dashboardLayoutServiceMock.get).toHaveBeenCalledTimes(2);
      expect(dashboardLayoutServiceMock.get).toHaveBeenLastCalledWith(true);
      expect(component.hasLayoutError).toBe(false);
      expect(component.modules).toHaveLength(1);
      expect(queryElement('gridster')).toBeTruthy();
    });

    it('should report no layout change after a failed read', async () => {
      await createCanvas({
        layout: throwError(() => new Error('service unavailable'))
      });
      paint();

      expect(dashboardLayoutServiceMock.scheduleSave).not.toHaveBeenCalled();
    });

    it('should ask again when the failure notice offers a second attempt', async () => {
      await createCanvas({
        layout: throwError(() => new Error('service unavailable'))
      });
      paint();

      expect(dashboardLayoutServiceMock.get).toHaveBeenCalledTimes(1);

      dashboardLayoutServiceMock.get.mockReturnValue(
        of({
          modules: [{ cols: 5, moduleType: 'holdings', rows: 4, x: 0, y: 0 }],
          version: 1
        })
      );

      component.onRetryLayout();
      paint();

      // The second attempt forces past the cache, so it genuinely re-requests
      // rather than being served the failure again, and a success replaces the
      // notice with the arrangement it could not reach the first time.
      expect(dashboardLayoutServiceMock.get).toHaveBeenCalledTimes(2);
      expect(dashboardLayoutServiceMock.get).toHaveBeenLastCalledWith(true);
      expect(component.hasLayoutError).toBe(false);
      expect(renderedModuleTypes()).toEqual([DashboardModuleType.HOLDINGS]);
    });
  });

  describe('a stored arrangement this build cannot interpret', () => {
    // The one status that says the document itself is the problem, as opposed to the
    // request having failed to land. A real `HttpErrorResponse` rather than a plain
    // object carrying a status, because that is exactly the distinction the canvas
    // narrows on.
    const unreadableLayout = () =>
      throwError(
        () =>
          new HttpErrorResponse({
            status: StatusCodes.CONFLICT,
            statusText: 'Conflict',
            url: '/api/v1/user/layout'
          })
      );

    it('should tell an uninterpretable document apart from a request that did not land', async () => {
      await createCanvas({ layout: unreadableLayout() });

      // Both are read failures and both refuse writes, but their recoveries are
      // opposites: one is worth asking about again, the other will answer the same
      // way every time. Without the distinction the viewer is left pressing a
      // control that provably cannot succeed.
      expect(component.hasLayoutError).toBe(true);
      expect(component.isLayoutUnreadable).toBe(true);
      expect(component.isInitialized).toBe(true);
      expect(component.isCatalogOpen).toBe(false);
    });

    it('should treat a request that did not land as retryable rather than as an unreadable document', async () => {
      await createCanvas({
        layout: throwError(() => new Error('service unavailable'))
      });

      expect(component.hasLayoutError).toBe(true);
      expect(component.isLayoutUnreadable).toBe(false);
    });

    it('should not mistake a status carried on a plain object for an uninterpretable document', async () => {
      await createCanvas({
        layout: throwError(() => ({ status: StatusCodes.CONFLICT }))
      });

      expect(component.hasLayoutError).toBe(true);
      expect(component.isLayoutUnreadable).toBe(false);
    });

    it('should say what is wrong rather than asking the viewer to try later', async () => {
      await createCanvas({ layout: unreadableLayout() });
      paint();

      const notice = queryElement('[role="alert"]');

      expect(notice.textContent).toContain(
        'Your saved dashboard cannot be read by this version of Ghostfolio.'
      );
      expect(notice.textContent).not.toContain('Please try again later.');
    });

    it('should offer a way out beside the retry', async () => {
      await createCanvas({ layout: unreadableLayout() });
      paint();

      const actions = queryElements('[role="alert"] button');

      // Asking again stays first, because it costs nothing. The discard beside it is
      // what makes the account recoverable at all: while an uninterpretable document
      // is stored the canvas refuses every write, so without this the dashboard
      // cannot be reached again from the UI.
      expect(actions).toHaveLength(2);
      expect(actions.map((action) => action.textContent.trim())).toEqual([
        'Try again',
        'Start over with a blank dashboard'
      ]);
    });

    it('should label the way out for what it does', async () => {
      await createCanvas({ layout: unreadableLayout() });
      paint();

      const actions = queryElements('[role="alert"] button');

      // Named for its outcome rather than its mechanism. "Reset", "Clear" or "Fix"
      // would each leave the viewer guessing which of their two dashboards - the
      // stored one and the empty one in front of them - survives.
      expect(actions[1].textContent.trim()).toBe(
        'Start over with a blank dashboard'
      );
    });

    it('should ask before destroying the stored arrangement', async () => {
      confirmsAutomatically = false;

      await createCanvas({ layout: unreadableLayout() });

      component.onDiscardLayout();

      // The document being destroyed may be perfectly good and merely newer than
      // this build, and the viewer is the only one who can weigh that - so the
      // confirmation states the consequence and that it is permanent, rather than
      // asking whether they are sure.
      expect(notificationServiceMock.confirm).toHaveBeenCalledTimes(1);
      expect(confirmParams.title).toBe('Start over with a blank dashboard?');
      expect(confirmParams.message).toContain('permanently deleted');
      expect(confirmParams.message).toContain('cannot be undone');
      expect(confirmParams.confirmLabel).toBe('Discard');
      expect(confirmParams.confirmType).toBe('warn');
      expect(dashboardLayoutServiceMock.discard).not.toHaveBeenCalled();
    });

    it('should leave the stored arrangement alone when the viewer declines', async () => {
      confirmsAutomatically = false;

      await createCanvas({ layout: unreadableLayout() });

      component.onDiscardLayout();
      paint();

      expect(dashboardLayoutServiceMock.discard).not.toHaveBeenCalled();
      expect(component.hasLayoutError).toBe(true);
      expect(component.isLayoutUnreadable).toBe(true);
      expect(queryElement('[role="alert"]')).toBeTruthy();
    });

    it('should discard exactly once when the viewer confirms', async () => {
      await createCanvas({ layout: unreadableLayout() });

      component.onDiscardLayout();

      expect(dashboardLayoutServiceMock.discard).toHaveBeenCalledTimes(1);
    });

    it('should not write an arrangement while recovering from one it never read', async () => {
      await createCanvas({ layout: unreadableLayout() });

      component.onDiscardLayout();
      await paintAndSettle();

      // The whole reason the recovery is a delete: a control that emptied the
      // arrangement and saved the emptied one back would be a fifth persistence
      // trigger, and it would be the only affordance in the application able to
      // overwrite a document the canvas has never successfully read.
      expect(dashboardLayoutServiceMock.scheduleSave).not.toHaveBeenCalled();
      expect(dataServiceMock.patchUserDashboardLayout).not.toHaveBeenCalled();
    });

    it('should hand the viewer a blank canvas with the catalog open once the discard lands', async () => {
      await createCanvas({ layout: unreadableLayout() });

      component.onDiscardLayout();
      paint();

      // Exactly the first-visit state, because that is what the account is now in.
      expect(component.hasLayoutError).toBe(false);
      expect(component.isLayoutUnreadable).toBe(false);
      expect(component.isDiscardingLayout).toBe(false);
      expect(component.isInitialized).toBe(true);
      expect(component.isCatalogOpen).toBe(true);
      expect(component.modules).toHaveLength(0);
      expect(queryElement('[role="alert"]')).toBeNull();
      expect(queryElement('gridster')).toBeTruthy();
      expect(queryElement('gf-empty-canvas-state')).toBeTruthy();
    });

    it('should keep owning the same array across a discard', async () => {
      await createCanvas({ layout: unreadableLayout() });

      const owned = component.modules;

      component.onDiscardLayout();

      // Emptied in place rather than replaced. The array the grid engine holds is the
      // array the canvas owns, and handing it a new one would leave the engine
      // mutating an array nothing reads.
      expect(component.modules).toBe(owned);
      expect(component.modules).toHaveLength(0);
    });

    it('should leave the viewer where they were when the discard fails', async () => {
      discardResponse = throwError(() => new Error('service unavailable'));

      await createCanvas({ layout: unreadableLayout() });

      component.onDiscardLayout();
      paint();

      // Nothing was destroyed, so nothing may look as though it was: the notice and
      // its two actions stay, and the control is usable again rather than left
      // spinning.
      expect(component.hasLayoutError).toBe(true);
      expect(component.isLayoutUnreadable).toBe(true);
      expect(component.isDiscardingLayout).toBe(false);
      expect(component.isCatalogOpen).toBe(false);
      expect(queryElement('[role="alert"]')).toBeTruthy();
      expect(queryElements('[role="alert"] button')).toHaveLength(2);
      expect(notificationServiceMock.alert).toHaveBeenCalledTimes(1);
    });

    it('should not ask a second time while a discard is still running', async () => {
      discardResponse = EMPTY;

      await createCanvas({ layout: unreadableLayout() });

      component.onDiscardLayout();
      component.onDiscardLayout();

      // `EMPTY` never completes the subscription's `next`, so the canvas is left
      // mid-discard - which is precisely the state a second press must not restart.
      expect(component.isDiscardingLayout).toBe(true);
      expect(notificationServiceMock.confirm).toHaveBeenCalledTimes(1);
      expect(dashboardLayoutServiceMock.discard).toHaveBeenCalledTimes(1);
    });

    it('should mark the running discard as busy rather than only disabling it', async () => {
      discardResponse = EMPTY;

      await createCanvas({ layout: unreadableLayout() });

      component.onDiscardLayout();
      paint();

      const discardAction = queryElements('[role="alert"] button')[1];

      // Disabled alone would drop the control out of the tab order and take its name
      // with it, leaving a viewer who cannot see the spinner with nothing at all - so
      // it is announced as busy AND as disabled, while the native attribute stays off
      // so focus can still reach it and read it.
      expect(discardAction.getAttribute('aria-busy')).toBe('true');
      expect(discardAction.getAttribute('aria-disabled')).toBe('true');
      expect(discardAction.hasAttribute('disabled')).toBe(false);
    });

    it('should clear the unreadable state when the viewer asks again instead', async () => {
      await createCanvas({ layout: unreadableLayout() });

      dashboardLayoutServiceMock.get.mockReturnValue(
        of({
          modules: [{ cols: 5, moduleType: 'holdings', rows: 4, x: 0, y: 0 }],
          version: 1
        })
      );

      component.onRetryLayout();
      paint();

      expect(component.hasLayoutError).toBe(false);
      expect(component.isLayoutUnreadable).toBe(false);
      expect(renderedModuleTypes()).toEqual([DashboardModuleType.HOLDINGS]);
    });

    it('should offer the way out on a canvas that hydrated but cannot draw everything it holds', async () => {
      await createCanvas({
        layout: of({
          modules: [
            {
              cols: 4,
              moduleType: 'a-module-a-newer-build-named',
              rows: 4,
              x: 0,
              y: 0
            }
          ],
          version: 1
        })
      });
      paint();

      // Read perfectly well, so there is no error notice - but nothing can be drawn
      // and the entries are retained rather than dropped, so the viewer would be
      // looking at an empty canvas that silently refuses to forget a dashboard they
      // cannot see. The discard is the only thing that resolves that.
      expect(component.hasLayoutError).toBe(false);
      expect(component.hasUnrenderableModules).toBe(true);
      expect(component.modules).toHaveLength(0);
      expect(queryElement('gf-empty-canvas-state')).toBeTruthy();
    });

    it('should not offer the way out on a genuinely empty canvas', async () => {
      await createCanvas({ layout: of(null) });
      paint();

      expect(component.hasUnrenderableModules).toBe(false);
    });

    it('should not offer the way out for an arrangement it can draw', async () => {
      await createCanvas({
        layout: of({
          modules: [{ cols: 5, moduleType: 'holdings', rows: 4, x: 0, y: 0 }],
          version: 1
        })
      });

      expect(component.hasUnrenderableModules).toBe(false);
    });
  });

  describe('an arrangement changed by another client of the same account', () => {
    const placedLayout: UserDashboardLayout = {
      modules: [{ cols: 5, moduleType: 'holdings', rows: 4, x: 0, y: 0 }],
      version: 1
    };

    it('should say so, and offer the only two answers there are', async () => {
      await createCanvas({ layout: of(placedLayout) });

      conflictSubject.next(true);
      paint();

      const notice = queryElement('[role="status"]');

      // Politely rather than as an alert: nothing is broken and what the viewer is
      // looking at is still theirs, it is only no longer the newest. Taking the newer
      // document and keeping this one are genuinely the whole set - a merge would
      // need to adjudicate differences only the viewer can.
      expect(component.hasConflict).toBe(true);
      expect(notice.textContent).toContain(
        'Your dashboard was changed in another tab.'
      );
      expect(
        queryElements('[role="status"] button').map((action) =>
          action.textContent.trim()
        )
      ).toEqual(['Load the newer dashboard', 'Keep this arrangement']);
    });

    it('should keep drawing the arrangement the viewer is looking at', async () => {
      await createCanvas({ layout: of(placedLayout) });

      conflictSubject.next(true);
      paint();

      // The refused write changed nothing on screen, and hiding the canvas behind the
      // notice would discard the arrangement before the viewer has chosen to.
      expect(queryElement('gridster')).toBeTruthy();
      expect(renderedModuleTypes()).toEqual([DashboardModuleType.HOLDINGS]);
    });

    it('should re-read the newer arrangement when the viewer takes it', async () => {
      await createCanvas({ layout: of(placedLayout) });

      conflictSubject.next(true);

      dashboardLayoutServiceMock.get.mockReturnValue(
        of({
          modules: [{ cols: 6, moduleType: 'markets', rows: 4, x: 0, y: 0 }],
          version: 1
        })
      );

      component.onReloadLayoutAfterConflict();
      paint();

      // The retained snapshot is dropped first, so nothing later flushes the
      // arrangement just abandoned - and the read forces past the cache, so it is
      // genuinely the newer document rather than the one already held.
      expect(dashboardLayoutServiceMock.dismissConflict).toHaveBeenCalledTimes(
        1
      );
      expect(dashboardLayoutServiceMock.get).toHaveBeenLastCalledWith(true);
      expect(component.hasConflict).toBe(false);
      expect(renderedModuleTypes()).toEqual([DashboardModuleType.MARKETS]);
    });

    it('should not report a layout change while taking the newer arrangement', async () => {
      await createCanvas({ layout: of(placedLayout) });

      conflictSubject.next(true);

      dashboardLayoutServiceMock.get.mockReturnValue(
        of({
          modules: [{ cols: 6, moduleType: 'markets', rows: 4, x: 0, y: 0 }],
          version: 1
        })
      );

      component.onReloadLayoutAfterConflict();
      await paintAndSettle();

      // Hydration is not a viewer intent. Reporting one here would write the newer
      // document straight back and make taking it indistinguishable from overwriting
      // it.
      expect(dashboardLayoutServiceMock.scheduleSave).not.toHaveBeenCalled();
    });

    it('should hand the arrangement on screen back to the service when the viewer keeps it', async () => {
      await createCanvas({ layout: of(placedLayout) });

      conflictSubject.next(true);

      component.onOverwriteLayoutAfterConflict();

      // Neither rebuilt nor re-projected: the snapshot the service is already holding
      // is the one the viewer is looking at, and building a second one here would
      // give two answers to what a single array is.
      expect(
        dashboardLayoutServiceMock.overwriteAfterConflict
      ).toHaveBeenCalledTimes(1);
      expect(dashboardLayoutServiceMock.scheduleSave).not.toHaveBeenCalled();
      expect(dashboardLayoutServiceMock.get).toHaveBeenCalledTimes(1);
    });

    it('should drop the notice once the service reports the conflict resolved', async () => {
      await createCanvas({ layout: of(placedLayout) });

      conflictSubject.next(true);
      paint();

      expect(queryElement('[role="status"]')).toBeTruthy();

      conflictSubject.next(false);
      paint();

      expect(component.hasConflict).toBe(false);
      expect(
        queryElements('[role="status"]').filter((notice) =>
          notice.textContent.includes('changed in another tab')
        )
      ).toHaveLength(0);
    });

    it('should draw no notice while there is no conflict', async () => {
      await createCanvas({ layout: of(placedLayout) });
      paint();

      expect(component.hasConflict).toBe(false);
      expect(
        queryElements('[role="status"]').filter((notice) =>
          notice.textContent.includes('changed in another tab')
        )
      ).toHaveLength(0);
    });
  });

  describe('a failed write of the saved arrangement', () => {
    const placedLayout: UserDashboardLayout = {
      modules: [{ cols: 5, moduleType: 'holdings', rows: 4, x: 0, y: 0 }],
      version: 1
    };

    it('should tell the viewer their arrangement is unsaved', async () => {
      await createCanvas({ layout: of(placedLayout) });
      paint();

      /**
       * The visible notice, and only that one. The canvas also carries a permanent
       * off-screen status region for announcing keyboard move and resize outcomes,
       * so a bare role selector would match that instead and report a notice that
       * is not on screen.
       */
      const unsavedNotice = () => queryElement('[role="status"]:not(.sr-only)');

      expect(unsavedNotice()).toBeNull();

      saveErrorSubject.next(true);
      paint();

      // Announced politely rather than as an alert: nothing the viewer is doing is
      // interrupted and what they see is still correct - it is only unsaved.
      expect(component.hasSaveError).toBe(true);
      expect(unsavedNotice()).toBeTruthy();

      saveErrorSubject.next(false);
      paint();

      expect(unsavedNotice()).toBeNull();
    });

    it('should hand the retry back to the layout service', async () => {
      await createCanvas({ layout: of(placedLayout) });
      paint();

      component.onRetrySave();

      // A bare delegation, deliberately. The service still holds the snapshot whose
      // write failed and re-enters its own debounced subject with it, so retrying
      // adds no second origin for a layout write.
      expect(dashboardLayoutServiceMock.retryFailedSave).toHaveBeenCalledTimes(
        1
      );
      expect(dataServiceMock.patchUserDashboardLayout).not.toHaveBeenCalled();
    });

    it('should let the viewer take the stored arrangement back instead', async () => {
      await createCanvas({ layout: of(placedLayout) });
      paint();

      saveErrorSubject.next(true);
      paint();

      expect(component.hasSaveError).toBe(true);

      // What the server actually holds, which is what the canvas has to end up
      // showing: the arrangement on screen is the one that could not be stored.
      dashboardLayoutServiceMock.get.mockReturnValue(
        of({
          modules: [{ cols: 6, moduleType: 'markets', rows: 4, x: 0, y: 0 }],
          version: 1
        })
      );

      component.onDiscardFailedSave();
      await paintAndSettle();

      // The retained snapshot goes first, because nothing may be left able to flush
      // the arrangement the viewer has just abandoned.
      expect(
        dashboardLayoutServiceMock.discardFailedSave
      ).toHaveBeenCalledTimes(1);
      expect(dashboardLayoutServiceMock.retryFailedSave).not.toHaveBeenCalled();

      // Forced, not served from the cache: the whole purpose is to end up agreeing
      // with the server rather than with this client's own last idea of it.
      expect(dashboardLayoutServiceMock.get).toHaveBeenLastCalledWith(true);

      expect(component.hasSaveError).toBe(false);
      expect(renderedModuleTypes()).toEqual([DashboardModuleType.MARKETS]);
    });

    it('should write nothing while taking the stored arrangement back', async () => {
      await createCanvas({ layout: of(placedLayout) });
      paint();

      saveErrorSubject.next(true);
      paint();

      dashboardLayoutServiceMock.scheduleSave.mockClear();

      component.onDiscardFailedSave();
      await paintAndSettle();

      // Emptying the grid destroys every cell, and each destruction reaches the
      // item-removed callback. Those are teardown rather than intent, so a recovery
      // that wrote would be the one origin able to destroy a document on the way to
      // reading it.
      expect(dashboardLayoutServiceMock.scheduleSave).not.toHaveBeenCalled();
    });
  });

  describe('a second viewer resolving into the same canvas', () => {
    it('should read the arrangement again, bypassing the cache', async () => {
      await createCanvas();
      paint();

      expect(dashboardLayoutServiceMock.get).toHaveBeenCalledTimes(1);

      dashboardLayoutServiceMock.get.mockReturnValue(
        of({
          modules: [{ cols: 5, moduleType: 'holdings', rows: 4, x: 0, y: 0 }],
          version: 1
        })
      );

      userServiceMock.stateChanged.next({
        user: { id: 'viewer-2', permissions: [] }
      });

      expect(dashboardLayoutServiceMock.get).toHaveBeenCalledTimes(2);
      expect(dashboardLayoutServiceMock.get).toHaveBeenLastCalledWith(true);
    });

    it('should hydrate the newly resolved viewer arrangement', async () => {
      await createCanvas();
      paint();

      dashboardLayoutServiceMock.get.mockReturnValue(
        of({
          modules: [{ cols: 5, moduleType: 'holdings', rows: 4, x: 0, y: 0 }],
          version: 1
        })
      );

      userServiceMock.stateChanged.next({
        user: { id: 'viewer-2', permissions: [] }
      });
      paint();

      expect(renderedModuleTypes()).toEqual([DashboardModuleType.HOLDINGS]);
      expect(component.isCatalogOpen).toBe(true);
    });

    it('should survive a store emission that carries no state at all', async () => {
      await createCanvas();
      paint();

      expect(() => userServiceMock.stateChanged.next(null)).not.toThrow();

      expect(component.isSignedOut).toBe(false);
      expect(component.isInitialized).toBe(true);
      expect(dashboardLayoutServiceMock.get).toHaveBeenCalledTimes(1);
    });

    it('should not read the arrangement again for another emission about the same viewer', async () => {
      await createCanvas();
      paint();

      userServiceMock.stateChanged.next({ user: signedInViewer });
      userServiceMock.stateChanged.next({ user: { ...signedInViewer } });

      expect(dashboardLayoutServiceMock.get).toHaveBeenCalledTimes(1);
    });

    it('should take the previous viewer arrangement down before the next one is read', async () => {
      await createCanvas({
        layout: of({
          modules: [{ cols: 5, moduleType: 'holdings', rows: 4, x: 0, y: 0 }],
          version: 1
        })
      });
      paint();

      expect(renderedModuleTypes()).toEqual([DashboardModuleType.HOLDINGS]);

      // A read that never answers, so the canvas is observed mid-transition.
      dashboardLayoutServiceMock.get.mockReturnValue(EMPTY);

      userServiceMock.stateChanged.next({
        user: { id: 'viewer-2', permissions: [] }
      });
      paint();

      // Leaving the outgoing viewer's modules up would show one account's
      // arrangement to another, and - because the grid reports the reflow that
      // follows - would give the incoming viewer's first write a chance to carry
      // modules that were never theirs.
      expect(component.isInitialized).toBe(false);
      expect(component.modules).toHaveLength(0);
      expect(renderedModuleTypes()).toEqual([]);
      expect(dashboardLayoutServiceMock.scheduleSave).not.toHaveBeenCalled();
    });

    it('should apply only the newest arrangement when two reads overlap', async () => {
      const firstViewerLayout = new Subject<UserDashboardLayout>();

      await createCanvas({ layout: firstViewerLayout.asObservable() });
      paint();

      dashboardLayoutServiceMock.get.mockReturnValue(
        of({
          modules: [{ cols: 4, moduleType: 'markets', rows: 4, x: 0, y: 0 }],
          version: 1
        })
      );

      userServiceMock.stateChanged.next({
        user: { id: 'viewer-2', permissions: [] }
      });
      paint();

      expect(renderedModuleTypes()).toEqual([DashboardModuleType.MARKETS]);

      // The first viewer's read finally answers, out of order. Its response belongs to
      // a viewer who is no longer on screen, so applying it would replace the present
      // viewer's arrangement with somebody else's.
      firstViewerLayout.next({
        modules: [{ cols: 5, moduleType: 'holdings', rows: 4, x: 0, y: 0 }],
        version: 1
      });
      paint();

      expect(renderedModuleTypes()).toEqual([DashboardModuleType.MARKETS]);
    });

    it('should stop drawing a module whose permission the same viewer has lost', async () => {
      await createCanvas({
        layout: of({
          modules: [
            { cols: 4, moduleType: 'admin-overview', rows: 4, x: 0, y: 0 },
            { cols: 4, moduleType: 'holdings', rows: 4, x: 4, y: 0 }
          ],
          version: 1
        }),
        viewer: {
          id: 'viewer-1',
          permissions: [permissions.accessAdminControl]
        }
      });
      paint();

      expect(renderedModuleTypes()).toEqual([
        DashboardModuleType.ADMIN_OVERVIEW,
        DashboardModuleType.HOLDINGS
      ]);

      // The same account, re-read with the permission withdrawn. Permissions travel
      // with that record, so an administrator whose access is revoked keeps their
      // identity - and without re-measuring what is placed, their canvas would carry
      // on drawing administrative modules until the page was reloaded.
      userServiceMock.stateChanged.next({
        user: { id: 'viewer-1', permissions: [] }
      });
      paint();

      expect(renderedModuleTypes()).toEqual([DashboardModuleType.HOLDINGS]);
      expect(component.modules).toHaveLength(1);
      expect(dashboardLayoutServiceMock.get).toHaveBeenCalledTimes(1);
    });

    it('should not persist the removal of a module the viewer may no longer see', async () => {
      await createCanvas({
        layout: of({
          modules: [
            { cols: 4, moduleType: 'admin-overview', rows: 4, x: 0, y: 0 },
            { cols: 4, moduleType: 'holdings', rows: 4, x: 4, y: 0 }
          ],
          version: 1
        }),
        viewer: {
          id: 'viewer-1',
          permissions: [permissions.accessAdminControl]
        }
      });
      paint();

      userServiceMock.stateChanged.next({
        user: { id: 'viewer-1', permissions: [] }
      });
      paint();

      const [itemComponent] = gridsterItemComponents();

      // The grid destroys the cell and fires its item-removed callback as a
      // consequence, so the suppression has to survive that too.
      component.options.itemRemovedCallback(
        component.modules[0],
        itemComponent
      );

      // This is the canvas correcting what it is ALLOWED to draw, not the viewer
      // editing their arrangement. Writing it out would delete a module they may be
      // entitled to again tomorrow.
      expect(dashboardLayoutServiceMock.scheduleSave).not.toHaveBeenCalled();
    });
  });

  /**
   * The identity barrier.
   *
   * A bearer token can be replaced while this canvas is on screen - by creating an
   * account, by signing in with a security token, by signing out - and on a single
   * route nothing navigates away when it is. Without a barrier the previous
   * viewer's modules stay mounted and their pending arrangement stays schedulable
   * while the new account's token is the one authorising requests, which writes one
   * viewer's layout to another's account. None of that is visible in a request
   * body, so these assertions are the only guard.
   */
  describe('an identity transition', () => {
    /** One saved module, so "what the previous viewer had" is observable. */
    const singleModuleLayout: UserDashboardLayout = {
      modules: [{ cols: 5, moduleType: 'holdings', rows: 4, x: 0, y: 0 }],
      version: 1
    };

    it('should stamp every reported arrangement with the viewer it belongs to', async () => {
      await createCanvas({ layout: of(singleModuleLayout) });
      await paintAndSettle();

      const [itemComponent] = gridsterItemComponents();

      // A genuine move: the engine writes the committed coordinates onto the
      // object inside the array and only then raises its callback. Raising it
      // without one reports nothing, because a callback that carries no change is
      // how drawing a saved arrangement announces itself.
      component.modules[0].x = 3;

      component.options.itemChangeCallback(component.modules[0], itemComponent);

      // The identity has to travel with the snapshot, because the write happens
      // after a debounce and the layout service cannot ask the canvas afterwards
      // whose arrangement it was.
      expect(dashboardLayoutServiceMock.scheduleSave).toHaveBeenCalledWith(
        signedInViewer.id,
        [
          {
            cols: singleModuleLayout.modules[0].cols,
            moduleType: DashboardModuleType.HOLDINGS,
            rows: singleModuleLayout.modules[0].rows,
            x: 3,
            y: singleModuleLayout.modules[0].y
          }
        ]
      );
    });

    it('should authorise writes for the viewer it adopts', async () => {
      await createCanvas({ layout: of(singleModuleLayout) });
      paint();

      expect(dashboardLayoutServiceMock.adoptIdentity).toHaveBeenCalledWith(
        signedInViewer.id
      );
    });

    it('should invalidate the previous arrangement before adopting a different viewer', async () => {
      await createCanvas({ layout: of(singleModuleLayout) });
      paint();

      expect(renderedModuleTypes()).toEqual([DashboardModuleType.HOLDINGS]);

      const [itemComponent] = gridsterItemComponents();
      const previousItem = component.modules[0];

      // The second viewer's arrangement never arrives, so the canvas is observed
      // exactly in the interval the barrier exists to protect.
      dashboardLayoutServiceMock.get.mockReturnValue(EMPTY);

      userServiceMock.stateChanged.next({
        user: { id: 'viewer-2', permissions: [] }
      });

      // Nothing belonging to the previous viewer survives the change, and the
      // destructions that clearing the arrangement causes report nothing, because
      // readiness is withdrawn before the array is emptied.
      expect(component.modules).toEqual([]);
      expect(component.isInitialized).toBe(false);

      component.options.itemRemovedCallback(previousItem, itemComponent);

      expect(dashboardLayoutServiceMock.scheduleSave).not.toHaveBeenCalled();
    });

    it('should refuse to place a module while a transition is in flight', async () => {
      await createCanvas({ layout: of(singleModuleLayout) });
      paint();

      dashboardLayoutServiceMock.get.mockReturnValue(EMPTY);

      userServiceMock.stateChanged.next({
        user: { id: 'viewer-2', permissions: [] }
      });

      revealModuleSubject.next(DashboardModuleType.MARKETS);

      // An intent that lands mid-transition must not put a module onto a canvas
      // that is about to be replaced by the arriving viewer's own arrangement.
      expect(component.modules).toEqual([]);
      expect(dashboardLayoutServiceMock.scheduleSave).not.toHaveBeenCalled();
    });

    it('should suspend when a transition begins outside the canvas', async () => {
      await createCanvas({ layout: of(singleModuleLayout) });
      paint();

      const [itemComponent] = gridsterItemComponents();
      const placedItem = component.modules[0];

      // What the shell does before it replaces the token a newly created account
      // was issued. It arrives *before* the new token is stored, which is the only
      // point at which the previous viewer's arrangement can still be withdrawn.
      identityTransitionSubject.next();

      expect(component.isInitialized).toBe(false);
      expect(component.modules).toEqual([]);

      component.options.itemChangeCallback(placedItem, itemComponent);

      expect(dashboardLayoutServiceMock.scheduleSave).not.toHaveBeenCalled();
    });

    it('should rehydrate after a transition that resolves the same viewer', async () => {
      await createCanvas({ layout: of(singleModuleLayout) });
      paint();

      expect(dashboardLayoutServiceMock.get).toHaveBeenCalledTimes(1);

      identityTransitionSubject.next();

      dashboardLayoutServiceMock.get.mockReturnValue(
        of({
          modules: [{ cols: 4, moduleType: 'markets', rows: 3, x: 0, y: 0 }],
          version: 1
        })
      );

      // Creating an account replaces the token but the store may legitimately
      // report the same identity afterwards; a canvas suspended by the transition
      // must still be rebuilt rather than left showing nothing.
      userServiceMock.stateChanged.next({ user: signedInViewer });
      paint();

      expect(dashboardLayoutServiceMock.get).toHaveBeenCalledTimes(2);
      expect(dashboardLayoutServiceMock.get).toHaveBeenLastCalledWith(true);
      expect(component.isInitialized).toBe(true);
      expect(renderedModuleTypes()).toEqual([DashboardModuleType.MARKETS]);
    });

    it('should discard an arrangement that arrives for a viewer who has been replaced', async () => {
      const staleLayout = new Subject<UserDashboardLayout>();

      await createCanvas({ layout: staleLayout.asObservable() });

      dashboardLayoutServiceMock.get.mockReturnValue(
        of({
          modules: [{ cols: 4, moduleType: 'markets', rows: 3, x: 0, y: 0 }],
          version: 1
        })
      );

      userServiceMock.stateChanged.next({
        user: { id: 'viewer-2', permissions: [] }
      });

      // The first viewer's read completes after the second viewer has been
      // adopted. Applying it would put one viewer's modules in front of another.
      staleLayout.next({
        modules: [{ cols: 5, moduleType: 'holdings', rows: 4, x: 0, y: 0 }],
        version: 1
      });
      paint();

      expect(renderedModuleTypes()).toEqual([DashboardModuleType.MARKETS]);
    });

    it('should ignore a failed read belonging to a viewer who has been replaced', async () => {
      const staleLayout = new Subject<UserDashboardLayout>();

      await createCanvas({ layout: staleLayout.asObservable() });

      dashboardLayoutServiceMock.get.mockReturnValue(EMPTY);

      userServiceMock.stateChanged.next({
        user: { id: 'viewer-2', permissions: [] }
      });

      // The first viewer's read fails after the second viewer has been adopted.
      // Marking the canvas ready on their behalf would paint the arriving viewer's
      // canvas as though their own - never read - arrangement had resolved.
      staleLayout.error(new Error('service unavailable'));

      expect(component.isInitialized).toBe(false);
      expect(component.modules).toEqual([]);
    });
  });

  /**
   * The grid engine listens for `window` resize and nothing else - it registers no
   * element observer of its own. That is enough for a full-width canvas, but this
   * grid sits in a drawer container's content pane, and opening the catalog resizes
   * that pane by changing its margin. The window never changes, so the engine never
   * hears about it and keeps laying items out at the pitch of the wider box: the
   * right-hand modules then extend underneath the drawer, and closing it does not
   * put them back.
   */
  describe('the grid host resizing beneath the engine', () => {
    const placedLayout: UserDashboardLayout = {
      modules: [{ cols: 5, moduleType: 'holdings', rows: 4, x: 0, y: 0 }],
      version: 1
    };

    const gridsterObserver = (aGridster: Gridster) => {
      return GfTestResizeObserver.instances.find(({ observed }) => {
        return observed.includes(aGridster.el);
      });
    };

    it('should watch the grid host itself', async () => {
      await createCanvas({ layout: of(placedLayout) });
      paint();

      const gridster = gridsterComponent();

      // The engine's own element, not the drawer, the content pane or the host:
      // the box whose width decides the column pitch is the one that has to be
      // watched.
      expect(gridsterObserver(gridster)).toBeDefined();
    });

    /**
     * jsdom performs no layout and reports every `clientWidth` as 0, so a host box
     * that changes size has to be stated rather than produced.
     */
    const setHostBox = (
      aGridster: Gridster,
      aBox: { height: number; width: number }
    ) => {
      Object.defineProperty(aGridster.el, 'clientHeight', {
        configurable: true,
        value: aBox.height
      });

      Object.defineProperty(aGridster.el, 'clientWidth', {
        configurable: true,
        value: aBox.width
      });
    };

    it('should recalculate the layout when the host box no longer matches what it last laid out at', async () => {
      await createCanvas({ layout: of(placedLayout) });
      paint();

      const gridster = gridsterComponent();
      const onResizeSpy = jest.spyOn(gridster, 'onResize');

      setHostBox(gridster, { height: 698, width: 1440 });

      gridsterObserver(gridster).trigger();

      // `onResize` is the engine's own public entry point - the very one its window
      // listener calls - so this supplies the missing trigger rather than
      // introducing a second layout authority.
      expect(onResizeSpy).toHaveBeenCalledTimes(1);

      // What opening the drawer does: the pane's margin takes the host from the
      // full window width down to the width left beside the panel.
      setHostBox(gridster, { height: 698, width: 1088 });

      gridsterObserver(gridster).trigger();

      expect(onResizeSpy).toHaveBeenCalledTimes(2);
    });

    /**
     * The brake that makes the observer safe: laying the items out can itself change
     * the host's box, so an unconditional call could be observed as another change
     * and recur without end.
     */
    it('should do nothing when the host box is the size it last laid out at', async () => {
      await createCanvas({ layout: of(placedLayout) });
      paint();

      const gridster = gridsterComponent();
      const onResizeSpy = jest.spyOn(gridster, 'onResize');

      setHostBox(gridster, { height: 698, width: 1440 });

      gridsterObserver(gridster).trigger();
      gridsterObserver(gridster).trigger();
      gridsterObserver(gridster).trigger();

      expect(onResizeSpy).toHaveBeenCalledTimes(1);
    });

    /**
     * The regression this guard used to have, and the reason it is stated against a
     * size this canvas records rather than against the engine's own.
     *
     * `curWidth`/`curHeight` are not a record of the size the current layout was
     * computed at - they are a measurement cache that any caller of
     * `setGridDimensions()` refreshes while laying nothing out, and
     * `getNextPossiblePosition()` is such a caller. The canvas calls it once per
     * unplaced module whenever it recomputes catalog availability, which happens as
     * the panel opens - so the cache was routinely brought up to date a few
     * milliseconds before the notification arrived, the old guard found the two
     * equal, and the grid was left laid out for the wider box with its right-hand
     * modules underneath the panel and no way to reach them.
     */
    it('should recalculate even when the engine has already measured the new box without laying it out', async () => {
      await createCanvas({ layout: of(placedLayout) });
      paint();

      const gridster = gridsterComponent();
      const onResizeSpy = jest.spyOn(gridster, 'onResize');

      setHostBox(gridster, { height: 698, width: 1440 });

      gridsterObserver(gridster).trigger();

      expect(onResizeSpy).toHaveBeenCalledTimes(1);

      setHostBox(gridster, { height: 698, width: 1088 });

      // The availability probe, expressed as its only observable effect: the
      // engine's cache now agrees with the host box, while nothing has been laid
      // out at that box.
      gridster.curHeight = 698;
      gridster.curWidth = 1088;

      gridsterObserver(gridster).trigger();

      expect(onResizeSpy).toHaveBeenCalledTimes(2);
    });

    /**
     * On a window too narrow to pay for both the panel and the canvas, the grid's
     * own box does not change when the panel opens - its width floor holds it and
     * the pane clips onto it instead - so the grid alone reports nothing.
     *
     * The pane is therefore observed too, and it has to be added after the view
     * queries resolve: the engine invokes its init callback from its own `ngOnInit`,
     * which runs before the parent's queries, so the element did not yet exist at
     * the point this used to be attempted and was never observed at all.
     */
    it('should watch the drawer content pane as well as the grid', async () => {
      await createCanvas({ layout: of(placedLayout) });
      paint();

      const observer = gridsterObserver(gridsterComponent());
      const pane = fixture.debugElement.query(By.css('mat-sidenav-content'));

      expect(pane).toBeTruthy();
      expect(observer.observed).toContain(pane.nativeElement);
    });

    it('should stop watching when the canvas goes away', async () => {
      await createCanvas({ layout: of(placedLayout) });
      paint();

      const observer = gridsterObserver(gridsterComponent());

      expect(observer.disconnectCount).toBe(0);

      fixture.destroy();

      // Left connected, the observer would keep the grid's host element and a
      // closure over a torn-down engine alive, and would call into that engine on
      // the next reflow.
      expect(observer.disconnectCount).toBe(1);
    });

    /**
     * The canvas outlives its grid, which is the case the teardown above does not
     * cover.
     *
     * Every state that draws no grid - a shared portfolio, a signed-out viewer, a
     * failed viewer read, a failed layout read and the interval before the viewer
     * resolves - destroys the `gridster` child while this component carries on.
     * Releasing the observer only when the whole canvas dies would leave a detached
     * host element and a dead engine held for as long as the viewer stayed on such
     * a state, and the engine's own teardown hook is what closes that.
     */
    it('should stop watching when the grid goes away but the canvas does not', async () => {
      await createCanvas({ layout: of(placedLayout) });
      paint();

      const observer = gridsterObserver(gridsterComponent());

      expect(observer.disconnectCount).toBe(0);

      // Signing out is the ordinary way into a state with no grid, and it leaves
      // this component mounted.
      userServiceMock.stateChanged.next({ user: null });
      paint();

      expect(queryElement('gridster')).toBeNull();
      expect(observer.disconnectCount).toBe(1);
    });

    it('should let go of the destroyed engine itself', async () => {
      await createCanvas({ layout: of(placedLayout) });
      paint();

      expect(component['gridster']).toBe(gridsterComponent());

      userServiceMock.stateChanged.next({ user: null });
      paint();

      // Held, a destroyed engine answers every question the canvas asks it - is
      // there room for this module, which cell does this item occupy - from a
      // layout nobody can see. Every reader already treats its absence as "no grid",
      // which is the same answer as "no grid any more".
      expect(component['gridster']).toBeNull();
    });

    it('should watch the grid that replaces one it let go of', async () => {
      await createCanvas({ layout: of(placedLayout) });
      paint();

      const firstObserver = gridsterObserver(gridsterComponent());

      userServiceMock.stateChanged.next({ user: null });
      paint();

      dashboardLayoutServiceMock.get.mockReturnValue(of(placedLayout));

      userServiceMock.stateChanged.next({ user: signedInViewer });
      paint();

      const secondObserver = gridsterObserver(gridsterComponent());

      // A new grid, a new observer, and the old one stays severed: releasing the
      // engine must not cost the canvas the trigger the next grid depends on.
      expect(queryElement('gridster')).toBeTruthy();
      expect(secondObserver).toBeDefined();
      expect(secondObserver).not.toBe(firstObserver);
      expect(firstObserver.disconnectCount).toBe(1);
      expect(component['gridster']).toBe(gridsterComponent());
    });
  });

  /**
   * A module's content held still while its cell is being resized.
   *
   * The engine writes the cell's `width` and `height` on every pointer move of a
   * resize, and the module inside fills that cell - so without this the whole
   * module subtree is laid out again on every move, the resize observers a
   * charting library installs on its own container wake tens of times per gesture,
   * and the module is painted at sizes it was never meant to be seen at. Pinning
   * the content region's own box for the length of the gesture breaks that chain
   * at its source and reflows the module exactly once, on release.
   *
   * Asserted through the engine's own `resizable.start` / `resizable.stop` hooks,
   * which is where the canvas subscribes to it, and against real `GridsterItem`
   * components. The module chrome is stubbed in this harness, so the region the
   * real host renders is put in place by the test - which is also what makes the
   * declining path below a genuine case rather than a contrived one.
   */
  describe('a module resized by its handle', () => {
    const placedLayout: UserDashboardLayout = {
      modules: [{ cols: 5, moduleType: 'holdings', rows: 4, x: 0, y: 0 }],
      version: 1
    };

    // jsdom performs no layout and reports every offset as zero, so the box the
    // canvas is meant to preserve has to be stated. Both are read before anything
    // is written, which is the ordering the canvas depends on.
    const contentRegion = (aItemComponent: GridsterItem): HTMLElement => {
      const content = document.createElement('div');

      content.classList.add('gridster-item-content');

      Object.defineProperty(content, 'offsetHeight', { value: 240 });
      Object.defineProperty(content, 'offsetWidth', { value: 420 });

      aItemComponent.el.appendChild(content);

      return content;
    };

    it('should hold the resized module content box still for the gesture', async () => {
      await createCanvas({ layout: of(placedLayout) });
      paint();

      const [itemComponent] = gridsterItemComponents();
      const content = contentRegion(itemComponent);

      component.options.resizable.start(
        itemComponent.item(),
        itemComponent,
        new MouseEvent('mousedown')
      );

      // All four, and none of them redundant: the region is a flex item that
      // grows and shrinks with its line, so the two measurements alone would be
      // overruled by the flex algorithm in one axis and by the default cross-axis
      // stretch in the other.
      expect(content.style.flexGrow).toBe('0');
      expect(content.style.flexShrink).toBe('0');
      expect(content.style.height).toBe('240px');
      expect(content.style.width).toBe('420px');
    });

    it('should hand sizing back to the stylesheet when the gesture ends', async () => {
      await createCanvas({ layout: of(placedLayout) });
      paint();

      const [itemComponent] = gridsterItemComponents();
      const content = contentRegion(itemComponent);

      component.options.resizable.start(
        itemComponent.item(),
        itemComponent,
        new MouseEvent('mousedown')
      );
      component.options.resizable.stop(
        itemComponent.item(),
        itemComponent,
        new MouseEvent('mouseup')
      );

      // Cleared rather than restored to a snapshot: all four are stylesheet
      // declarations on that region, so leaving inline copies behind would pin the
      // module at the size it happened to have when it was last resized. Asserted
      // on the same longhand names they are written with, which is also why they
      // are written as longhands - removing a shorthand is specified to remove
      // every longhand it set, and implementations disagree about honouring it.
      expect(content.style.flexGrow).toBe('');
      expect(content.style.flexShrink).toBe('');
      expect(content.style.height).toBe('');
      expect(content.style.width).toBe('');
      expect(component['resizingContentElement']).toBeNull();
    });

    // Every way a gesture can end - mouseup, the pointer leaving the document, a
    // touch cancelled, the window losing focus - reaches the engine's one `stop`
    // hook, so the release is asserted on the hook rather than on any one of them.
    // What matters here is that a release with no hold outstanding is harmless,
    // because the engine calls `stop` for an abandoned gesture too.
    it('should tolerate a gesture ending with nothing held', async () => {
      await createCanvas({ layout: of(placedLayout) });
      paint();

      const [itemComponent] = gridsterItemComponents();

      expect(() =>
        component.options.resizable.stop(
          itemComponent.item(),
          itemComponent,
          new MouseEvent('mouseup')
        )
      ).not.toThrow();

      expect(component['resizingContentElement']).toBeNull();
    });

    it('should release the previous hold when a gesture starts on another module', async () => {
      await createCanvas({
        layout: of({
          modules: [
            { cols: 5, moduleType: 'holdings', rows: 4, x: 0, y: 0 },
            { cols: 5, moduleType: 'markets', rows: 4, x: 5, y: 0 }
          ],
          version: 1
        })
      });
      paint();

      const [firstItem, secondItem] = gridsterItemComponents();
      const firstContent = contentRegion(firstItem);
      const secondContent = contentRegion(secondItem);

      component.options.resizable.start(
        firstItem.item(),
        firstItem,
        new MouseEvent('mousedown')
      );
      component.options.resizable.start(
        secondItem.item(),
        secondItem,
        new MouseEvent('mousedown')
      );

      // A second gesture cannot begin before the first has ended, so this never
      // happens - and that is exactly why it is asserted: were it ever to happen,
      // the first module would be left pinned at a stale size for good, with no
      // gesture left to release it.
      expect(firstContent.style.width).toBe('');
      expect(secondContent.style.width).toBe('420px');
    });

    it('should decline a module with no measurable content region', async () => {
      await createCanvas({ layout: of(placedLayout) });
      paint();

      const [itemComponent] = gridsterItemComponents();

      // No region at all in one case and an unmeasurable one in the other. Both
      // decline for the same reason: a region that is not laid out has no reflow to
      // avoid, so there is nothing for a hold to buy.
      component.options.resizable.start(
        itemComponent.item(),
        itemComponent,
        new MouseEvent('mousedown')
      );

      expect(component['resizingContentElement']).toBeNull();

      const content = document.createElement('div');

      content.classList.add('gridster-item-content');
      itemComponent.el.appendChild(content);

      component.options.resizable.start(
        itemComponent.item(),
        itemComponent,
        new MouseEvent('mousedown')
      );

      expect(component['resizingContentElement']).toBeNull();
      expect(content.style.width).toBe('');
    });

    it('should let go of a hold outstanding when the canvas is torn down', async () => {
      await createCanvas({ layout: of(placedLayout) });
      paint();

      const [itemComponent] = gridsterItemComponents();

      contentRegion(itemComponent);

      component.options.resizable.start(
        itemComponent.item(),
        itemComponent,
        new MouseEvent('mousedown')
      );

      expect(component['resizingContentElement']).not.toBeNull();

      fixture.destroy();

      // The element goes with the canvas, so there is nothing to hand sizing back
      // to and only the reference to let go of.
      expect(component['resizingContentElement']).toBeNull();
    });

    // The hooks exist to keep a module still, not to record anything: a resize that
    // actually changed the arrangement is reported by `itemResizeCallback`, which is
    // one of the four persistence triggers, and neither of these may become a fifth.
    it('should write nothing when a gesture starts or ends', async () => {
      await createCanvas({ layout: of(placedLayout) });
      paint();

      const [itemComponent] = gridsterItemComponents();

      contentRegion(itemComponent);
      dashboardLayoutServiceMock.scheduleSave.mockClear();

      component.options.resizable.start(
        itemComponent.item(),
        itemComponent,
        new MouseEvent('mousedown')
      );
      component.options.resizable.stop(
        itemComponent.item(),
        itemComponent,
        new MouseEvent('mouseup')
      );

      expect(dashboardLayoutServiceMock.scheduleSave).not.toHaveBeenCalled();
    });

    it('should take the edge auto-scroll away for the gesture and give it back', async () => {
      await createCanvas({ layout: of(placedLayout) });
      paint();

      const [itemComponent] = gridsterItemComponents();

      contentRegion(itemComponent);

      // A drag has it, because a module cannot otherwise be carried to a part of a
      // canvas taller than its viewport.
      expect(component.options.disableScrollVertical).toBe(false);
      expect(component.options.disableScrollHorizontal).toBe(false);

      component.options.resizable.start(
        itemComponent.item(),
        itemComponent,
        new MouseEvent('mousedown')
      );

      // A resize must not, because at the bottom edge the scroll compounds: each
      // frame scrolls the region, which moves the edge away from the pointer, which
      // grows the item, which lengthens the grid. A hold of about two seconds
      // committed a module ninety-five rows tall.
      expect(component.options.disableScrollVertical).toBe(true);
      expect(component.options.disableScrollHorizontal).toBe(true);

      component.options.resizable.stop(
        itemComponent.item(),
        itemComponent,
        new MouseEvent('mouseup')
      );

      expect(component.options.disableScrollVertical).toBe(false);
      expect(component.options.disableScrollHorizontal).toBe(false);
    });

    it('should hand the configuration to the engine as a new object', async () => {
      await createCanvas({ layout: of(placedLayout) });
      paint();

      const [itemComponent] = gridsterItemComponents();

      contentRegion(itemComponent);

      const before = component.options;

      component.options.resizable.start(
        itemComponent.item(),
        itemComponent,
        new MouseEvent('mousedown')
      );

      // Identity, not contents. The engine derives what it reads through a
      // `computed` over a required signal input, so mutating the object in place
      // changes nothing it will ever look at again - and spreading forward is what
      // preserves the runtime bookkeeping it has already written onto it.
      expect(component.options).not.toBe(before);
      expect(component.options.itemValidateCallback).toBe(
        before.itemValidateCallback
      );
    });

    it('should give the auto-scroll back when a drag begins', async () => {
      await createCanvas({ layout: of(placedLayout) });
      paint();

      const [itemComponent] = gridsterItemComponents();

      contentRegion(itemComponent);

      component.options.resizable.start(
        itemComponent.item(),
        itemComponent,
        new MouseEvent('mousedown')
      );

      expect(component.options.disableScrollVertical).toBe(true);

      // A gesture can end in a way the engine never reports - the window losing
      // focus mid-resize - so the drag hook restores it as well. Without that, one
      // abandoned resize would take the auto-scroll away from every later drag.
      component.options.draggable.start(
        itemComponent.item(),
        itemComponent,
        new MouseEvent('mousedown')
      );

      expect(component.options.disableScrollVertical).toBe(false);
      expect(component.options.disableScrollHorizontal).toBe(false);
    });

    it('should neither hold anything nor write anything when a drag begins', async () => {
      await createCanvas({ layout: of(placedLayout) });
      paint();

      const [itemComponent] = gridsterItemComponents();
      const content = contentRegion(itemComponent);

      dashboardLayoutServiceMock.scheduleSave.mockClear();

      component.options.draggable.start(
        itemComponent.item(),
        itemComponent,
        new MouseEvent('mousedown')
      );

      // The drag hook exists only to answer the scroll question. A drag that
      // actually changed the arrangement is reported by `itemChangeCallback`, and
      // this must not become a fifth persistence trigger.
      expect(component['resizingContentElement']).toBeNull();
      expect(content.style.width).toBe('');
      expect(dashboardLayoutServiceMock.scheduleSave).not.toHaveBeenCalled();
    });
  });

  describe('the catalog trigger', () => {
    /**
     * One placed module, so the catalog starts closed. A first visit with nothing
     * placed opens it on purpose - see the empty-arrangement handling in
     * `applyLayout` - which would mask both the trigger's resting glyph and its
     * resting position.
     */
    const placedTriggerLayout: UserDashboardLayout = {
      modules: [{ cols: 5, moduleType: 'holdings', rows: 4, x: 0, y: 0 }],
      version: 1
    };

    // The canvas must NOT pad the document. `has-fab` pads the body so a page that
    // flows and scrolls ends clear of a floating trigger; this shell is exactly one
    // viewport tall and scrolls the grid inside itself, so the padding has nothing
    // to push and instead makes the document taller than the viewport. The
    // resulting page scroll moves the control bar off screen and, because it makes
    // the document a scrollable ancestor, lets a module reveal displace everything
    // the viewer was looking at. Asserted on destroy as well so a future change
    // cannot reintroduce it and leave it behind.
    it('should not pad the document, at any point in its lifetime', async () => {
      await createCanvas();
      paint();

      expect(document.body.classList.contains('has-fab')).toBe(false);

      fixture.destroy();

      expect(document.body.classList.contains('has-fab')).toBe(false);
    });

    // The host must NOT carry `page`. That class is for a screen that flows and
    // scrolls the document, and above the small breakpoint it insets its host by 2rem
    // top and bottom - which on a shell exactly one viewport tall puts an empty band
    // above the control bar and pushes the bar off the top of the screen. Everything
    // else that class supplies is either already on this component's own host or
    // contradicted by it.
    it('should not carry the page class, but must keep the grid-scoping one', async () => {
      await createCanvas();
      paint();

      const host = fixture.nativeElement as HTMLElement;

      expect(host.classList.contains('page')).toBe(false);

      // `gf-gridster` is load-bearing: it is the scope the global grid stylesheet
      // hangs every override off, and gridster's own unencapsulated styles are
      // injected after the application stylesheet, so without it they win.
      expect(host.classList.contains('gf-gridster')).toBe(true);
    });

    // A plus would be one more identical teal disc: five feature modules render their
    // own circular add button with a plus, and all of them can be on the canvas at
    // once. A grid glyph says what this control actually opens and agrees with its
    // name, "Browse modules".
    it('should not wear the same glyph as a module add button', async () => {
      // A saved arrangement, so the catalog starts SHUT. A first visit with nothing
      // placed opens it deliberately, which would mask the resting glyph entirely.
      await createCanvas({ layout: of(placedTriggerLayout) });
      paint();

      // Read as a PROPERTY, not an attribute. `ion-icon` is matched by
      // `CUSTOM_ELEMENTS_SCHEMA`, so Angular assigns `[name]` to the element rather
      // than writing an attribute; the real custom element reflects it back, but
      // nothing defines it here, so `getAttribute` reads null either way.
      const glyphName = () => {
        return (
          queryElement('.gf-dashboard-catalog-trigger ion-icon') as unknown as {
            name: string;
          }
        ).name;
      };

      expect(component.modules).toHaveLength(1);
      expect(component.isCatalogOpen).toBe(false);
      expect(glyphName()).toBe('grid-outline');

      component.onOpenCatalog();
      paint();

      expect(glyphName()).toBe('close-outline');
    });

    it('should step clear of the catalog while the catalog is open', async () => {
      await createCanvas({ layout: of(placedTriggerLayout) });
      paint();

      const trigger = queryElement('.gf-dashboard-catalog-trigger');

      // The trigger is fixed at the trailing edge and the drawer opens at that same
      // edge, so while the panel is open the button would otherwise sit on top of
      // its rows - covering a different one as the list scrolls. It cannot simply be
      // hidden instead: it is also the control that closes the panel.
      expect(trigger.classList.contains('is-catalog-open')).toBe(false);

      component.onOpenCatalog();
      paint();

      expect(trigger.classList.contains('is-catalog-open')).toBe(true);

      component.onToggleCatalog();
      paint();

      expect(trigger.classList.contains('is-catalog-open')).toBe(false);
    });

    it('should toggle the catalog from the floating trigger', async () => {
      await createCanvas();
      paint();

      const trigger = queryElement('.gf-dashboard-catalog-trigger button');

      expect(trigger.getAttribute('aria-expanded')).toBe('true');

      trigger.click();
      paint();

      expect(component.isCatalogOpen).toBe(false);
      expect(trigger.getAttribute('aria-expanded')).toBe('false');
      expect(queryElement('mat-sidenav.mat-drawer-opened')).toBeNull();

      trigger.click();
      paint();

      expect(component.isCatalogOpen).toBe(true);
      expect(queryElement('mat-sidenav.mat-drawer-opened')).toBeTruthy();
    });

    it('should open the catalog from the empty notice', async () => {
      await createCanvas();
      paint();

      queryElement('.gf-dashboard-catalog-trigger button').click();
      paint();

      expect(component.isCatalogOpen).toBe(false);

      queryElement('gf-empty-canvas-state button').click();
      paint();

      expect(component.isCatalogOpen).toBe(true);
      expect(queryElement('mat-sidenav.mat-drawer-opened')).toBeTruthy();
    });

    it('should follow the drawer when it closes itself', async () => {
      await createCanvas();
      paint();

      component.onCatalogOpenedChange(false);
      paint();

      expect(component.isCatalogOpen).toBe(false);
      expect(
        queryElement('.gf-dashboard-catalog-trigger button').getAttribute(
          'aria-expanded'
        )
      ).toBe('false');
    });
  });

  /**
   * Where keyboard focus lands once a module is removed.
   *
   * Removing a module destroys the very control the removal was requested from, so
   * left alone the browser drops focus to the document body and a keyboard-only
   * viewer is ejected from the application. These tests assert the landing place
   * rather than the mechanism: the chrome is stood in for throughout this spec, so
   * the canvas's own view query is substituted with hosts that record being asked
   * for focus and report whether it landed - which is exactly the contract the real
   * chrome implements.
   */
  describe('where focus goes after a module is removed', () => {
    const threeModuleLayout: UserDashboardLayout = {
      modules: [
        { cols: 4, moduleType: 'holdings', rows: 4, x: 0, y: 0 },
        { cols: 4, moduleType: 'markets', rows: 4, x: 4, y: 0 },
        { cols: 4, moduleType: 'ai-chat', rows: 4, x: 8, y: 0 }
      ],
      version: 1
    };

    /** Entitled to all three of the modules above, so all three are drawn. */
    const threeModuleViewer = {
      id: 'viewer-1',
      permissions: [permissions.readAiPrompt]
    };

    /**
     * Replaces the canvas's view query with hosts that answer the focus request.
     *
     * One per placed module and in the same order, because the canvas chooses a
     * neighbour by position within that query. Each records the request and reports
     * whether focus landed, which is the half of the contract the canvas acts on.
     */
    const substituteFocusableHosts = (
      aLanded: (moduleType: DashboardModuleType) => boolean = () => true
    ) => {
      const requests: DashboardModuleType[] = [];
      const hosts = component.modules.map(({ moduleType }) => ({
        definition: component.getModuleDefinition(moduleType),
        focusDragHandle: jest.fn<boolean, []>(() => {
          requests.push(moduleType);

          return aLanded(moduleType);
        }),
        reload: jest.fn<void, []>()
      }));

      component.moduleHosts = {
        forEach: (aCallback: (host: (typeof hosts)[number]) => void) => {
          hosts.forEach(aCallback);
        },
        toArray: () => hosts
      } as unknown as typeof component.moduleHosts;

      return requests;
    };

    /**
     * Runs the task the canvas queued for the focus move.
     *
     * The move is deliberately deferred - the menu re-focuses its own trigger
     * synchronously after the handler returns, and the removed cell is still in the
     * document until the next change-detection pass takes it - so nothing has been
     * focused yet at the point the handler returns.
     */
    const settleFocus = async () => {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
    };

    it('should move focus to the module that takes the removed one place', async () => {
      await createCanvas({
        layout: of(threeModuleLayout),
        viewer: threeModuleViewer
      });
      paint();

      const requests = substituteFocusableHosts();

      component.onRemoveModule(component.modules[1]);

      await settleFocus();

      // The next module in reading order, because that is where the eye already is:
      // everything after the removed module shifts up into the space it leaves.
      expect(requests).toEqual([DashboardModuleType.AI_CHAT]);
    });

    it('should fall back to the preceding module when the last one is removed', async () => {
      await createCanvas({
        layout: of(threeModuleLayout),
        viewer: threeModuleViewer
      });
      paint();

      const requests = substituteFocusableHosts();

      component.onRemoveModule(component.modules[2]);

      await settleFocus();

      expect(requests).toEqual([DashboardModuleType.MARKETS]);
    });

    it('should try the next candidate when focus does not land on the first', async () => {
      await createCanvas({
        layout: of(threeModuleLayout),
        viewer: threeModuleViewer
      });
      paint();

      const requests = substituteFocusableHosts(() => false);

      component.onRemoveModule(component.modules[0]);

      await settleFocus();

      // `focus()` on a detached or hidden element is a silent no-op, so a host that
      // reports no landing has to be answered rather than believed. The catalog
      // trigger is the last resort and is always drawn.
      expect(requests).toEqual([DashboardModuleType.MARKETS]);
      expect(document.activeElement).toBe(
        queryElement('.gf-dashboard-catalog-trigger button')
      );
    });

    it('should focus the catalog trigger when the canvas is emptied', async () => {
      await createCanvas({
        layout: of({
          modules: [{ cols: 4, moduleType: 'holdings', rows: 4, x: 0, y: 0 }],
          version: 1
        })
      });
      paint();

      const requests = substituteFocusableHosts();

      component.onRemoveModule(component.modules[0]);

      await settleFocus();

      // No module is left to receive focus, and the trigger is the one control on
      // this surface that survives an emptied arrangement.
      expect(requests).toEqual([]);
      expect(component.modules).toEqual([]);
      expect(document.activeElement).toBe(
        queryElement('.gf-dashboard-catalog-trigger button')
      );
    });

    it('should focus nothing at all when the removal names a module that is not placed', async () => {
      await createCanvas({
        layout: of(threeModuleLayout),
        viewer: threeModuleViewer
      });
      paint();

      const requests = substituteFocusableHosts();
      const activeBefore = document.activeElement;

      component.onRemoveModule({
        cols: 4,
        moduleType: DashboardModuleType.FIRE,
        rows: 4,
        x: 0,
        y: 0
      } as (typeof component.modules)[number]);

      await settleFocus();

      expect(requests).toEqual([]);
      expect(document.activeElement).toBe(activeBefore);
    });

    it('should not reach into the view for a removal in its final moments', async () => {
      await createCanvas({
        layout: of(threeModuleLayout),
        viewer: threeModuleViewer
      });
      paint();

      const requests = substituteFocusableHosts();

      component.onRemoveModule(component.modules[1]);

      fixture.destroy();

      await settleFocus();

      // The queued task is cancelled on teardown. Without that it would ask a
      // destroyed view for chrome that is already gone.
      expect(requests).toEqual([]);
    });

    it('should leave the removal itself as the only thing that reports a change', async () => {
      await createCanvas({
        layout: of(threeModuleLayout),
        viewer: threeModuleViewer
      });
      paint();

      const [itemComponent] = gridsterItemComponents();
      const removedItem = component.modules[1];

      substituteFocusableHosts();
      dashboardLayoutServiceMock.scheduleSave.mockClear();

      component.onRemoveModule(removedItem);
      component.options.itemRemovedCallback(removedItem, itemComponent);

      await settleFocus();

      // Moving focus is not an edit. The engine's own removal callback is the single
      // origin of the write, exactly as before, and the focus move adds none.
      expect(dashboardLayoutServiceMock.scheduleSave).toHaveBeenCalledTimes(1);
    });
  });

  /**
   * A placement the grid engine committed after its own auto-scroll ran away with
   * a held drag.
   *
   * The runaway is upstream behaviour; the commit is this canvas's, and a module
   * ninety rows below everything else is not an arrangement any interaction could
   * have deliberately expressed. The engine's measurements are supplied here
   * because jsdom performs no layout, and the guard deliberately declines to
   * compute a bound from an unmeasured grid.
   */
  describe('a placement carried away by the grid auto-scroll', () => {
    const twoModuleLayout: UserDashboardLayout = {
      modules: [
        { cols: 6, moduleType: 'holdings', rows: 4, x: 0, y: 0 },
        { cols: 6, moduleType: 'markets', rows: 4, x: 6, y: 0 }
      ],
      version: 1
    };

    /**
     * Gives the grid the two measurements the bound is derived from.
     *
     * A viewport ten rows tall, which is what a 900px canvas at this
     * configuration's 80px rows plus 10px margin actually is.
     */
    const measureGrid = ({ curHeight = 900, curRowHeight = 90 } = {}) => {
      const gridster = gridsterComponent();

      gridster.curHeight = curHeight;
      gridster.curRowHeight = curRowHeight;

      return gridster;
    };

    /** Reports a committed geometry the way the engine's own drag release does. */
    const commitGeometry = (
      aIndex: number,
      aGeometry: Partial<{ x: number; y: number }>
    ) => {
      const item = component.modules[aIndex];
      const itemComponent = gridsterItemComponents()[aIndex];

      Object.assign(item, aGeometry);
      Object.assign(itemComponent.$item(), aGeometry);

      component.options.itemChangeCallback(item, itemComponent);
    };

    it('should pull a runaway placement back within a viewport of the arrangement', async () => {
      await createCanvas({ layout: of(twoModuleLayout) });
      paint();

      measureGrid();

      commitGeometry(0, { y: 92 });

      // Everything else bottoms out at row 4, and one viewport is ten rows, so the
      // deepest a drag could deliberately reach is row 14. Ninety-two is the
      // measured result of holding a module against the bottom edge for a couple of
      // seconds.
      expect(component.modules[0].y).toBe(14);
    });

    it('should persist the corrected placement rather than the runaway', async () => {
      await createCanvas({ layout: of(twoModuleLayout) });
      paint();

      measureGrid();
      dashboardLayoutServiceMock.scheduleSave.mockClear();

      commitGeometry(0, { y: 92 });

      // Read without an assertion. The mock is declared with the real argument
      // tuple, so `modules` already arrives as `DashboardLayoutItem[]` and its
      // `moduleType` is already the typed discriminator - which is also what makes
      // the comparison below enum-against-enum rather than string-against-enum.
      // Casting to a plain-string shape was what widened one side of it.
      const reported = dashboardLayoutServiceMock.scheduleSave.mock.calls.map(
        ([, modules]) =>
          modules.find(
            ({ moduleType }) => moduleType === DashboardModuleType.HOLDINGS
          )?.y
      );

      // Every snapshot that reached the write path describes the corrected
      // arrangement. The runaway is never scheduled, so no debounce race can let it
      // through.
      expect(reported.length).toBeGreaterThan(0);
      expect(reported).not.toContain(92);
      expect(reported[reported.length - 1]).toBe(14);
    });

    it('should leave a placement inside the bound exactly where the engine put it', async () => {
      await createCanvas({ layout: of(twoModuleLayout) });
      paint();

      measureGrid();

      commitGeometry(0, { y: 12 });

      // Twelve rows down on an arrangement four rows deep is a full screen clear of
      // everything else, which a pointer drag can genuinely express. The guard is
      // for the runaway, not for deliberate spacing.
      expect(component.modules[0].y).toBe(12);
    });

    it('should never pull a module above where it was already resting', async () => {
      await createCanvas({
        layout: of({
          modules: [
            { cols: 6, moduleType: 'holdings', rows: 4, x: 0, y: 0 },
            { cols: 6, moduleType: 'markets', rows: 4, x: 6, y: 40 }
          ],
          version: 1
        })
      });
      paint();

      measureGrid();

      // The arrangement as saved already places this module far below the other, and
      // that is not this guard's business: a sparse arrangement, or one saved before
      // the guard existed, must survive an unrelated edit untouched. Reporting the
      // *other* module's move is what puts every placement through the check.
      commitGeometry(0, { x: 0, y: 1 });

      expect(component.modules[1].y).toBe(40);
    });

    it('should decline to guess a bound from an unmeasured grid', async () => {
      await createCanvas({ layout: of(twoModuleLayout) });
      paint();

      measureGrid({ curHeight: 0, curRowHeight: 0 });

      commitGeometry(0, { y: 92 });

      // A grid that has not been laid out yields no viewport, and a bound invented
      // without one would clamp every placement to the arrangement's own extent -
      // silently rearranging a dashboard on the strength of a measurement that does
      // not exist.
      expect(component.modules[0].y).toBe(92);
    });

    it('should correct nothing while an arrangement is being hydrated', async () => {
      await createCanvas({
        layout: of({
          modules: [{ cols: 6, moduleType: 'holdings', rows: 4, x: 0, y: 60 }],
          version: 1
        })
      });
      paint();

      measureGrid();

      const [itemComponent] = gridsterItemComponents();

      // The engine reports one init per cell as a saved arrangement is drawn. Those
      // reports measure as unchanged against what was fetched and stop before the
      // guard, so a deep saved placement is drawn exactly as it was saved.
      component.options.itemInitCallback(component.modules[0], itemComponent);

      expect(component.modules[0].y).toBe(60);
      expect(dashboardLayoutServiceMock.scheduleSave).not.toHaveBeenCalled();
    });

    it('should settle in one pass rather than correcting its own correction', async () => {
      await createCanvas({ layout: of(twoModuleLayout) });
      paint();

      measureGrid();
      dashboardLayoutServiceMock.scheduleSave.mockClear();

      commitGeometry(0, { y: 92 });

      const corrected = component.modules[0].y;

      dashboardLayoutServiceMock.scheduleSave.mockClear();

      // The correction travels through the engine, which reports it back through the
      // same handler. A second pass over the corrected arrangement must find nothing
      // to do, or the guard would chase its own tail.
      commitGeometry(0, { y: corrected });

      expect(component.modules[0].y).toBe(corrected);
      expect(dashboardLayoutServiceMock.scheduleSave).not.toHaveBeenCalled();
    });

    it('should keep the correction out of the write path as a second origin', async () => {
      await createCanvas({ layout: of(twoModuleLayout) });
      paint();

      measureGrid();

      const patch = dataServiceMock.patchUserDashboardLayout;

      patch.mockClear();

      commitGeometry(0, { y: 92 });

      // The correction is applied through the engine, so the write it produces is
      // the engine's own change report - not a request this component issued
      // alongside it.
      expect(patch).not.toHaveBeenCalled();
    });
  });

  /**
   * The catalog panel's one dismissal, and the guarantee that it stays reachable.
   *
   * The drawer is `mode="side"`, so it draws no backdrop, and Material does not
   * answer Escape for a side drawer while focus sits outside it - which leaves the
   * floating trigger as the only way out. The trigger is `position: fixed` at the
   * trailing edge and steps aside by exactly the drawer's width while the panel is
   * open, so an unbounded drawer width pushes the sole dismissal off-screen and
   * turns the panel into a pointer trap.
   *
   * Two halves, verified in the two places they are observable. The behavioural
   * half is asserted here. The geometric half is a resolved CSS value: this
   * environment applies no component stylesheet and evaluates neither `min()` nor
   * `100vw`, so the declaration itself is asserted against its own source and the
   * resolved geometry is measured in a browser instead.
   */
  /**
   * Why the grid gives up a strip of width to a button that is not part of it.
   *
   * The catalog trigger is `position: fixed` in the trailing corner while the grid
   * scrolls its content past that corner. So it is not one module that ends up
   * underneath the button - every interactive control any module draws passes
   * through those coordinates at SOME scroll offset, and a control that is
   * reachable at one offset is buried at another. Clearing the corner only for the
   * modules' own floating buttons left every table row menu, toggle and link in the
   * band unreachable, and a focused control down there had its indicator hidden
   * outright, which SC 2.4.11 fails no matter how the indicator is styled.
   *
   * Asserted against the stylesheet rather than by measurement because this
   * environment applies no component stylesheet, performs no layout and resolves
   * neither `calc()` nor `var()`. The geometry itself is measured in a browser.
   */
  describe("reserving the catalog trigger's corner", () => {
    const readCanvasStylesheet = () => {
      return readFileSync(join(__dirname, 'dashboard-canvas.scss'), 'utf8');
    };

    /**
     * The declarations of the first rule whose selector is exactly `aSelector`.
     *
     * Comments are stripped first, and that is not tidiness: the commentary in this
     * stylesheet quotes CSS, braces and all, so a naive slice to the next `}` ends
     * inside a sentence rather than at the end of the rule.
     */
    const readRuleBody = (aStylesheet: string, aSelector: string) => {
      const declarations = aStylesheet.replace(/^\s*\/\/.*$/gm, '');
      const start = declarations.indexOf(`${aSelector} {`);

      expect(start).toBeGreaterThan(-1);

      return declarations.slice(start, declarations.indexOf('}', start));
    };

    it('should narrow the grid itself by the trigger footprint', () => {
      const grid = readRuleBody(readCanvasStylesheet(), 'gridster');

      // On the grid, so the engine's own column pitch is derived from the narrowed
      // box and every cell is laid out inside the reservation. Reserving it on the
      // cells instead would leave the engine believing it had the full width.
      expect(grid).toContain(
        'inline-size: calc(100% - var(--gf-dashboard-catalog-trigger-footprint));'
      );
    });

    it('should take the reservation off the box rather than around it', () => {
      const grid = readRuleBody(readCanvasStylesheet(), 'gridster');

      // Neither of the two usual ways of clearing a floating control works on this
      // element, and both failures are silent.
      //
      // A padding is overwritten: with `outerMargin` on, the engine writes all four
      // `padding-*` values onto its own host inline on every layout pass, so a
      // padding declared here survives exactly until the first drag, resize or add.
      //
      // A margin does nothing at all: the library ships an unencapsulated
      // `gridster { width: 100% }`, and a margin cannot shrink a box whose width is
      // already resolved against its container. Measured in a browser it produced
      // 88px of horizontal overflow on the drawer's content pane and no gutter
      // whatsoever, leaving the module overflow menu still buried.
      expect(grid).not.toContain('padding-right');
      expect(grid).not.toContain('padding-inline-end');
      expect(grid).not.toContain('margin-inline-end');
      expect(grid).not.toContain('margin-right');
    });

    it('should reserve the corner once rather than twice', () => {
      const stylesheet = readCanvasStylesheet().replace(/^\s*\/\/.*$/gm, '');
      const reservations = stylesheet.match(
        /(?:inline-size|margin[\w-]*|padding[\w-]*):[^;]*var\(--gf-dashboard-catalog-trigger-footprint\)/g
      );

      // The modules' own floating buttons used to carry a second copy of this
      // gutter. Now that the whole grid is inset, that gutter would inset them a
      // second time and leave every one of them 88px short of its own module's edge.
      // The footprint is still read a second time elsewhere - as the floor under
      // the drawer's width - which is a different use of the same quantity, so this
      // counts insets rather than mentions.
      expect(reservations).toHaveLength(1);
      expect(reservations[0]).toContain('inline-size');
    });

    it('should move the trigger on the same schedule as the drawer it makes way for', () => {
      const stylesheet = readCanvasStylesheet();

      // Material's own drawer transition. The wrapper is declared with
      // `transition-duration: 0s` globally, so without this the button crossed the
      // drawer's full width in a single frame - roughly a third of a second before
      // the panel arrived - and for that interval it sat over module content that
      // was still there, taking presses aimed at it.
      expect(stylesheet).toContain(
        'transition: right 400ms cubic-bezier(0.25, 0.8, 0.25, 1);'
      );
    });

    it('should drop the travel for a viewer who asked for less motion', () => {
      const stylesheet = readCanvasStylesheet();
      const reducedMotion = stylesheet.slice(
        stylesheet.indexOf('@media (prefers-reduced-motion: reduce)')
      );

      // The button still has to end up beside the panel; what was asked for is the
      // absence of the journey.
      expect(reducedMotion).toContain('.gf-dashboard-catalog-trigger');
      expect(reducedMotion).toContain('transition: none;');
    });
  });

  /**
   * Overlays opened from inside a module - a table's row menu, a tooltip, an
   * autocomplete - are positioned once and then repositioned on the scroll events
   * the CDK's dispatcher reports. The dispatcher only knows about ancestors that
   * registered themselves, and on this screen the document no longer scrolls at
   * all: the grid does. Without the registration the dispatcher had nothing to
   * report, so an overlay stayed at the coordinate its trigger occupied when it
   * opened while the trigger itself scrolled away - and every row menu in every
   * table-bearing module was affected.
   */
  describe('registering the grid as a scrolling ancestor', () => {
    const registeredElements = () => {
      const scrollDispatcher = TestBed.inject(ScrollDispatcher);

      return Array.from(scrollDispatcher.scrollContainers.keys()).map(
        (scrollable) => scrollable.getElementRef().nativeElement
      );
    };

    it('should register the grid host with the scroll dispatcher', async () => {
      await createCanvas({
        layout: of({
          modules: [{ cols: 5, moduleType: 'holdings', rows: 4, x: 0, y: 0 }],
          version: 1
        })
      });
      paint();

      // The engine's own element, because that is the box that scrolls - the drawer
      // content pane above it does not.
      expect(registeredElements()).toContain(queryElement('gridster'));
    });

    it('should not leave the grid registered once it is gone', async () => {
      await createCanvas({
        layout: of({
          modules: [{ cols: 5, moduleType: 'holdings', rows: 4, x: 0, y: 0 }],
          version: 1
        })
      });
      paint();

      const gridsterElement = queryElement('gridster');

      fixture.destroy();

      // A stale registration would have the dispatcher reporting scroll events for
      // a detached element to every overlay that opens afterwards.
      expect(registeredElements()).not.toContain(gridsterElement);
    });
  });

  /**
   * A module's own floating action button, at cells too short to give one away.
   *
   * Five feature components render one, and it is pinned to its module's bottom edge
   * over a body that scrolls beneath it. That costs the reader the band it occupies,
   * which is what a pinned control costs anywhere - until the body gets small enough
   * that the band IS the body. A two-row cell is 170px, of which the header takes about
   * 40px, leaving a body near 120px; a 56px button with its 12px inset covers more than
   * half. A control scrolling past underneath is then hidden, and unlike the END of the
   * content - which the body reserve clears - a control in the middle has nothing to
   * clear it.
   */
  describe('a module too short to pin its own action button', () => {
    const readCanvasTemplate = () => {
      return readFileSync(join(__dirname, 'dashboard-canvas.html'), 'utf8');
    };

    const readCanvasStyles = () => {
      return readFileSync(join(__dirname, 'dashboard-canvas.scss'), 'utf8');
    };

    it('is recognised from the rows it occupies', () => {
      // The row count is the cell's height, known one layer before the browser lays
      // anything out, which is what makes this assertable without one.
      expect(readCanvasTemplate()).toContain(
        '[class.gf-dashboard-module-compact]="item.rows <= 3"'
      );
    });

    it('puts the button back into normal flow', () => {
      const styles = readCanvasStyles();
      const rule =
        /\.gf-dashboard-module-compact \.fab-container \{([^}]*)\}/.exec(
          styles
        );

      expect(rule).toBeTruthy();

      // All three declarations that pinned it are undone. Leaving `inset-block-end`
      // behind would have no effect on a statically positioned box today and would
      // resume having one the moment anything above it became positioned again.
      expect(rule[1]).toContain('position: static');
      expect(rule[1]).toContain('inset-block-end: auto');
      expect(rule[1]).toContain('inset-inline: auto');
    });

    it('keeps the trailing alignment, which should not change with the cell', () => {
      const styles = readCanvasStyles();
      const compactRule =
        /\.gf-dashboard-module-compact \.fab-container \{([^}]*)\}/.exec(
          styles
        );

      // The button's reading position within its module is the one thing that stays
      // the same at every size; only whether it floats changes.
      expect(compactRule[1]).not.toContain('justify-content');
    });

    it('gives back the space that was reserved for the pinned band', () => {
      const styles = readCanvasStyles();

      // With the button in flow there is nothing at the bottom edge to scroll clear
      // of, so the reserve would be a strip of dead space at the end of every one of
      // those modules.
      expect(styles).toMatch(
        /\.gf-dashboard-module-compact\s*\n?\s*\.gridster-item-content:has\(\.fab-container\)/
      );
      expect(styles).toContain('--gf-dashboard-module-body-gutter');
    });

    it('leaves a module large enough for the button pinned', () => {
      const styles = readCanvasStyles();
      // `\n {2}\}` rather than two literal spaces: the closing brace of a rule nested
      // one level deep in the compiled stylesheet is indented by exactly two, and a
      // run of literal spaces in a pattern is both unreadable and linted against.
      const pinnedRule = /::ng-deep \.fab-container \{([\s\S]*?)\n {2}\}/.exec(
        styles
      );

      expect(pinnedRule).toBeTruthy();
      expect(pinnedRule[1]).toContain('position: absolute');
    });
  });

  describe('keeping the catalog dismissible', () => {
    const readCanvasStylesheet = () => {
      return readFileSync(join(__dirname, 'dashboard-canvas.scss'), 'utf8');
    };

    it('should bound the drawer width by the trigger it has to leave room for', () => {
      const stylesheet = readCanvasStylesheet();
      const declaration = /--gf-dashboard-catalog-width:\s*([^;]+);/.exec(
        stylesheet
      );

      expect(declaration).toBeTruthy();

      const value = declaration[1].replace(/\s+/g, ' ').trim();

      // Three terms, and each one is load-bearing.
      //
      // `22rem` is the design width and the preferred term, so it is what applies
      // on every supported viewport. The middle term yields the drawer's width
      // rather than the canvas's once the window cannot pay for both, which is
      // what stops an open panel from starving the canvas to a width its own
      // module chrome cannot lay out in. The `14rem` minimum is the floor under
      // the trigger's reachability: past it the drawer would consume the corner
      // the trigger occupies and the panel's only dismissal would go off-screen.
      expect(value).toContain('clamp(');
      expect(value).toContain('14rem');
      expect(value).toContain('22rem');
      expect(value).toContain('--gf-dashboard-canvas-min-width');
    });

    it('should floor the canvas at a width its own module chrome can exist at', () => {
      const stylesheet = readCanvasStylesheet();

      // Declared once and read by everything that has to agree on it - the
      // drawer's own width above, the grid, and the empty-canvas state - because
      // the three drifting apart is precisely how the corruption arose: the drawer
      // took its width with no reference to what the canvas needed to keep.
      const declarations = stylesheet.match(
        /--gf-dashboard-canvas-min-width:\s*[^;]+;/g
      );

      expect(declarations).toHaveLength(1);
      expect(declarations[0]).toContain('26rem');

      // Capped at the window, which is what makes the floor inert with the panel
      // CLOSED: it can restore width the drawer took, never invent width the
      // window never had, so a narrow viewport with nothing hidden from it gains
      // no scrollbar.
      //
      // Two readers take the floor against the WINDOW: the grid, which divides the
      // columns, and the block-axis edge marks, which span the canvas and would
      // otherwise stop short of it and travel with the inline scroll.
      const windowReaders = stylesheet.match(
        /min-inline-size:\s*min\(\s*var\(--gf-dashboard-canvas-min-width\),\s*100vw\s*\);/g
      );

      expect(windowReaders).toHaveLength(2);

      // The empty-canvas state takes the same floor against its own CONTAINING
      // BLOCK instead, and the distinction is a defect rather than a preference.
      // The drawer is `mode="side"`, so it takes its width out of the pane; a
      // window-relative floor therefore resolved to the whole window inside a pane
      // the drawer had already narrowed, and since that state centres itself in the
      // box, half the card - its description and its only control - was laid out
      // behind the open catalog. On a first visit the catalog is open by design, so
      // that was the very first screen a new viewer saw.
      const paneReaders = stylesheet.match(
        /min-inline-size:\s*min\(\s*var\(--gf-dashboard-canvas-min-width\),\s*100%\s*\);/g
      );

      expect(paneReaders).toHaveLength(1);
    });

    it('should absorb the floor as inline scroll rather than as a crushed canvas', () => {
      const stylesheet = readCanvasStylesheet();

      // Only the inline axis, and stated explicitly rather than inherited from
      // Material's own `overflow: auto`: the reachability of a floored canvas
      // depends on it, and the block axis must stay the grid engine's alone.
      expect(stylesheet).toContain('overflow-x: auto;');
      expect(stylesheet).not.toContain('overflow-y: auto;');
    });

    it('should offset the trigger by the same width the drawer is given', () => {
      const stylesheet = readCanvasStylesheet();

      // One source of truth for both. If the trigger's step-aside distance were
      // spelled out independently, capping one would silently leave the other
      // reading the uncapped figure and the trigger would go off-screen anyway.
      expect(stylesheet).toContain(
        'right: calc(2rem + var(--gf-dashboard-catalog-width));'
      );
    });

    it('should derive the trigger footprint from the two quantities that produce it', () => {
      const stylesheet = readCanvasStylesheet();

      // `right: 2rem` from the global trigger class plus Material's 3.5rem fab
      // diameter. Kept as a sum so the cap above cannot drift from the geometry it
      // is protecting.
      expect(stylesheet).toContain(
        '--gf-dashboard-catalog-trigger-footprint: calc(2rem + 3.5rem);'
      );
    });

    it('should keep the trigger rendered and operable while the catalog is open', async () => {
      await createCanvas();
      paint();

      expect(component.isCatalogOpen).toBe(true);
      expect(queryElement('mat-sidenav.mat-drawer-opened')).toBeTruthy();

      const trigger = queryElement<HTMLButtonElement>(
        '.gf-dashboard-catalog-trigger button'
      );

      // Present, enabled, and reporting the state it will change - because it is
      // the only control that can change it.
      expect(trigger).toBeTruthy();
      expect(trigger.disabled).toBe(false);
      expect(trigger.getAttribute('aria-expanded')).toBe('true');

      trigger.click();
      paint();

      expect(component.isCatalogOpen).toBe(false);
      expect(queryElement('mat-sidenav.mat-drawer-opened')).toBeNull();
    });
  });

  /**
   * Where keyboard focus goes as the catalog opens and closes.
   *
   * A Material drawer in `side` mode manages focus in neither direction: its
   * `autoFocus` resolves to `'dialog'` for that mode, and both the take-focus and
   * the restore-focus paths return immediately for that value. `side` is not
   * negotiable - an `over` or `push` drawer lays down a backdrop that swallows the
   * drag events the grid needs - so the canvas owns the whole lifecycle, and these
   * tests are what hold it to that.
   *
   * They read `document.activeElement` rather than a spy, because `focus()` on a
   * hidden or detached element is a silent no-op: only the document can say where
   * focus actually ended up.
   */
  describe('keyboard focus and the catalog drawer', () => {
    /** One placed module, so the catalog starts closed rather than auto-opened. */
    const placedLayout: UserDashboardLayout = {
      modules: [{ cols: 5, moduleType: 'holdings', rows: 4, x: 0, y: 0 }],
      version: 1
    };

    /**
     * Lets the drawer finish reporting the transition it has begun, then repaints.
     *
     * Two asynchronous hops separate an interaction from the report the focus
     * lifecycle hangs off, which is why this waits for the zone to run dry rather
     * than counting them: the drawer schedules its animation-end on a macrotask, and
     * `openedChange` is an asynchronous `EventEmitter`, so delivery to the canvas is
     * deferred again. Draining is also what makes this independent of how many hops
     * a future Material version uses.
     */
    const settleDrawer = async () => {
      await fixture.whenStable();

      paint();
    };

    const catalogSearchField = () => {
      return queryElement<HTMLInputElement>('gf-module-catalog input');
    };

    const catalogTriggerButton = () => {
      return queryElement<HTMLButtonElement>(
        '.gf-dashboard-catalog-trigger button'
      );
    };

    /**
     * The discard offered by the failed-read card is pressed from inside that card,
     * and the assignment that succeeds it takes the card off the screen - so leaving
     * focus where it was leaves it on a detached element and hands the document body
     * back to the viewer.
     *
     * Same treatment as the auto-open that follows removing the last module, and for
     * the same reason: the panel this opens is the only thing there is to do next, and
     * the control the viewer pressed no longer exists to return to.
     */
    it('should hand focus to the catalog it opens after a discard', async () => {
      await createCanvas({
        layout: throwError(
          () => new HttpErrorResponse({ status: StatusCodes.CONFLICT })
        )
      });
      paint();
      await settleDrawer();

      expect(component.isLayoutUnreadable).toBe(true);

      component.onDiscardLayout();
      paint();
      await settleDrawer();

      expect(component.isCatalogOpen).toBe(true);
      expect(document.activeElement).toBe(catalogSearchField());
    });

    // Nothing to return focus TO once that panel closes, because the card that opened
    // it is gone: the floating trigger is the one control nothing the viewer does can
    // take away.
    it('should fall back to the trigger when the post-discard catalog closes', async () => {
      await createCanvas({
        layout: throwError(
          () => new HttpErrorResponse({ status: StatusCodes.CONFLICT })
        )
      });
      paint();
      await settleDrawer();

      component.onDiscardLayout();
      paint();
      await settleDrawer();

      component.onCatalogOpenedChange(false);
      paint();
      await settleDrawer();

      expect(document.activeElement).toBe(catalogTriggerButton());
    });

    it('should hand focus to the catalog when the viewer asks for it', async () => {
      await createCanvas({ layout: of(placedLayout) });
      paint();
      await settleDrawer();

      expect(component.isCatalogOpen).toBe(false);

      const trigger = catalogTriggerButton();

      // Focused explicitly because `HTMLElement.click()` does not move focus in
      // this environment, whereas a real pointer press on a button does - and the
      // control the viewer came from is the whole subject of the restoration below.
      trigger.focus();
      trigger.click();
      paint();
      await settleDrawer();

      expect(component.isCatalogOpen).toBe(true);

      // Asked exactly once, and where focus lands inside the panel is the panel's
      // own decision - the canvas delegates it rather than reaching past the
      // component into its markup.
      expect(moduleCatalogComponent().focusRequestCount).toBe(1);
      expect(document.activeElement).toBe(catalogSearchField());
    });

    it('should give focus back to the trigger when the drawer closes itself', async () => {
      await createCanvas({ layout: of(placedLayout) });
      paint();
      await settleDrawer();

      const trigger = catalogTriggerButton();

      trigger.focus();
      trigger.click();
      paint();
      await settleDrawer();

      expect(document.activeElement).toBe(catalogSearchField());

      // The drawer closing itself, which is what Escape does. Without the
      // restoration, focus goes to the document body and a keyboard-only viewer is
      // ejected from the application.
      component.onCatalogOpenedChange(false);
      paint();

      expect(component.isCatalogOpen).toBe(false);
      expect(document.activeElement).toBe(trigger);
    });

    it('should take focus the same way however the catalog came to be open', async () => {
      // No saved arrangement, so the canvas opens the panel unprompted - the open
      // that used to behave differently from every other one.
      await createCanvas();
      paint();
      await settleDrawer();

      expect(component.isCatalogOpen).toBe(true);

      // The panel used to decline focus here, which left the same control giving
      // two different accounts of itself: auto-opened it appeared with its search
      // field unfocused and unringed, opened from the trigger it appeared focused
      // and ringed. Nothing is interrupted by taking focus in this case - the
      // canvas is empty, so the search field is the only thing there is to do -
      // and the control bar stays one Shift+Tab behind.
      expect(moduleCatalogComponent().focusRequestCount).toBe(1);
      expect(document.activeElement).toBe(catalogSearchField());

      // And the second, deliberate open is indistinguishable from the first.
      const trigger = catalogTriggerButton();

      trigger.click();
      paint();
      await settleDrawer();

      expect(component.isCatalogOpen).toBe(false);

      trigger.focus();
      trigger.click();
      paint();
      await settleDrawer();

      expect(moduleCatalogComponent().focusRequestCount).toBe(2);
      expect(document.activeElement).toBe(catalogSearchField());
    });

    it('should hand focus to the trigger when an unprompted open closes', async () => {
      await createCanvas();
      paint();
      await settleDrawer();

      expect(component.isCatalogOpen).toBe(true);
      expect(document.activeElement).toBe(catalogSearchField());

      // The drawer closing itself after an unprompted open. There is no origin to
      // return to - nothing was focused when the canvas opened the panel - so the
      // fallback is what answers, and it has to answer something: focus is inside
      // the panel that is closing, and left there it would be orphaned to the
      // document body, which ejects a keyboard-only viewer from the application.
      // The floating trigger is the destination because it is the one control
      // nothing the viewer does to the arrangement can remove.
      component.onCatalogOpenedChange(false);
      paint();

      expect(component.isCatalogOpen).toBe(false);
      expect(document.activeElement).toBe(catalogTriggerButton());
    });

    /**
     * The one auto-open that DOES move focus, and why it is not the same case as the
     * unprompted one above.
     *
     * A viewer who removes their last module acted, and the control they acted with
     * went with the module - so focus has nowhere of its own to return to, and the
     * panel that opens is the only thing left on the screen to do anything with.
     * Leaving the caret on the floating trigger makes them find their own way into
     * it, which is exactly the inconsistency this closes: the explicit-open path has
     * always moved focus into the search field.
     */
    it('should hand focus to the catalog it opens after the last module goes', async () => {
      await createCanvas({
        layout: of({
          modules: [{ cols: 5, moduleType: 'holdings', rows: 4, x: 0, y: 0 }],
          version: 1
        })
      });
      paint();
      await settleDrawer();

      expect(component.isCatalogOpen).toBe(false);

      component.onRemoveModule(component.modules[0]);
      paint();
      await settleDrawer();

      expect(component.modules).toEqual([]);
      expect(component.isCatalogOpen).toBe(true);
      expect(moduleCatalogComponent().focusRequestCount).toBe(1);
      expect(document.activeElement).toBe(catalogSearchField());
    });

    it('should fall back to the trigger when that catalog closes again', async () => {
      await createCanvas({
        layout: of({
          modules: [{ cols: 5, moduleType: 'holdings', rows: 4, x: 0, y: 0 }],
          version: 1
        })
      });
      paint();
      await settleDrawer();

      component.onRemoveModule(component.modules[0]);
      paint();
      await settleDrawer();

      expect(document.activeElement).toBe(catalogSearchField());

      component.onCatalogOpenedChange(false);
      paint();

      // Not the control focus came from - that was the removed module's own menu,
      // which no longer exists. The floating trigger is the only thing nothing the
      // viewer does can take away, which is why it is the fallback rather than a
      // captured origin.
      expect(document.activeElement).toBe(catalogTriggerButton());
    });

    it('should return focus to the empty canvas affordance the viewer opened it from', async () => {
      await createCanvas();
      paint();
      await settleDrawer();

      // Dismissed first, so the open below comes from the affordance rather than
      // from the canvas itself - it is the ORIGIN that differs between the two,
      // not whether focus is taken.
      component.onCatalogOpenedChange(false);
      paint();
      await settleDrawer();

      const affordance = queryElement<HTMLButtonElement>(
        'gf-empty-canvas-state button'
      );

      affordance.focus();
      affordance.click();
      paint();
      await settleDrawer();

      expect(document.activeElement).toBe(catalogSearchField());

      component.onCatalogOpenedChange(false);
      paint();

      // The control the viewer actually came from, not the floating trigger. Both
      // are correct destinations in general; this one is where they were.
      expect(document.activeElement).toBe(affordance);
    });

    it('should leave focus where it is when the catalog cannot take it', async () => {
      await createCanvas({ layout: of(placedLayout) });
      paint();
      await settleDrawer();

      moduleCatalogComponent().willTakeFocus = false;

      const trigger = catalogTriggerButton();

      trigger.focus();
      trigger.click();
      paint();
      await settleDrawer();

      // Asked, refused, and no pretence either way: focus stays on the control the
      // viewer pressed rather than being dropped somewhere unreachable.
      expect(moduleCatalogComponent().focusRequestCount).toBe(1);
      expect(document.activeElement).toBe(trigger);
    });

    it('should not pull focus off something the viewer is using', async () => {
      await createCanvas({ layout: of(placedLayout) });
      paint();
      await settleDrawer();

      const trigger = catalogTriggerButton();

      trigger.focus();
      trigger.click();
      paint();
      await settleDrawer();

      expect(document.activeElement).toBe(catalogSearchField());

      // A focusable control outside the drawer, standing in for anywhere the viewer
      // may have moved on to while the panel stayed open. Appended rather than
      // found, because with a module placed the empty-canvas affordance is not
      // drawn and every other stand-in on this surface renders nothing focusable.
      const elsewhere = document.createElement('button');

      (fixture.nativeElement as HTMLElement).appendChild(elsewhere);
      elsewhere.focus();

      expect(document.activeElement).toBe(elsewhere);

      component.onCatalogOpenedChange(false);
      paint();

      // Untouched. Only focus that the closing panel is about to orphan is worth
      // rescuing; focus anywhere else is in use, and moving it would be a theft.
      expect(document.activeElement).toBe(elsewhere);

      elsewhere.remove();
    });
  });

  /**
   * A keyboard focus indicator on every control this canvas and its two state
   * cards declare.
   *
   * Two things remove it by default, and both are properties of the project rather
   * than of these components: the global stylesheet resets `button:focus`, and this
   * theme builds with `mat.define-theme()` rather than opting into Material's strong
   * focus indicators. What is left is a flat state layer, measured in a browser at
   * 1.066:1 against its own rest state on the filled control, against a 3:1 floor
   * for a non-text indicator. Six of the eight stylesheets in this tree already
   * answered that; these are the two that did not - and the failed-read card's
   * controls are the ONLY interactive things on the screen in the state that draws
   * them.
   *
   * Asserted against the stylesheet sources because this environment applies no
   * component stylesheet, lays nothing out and resolves neither `var()` nor a
   * contrast. The rendered ring and its contrast are measured in a browser.
   */
  describe('a visible focus indicator on the new chrome', () => {
    const readStylesheet = (aPath: string) => {
      return readFileSync(join(__dirname, aPath), 'utf8');
    };

    // Comments are stripped first: the commentary in these stylesheets quotes CSS,
    // braces and all, so a naive slice to the next `}` can end mid-sentence.
    const readRule = (aStylesheet: string, aSelector: string) => {
      const declarations = aStylesheet.replace(/^\s*\/\/.*$/gm, '');
      const start = declarations.indexOf(`${aSelector} {`);

      expect(start).toBeGreaterThan(-1);

      return declarations.slice(start, declarations.indexOf('}', start));
    };

    it.each([
      {
        description: 'the canvas, for its error and notice cards',
        stylesheet: 'dashboard-canvas.scss'
      },
      {
        description: 'the sign-in prompt',
        stylesheet: 'sign-in-prompt/sign-in-prompt.scss'
      },
      {
        description: 'the empty-canvas notice',
        stylesheet: 'empty-canvas-state/empty-canvas-state.scss'
      }
    ])('should draw a ring for $description', ({ stylesheet }) => {
      const ring = readRule(readStylesheet(stylesheet), 'button:focus-visible');

      expect(ring).toContain(
        'outline: 2px solid var(--mat-sys-on-surface, rgba(0, 0, 0, 0.87));'
      );

      // Offset outward, so the ring sits on the surface behind the control rather
      // than on the control's own fill - which is the surface its contrast is
      // properly measured against, and matters most for the filled sign-in button,
      // whose fill is the brand teal.
      expect(ring).toContain('outline-offset: 2px;');
    });

    it.each([
      { stylesheet: 'dashboard-canvas.scss' },
      { stylesheet: 'sign-in-prompt/sign-in-prompt.scss' },
      { stylesheet: 'empty-canvas-state/empty-canvas-state.scss' }
    ])(
      'should flip the ring for the dark theme in $stylesheet',
      ({ stylesheet }) => {
        const source = readStylesheet(stylesheet);
        const darkTheme = source.slice(
          source.indexOf(':host-context(.theme-dark)')
        );

        expect(darkTheme).toContain('button:focus-visible');
        expect(readRule(darkTheme, 'button:focus-visible')).toContain(
          'outline-color: var(--mat-sys-on-surface, #ffffff);'
        );
      }
    );
  });

  describe('architectural invariants', () => {
    it('should take nothing in and report nothing out', async () => {
      await createCanvas();
      paint();

      const mirror = reflectComponentType(GfDashboardCanvasComponent);

      expect(mirror.selector).toBe('gf-dashboard-canvas');
      expect(mirror.inputs).toEqual([]);
      expect(mirror.outputs).toEqual([]);
    });

    it('should render no in-application address', async () => {
      await createCanvas();
      paint();

      expect(queryElements('a')).toHaveLength(0);
      expect(queryElement('[href]')).toBeNull();
      expect(queryElement('router-outlet')).toBeNull();
    });

    it('should hand the grid the shared minimum-footprint predicate', async () => {
      await createCanvas();
      paint();

      expect(component.options.itemValidateCallback).toBe(itemValidateCallback);
    });

    it('should keep the drop path reachable on the engine defaults alone', async () => {
      await createCanvas();
      paint();

      // Drag-to-add needs exactly one option, and the engine's own defaults for
      // everything else. The library screens its drag-over candidate with
      // `if (!$options.enableOccupiedCellDrop && checkCollision(item))`, and that
      // candidate carries no per-item minimums - so what keeps the screen passable is
      // the predicate's fallback to the grid floor, not an extra option that removes
      // the screen. `enableOccupiedCellDrop` is therefore left at its default and is
      // asserted absent: a drop onto an occupied cell is refused by the engine, as it
      // is by default, and the item the canvas appends on a legitimate drop does carry
      // its minimums and is validated in the ordinary way through `addItem`.
      expect(component.options.enableEmptyCellDrop).toBe(true);
      expect(component.options.enableOccupiedCellDrop).toBeUndefined();
    });

    it('should ship the frozen new-item reveal policy', async () => {
      await createCanvas();
      paint();

      // Grid policy, asserted against the configuration factory rather than against a
      // live canvas: the canvas withholds this option while it draws cells nobody asked
      // for, so reading it off a hydrated component would report the withholding rather
      // than the policy. Both halves matter and they are asserted in different places -
      // the policy here, the withholding where hydration is exercised.
      expect(
        createDashboardCanvasConfig({
          onDragGestureStart: () => undefined,
          onEmptyCellDrop: () => undefined,
          onGridsterDestroy: () => undefined,
          onGridsterInit: () => undefined,
          onItemGeometryChange: () => undefined,
          onItemInit: () => undefined,
          onLayoutChange: () => undefined,
          onResizeGestureEnd: () => undefined,
          onResizeGestureStart: () => undefined
        }).scrollToNewItems
      ).toBe(true);
    });

    /**
     * The write funnel has exactly one entrance, asserted from the source rather
     * than from behaviour.
     *
     * A layout write may originate only from a grid state change - drag, resize,
     * add or remove - and all four of the engine's callbacks feed one handler. A
     * fifth caller of that handler would be a fifth trigger however it was
     * plumbed: it would compile, it would pass every behavioural test in this file
     * because the funnel it enters is the correct one, and the rule it breaks is
     * about *where a write may come from*, which no assertion about the resulting
     * request can see. Counting the call sites is the only way to observe it.
     */
    it('should report a layout change from one place only', () => {
      const source = readFileSync(
        join(__dirname, 'dashboard-canvas.component.ts'),
        'utf8'
      );

      const callSites = source.match(/this\.notifyLayoutChange\(\)/g);

      // One: the `onLayoutChange` handler the grid configuration is built with,
      // which all four change callbacks forward to.
      expect(callSites).toHaveLength(1);
      expect(source).toContain(
        'onLayoutChange: () => this.notifyLayoutChange()'
      );
    });
  });
});
