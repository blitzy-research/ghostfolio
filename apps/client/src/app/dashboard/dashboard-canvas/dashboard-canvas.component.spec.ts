import { GfPublicPortfolioComponent } from '@ghostfolio/client/components/public-portfolio/public-portfolio.component';
import { DashboardIntentService } from '@ghostfolio/client/core/dashboard-intent.service';
import { LayoutService } from '@ghostfolio/client/core/layout.service';
import { TokenStorageService } from '@ghostfolio/client/services/token-storage.service';
import { UserService } from '@ghostfolio/client/services/user/user.service';
import type { UserDashboardLayout } from '@ghostfolio/common/interfaces';
import { permissions } from '@ghostfolio/common/permissions';
import { DataService } from '@ghostfolio/ui/services';

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
  itemValidateCallback
} from './dashboard-canvas.config';
import { GfDashboardModuleHostComponent } from './dashboard-module-host/dashboard-module-host.component';
import { GfDashboardToolbarComponent } from './dashboard-toolbar/dashboard-toolbar.component';
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
class GfTestSignInPromptComponent {}

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
    get: jest.Mock;
    getHasSaveError: jest.Mock;
    identityTransition$: Observable<void>;
    retryFailedSave: jest.Mock;
    // Typed precisely, unlike its neighbours, for one reason: the assertions that
    // exactly one array is ever reported have to read the recorded argument and
    // compare it by identity, and an untyped mock would hand that back as `any`.
    // The viewer the arrangement belongs to travels with it, so the array is the
    // second argument.
    scheduleSave: jest.Mock<void, [string, DashboardLayoutItem[]]>;
  };
  let identityTransitionSubject: Subject<void>;
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
      get: jest.fn(() => layout),
      // The canvas only mirrors this state; the snapshot whose write failed stays
      // with the service, which is why the retry is a bare delegation and is
      // asserted as one.
      getHasSaveError: jest.fn(() => saveErrorSubject.asObservable()),
      identityTransition$: identityTransitionSubject.asObservable(),
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
      paint();

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
        .calls[0] as [string, { moduleType: string }[]];

      expect(reported.map(({ moduleType }) => moduleType).sort()).toEqual(
        [
          DashboardModuleType.ADMIN_OVERVIEW,
          DashboardModuleType.AI_CHAT,
          DashboardModuleType.MARKETS,
          DashboardModuleType.MARKETS_PREMIUM
        ].sort()
      );

      // The visible module carries the geometry the grid just committed; the three
      // hidden ones keep the geometry they were saved with, which is the only
      // geometry they have.
      expect(reported).toEqual(
        expect.arrayContaining([
          {
            cols: 4,
            moduleType: DashboardModuleType.MARKETS,
            rows: 3,
            x: 2,
            y: 0
          },
          {
            cols: 8,
            moduleType: DashboardModuleType.ADMIN_OVERVIEW,
            rows: 6,
            x: 0,
            y: 0
          }
        ])
      );
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
      paint();

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
      paint();

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

    it('should not enter the shared state when the access id belongs to the access-editing dialog', async () => {
      await createCanvas({
        queryParams: { accessId: 'abc', editDialog: 'true' }
      });
      paint();

      expect(component.isPublicPortfolio).toBe(false);
      expect(queryElement('gf-public-portfolio')).toBeNull();
      expect(queryElement('gridster')).toBeTruthy();
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

      expect(positionSpy).toHaveBeenCalledTimes(definitions.length);

      positionSpy.mockClear().mockReturnValue(true);

      component.onToggleCatalog();
      component.onToggleCatalog();
      paint();

      expect(component.isCatalogOpen).toBe(true);
      expect(positionSpy).toHaveBeenCalledTimes(definitions.length);
      expect(moduleCatalogComponent().unavailableModuleTypes).toEqual([]);
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
      expect(announcement()).toBe('Holdings cannot be moved any further');
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
      expect(announcement()).toBe('Holdings cannot be moved any further');
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
      expect(announcement()).toBe('Markets cannot be resized any further');
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
      expect(announcement()).toBe('Holdings cannot be resized any further');
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
      expect(announcement()).toBe('Holdings cannot be moved any further');
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
      paint();

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
      paint();

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
      paint();

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
        reload: jest.fn<void, []>()
      }));

      component.moduleHosts = {
        forEach: (callback: (host: (typeof hosts)[number]) => void) => {
          hosts.forEach(callback);
        }
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

    it('should offer the retry and nothing else', async () => {
      await createCanvas({
        layout: throwError(() => new Error('service unavailable'))
      });
      paint();

      const actions = queryElements('[role="alert"] button');

      // Exactly one action, and it is the harmless one. A control that emptied the
      // arrangement and wrote the emptied one back would be a fifth persistence
      // trigger - a layout write may originate only from a grid state change, so
      // drag, resize, add and remove are the whole set - and it would be the only
      // affordance in the application able to overwrite an arrangement the canvas
      // has never successfully read.
      expect(actions).toHaveLength(1);
      expect(actions[0].textContent.trim()).toBe('Try again');
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
      paint();

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

    it('should recalculate the layout when the host box no longer matches what the engine measured', async () => {
      await createCanvas({ layout: of(placedLayout) });
      paint();

      const gridster = gridsterComponent();
      const onResizeSpy = jest.spyOn(gridster, 'onResize');

      // What opening the drawer does, expressed in the only terms available in an
      // environment with no layout: the size the engine last accounted for is no
      // longer the size of its host. jsdom reports every `clientWidth` as 0, so
      // moving `curWidth` off 0 is what makes the two disagree.
      gridster.curHeight = 0;
      gridster.curWidth = 1240;

      gridsterObserver(gridster).trigger();

      // `onResize` is the engine's own public entry point - the very one its window
      // listener calls - so this supplies the missing trigger rather than
      // introducing a second layout authority.
      expect(onResizeSpy).toHaveBeenCalledTimes(1);
    });

    // The guard that makes the observer safe. `onResize` re-measures the host and
    // writes the result back to `curWidth`/`curHeight`, and laying the items out can
    // itself change the host's box - so an unconditional call would be observed as
    // another change and recur without end. Recognising a reflow the engine has
    // already accounted for is what stops the loop.
    it('should do nothing when the host box is the size the engine already accounted for', async () => {
      await createCanvas({ layout: of(placedLayout) });
      paint();

      const gridster = gridsterComponent();
      const onResizeSpy = jest.spyOn(gridster, 'onResize');

      gridster.curHeight = gridster.el.clientHeight;
      gridster.curWidth = gridster.el.clientWidth;

      gridsterObserver(gridster).trigger();

      expect(onResizeSpy).not.toHaveBeenCalled();
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

      // The design width, and a floor under the trigger's reachability. Both terms
      // are required: the first is what applies on every supported viewport, the
      // second is what stops the drawer from consuming the corner the trigger
      // occupies once the viewport is narrower than the two together.
      expect(value).toContain('min(');
      expect(value).toContain('22rem');
      expect(value).toContain('100vw');
      expect(value).toContain('--gf-dashboard-catalog-trigger-footprint');
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

    it('should not take focus when it opens the catalog by itself', async () => {
      // No saved arrangement, so the canvas opens the panel unprompted - the one
      // open a viewer did not ask for.
      await createCanvas();
      paint();
      await settleDrawer();

      expect(component.isCatalogOpen).toBe(true);

      // Never even asked. A viewer meeting an empty canvas is reading it, and
      // moving the caret into a search field they did not reach for would interrupt
      // them and lose their place.
      expect(moduleCatalogComponent().focusRequestCount).toBe(0);
      expect(document.activeElement).toBe(document.body);

      // That count has to be a decision rather than a dead wire, so the same fixture
      // is now driven through a dismissal and a deliberate reopen. Focus arrives on
      // the second open, which proves the hand-off was live all along and simply
      // declined for the open the viewer had not asked for.
      const trigger = catalogTriggerButton();

      trigger.click();
      paint();
      await settleDrawer();

      expect(component.isCatalogOpen).toBe(false);

      trigger.focus();
      trigger.click();
      paint();
      await settleDrawer();

      expect(moduleCatalogComponent().focusRequestCount).toBe(1);
      expect(document.activeElement).toBe(catalogSearchField());
    });

    it('should owe nothing back after an open the viewer did not ask for', async () => {
      await createCanvas();
      paint();
      await settleDrawer();

      expect(component.isCatalogOpen).toBe(true);
      expect(document.activeElement).toBe(document.body);

      // The drawer closing itself after an unprompted open. Focus was never taken,
      // so there is nothing to give back and the trigger must not be focused - a
      // viewer who never touched it would find the caret on a control they did not
      // choose.
      component.onCatalogOpenedChange(false);
      paint();

      expect(component.isCatalogOpen).toBe(false);
      expect(document.activeElement).toBe(document.body);
    });

    it('should return focus to the empty canvas affordance the viewer opened it from', async () => {
      await createCanvas();
      paint();
      await settleDrawer();

      // Dismissed first, so the open below is a deliberate one rather than the
      // unprompted open the canvas has just performed.
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
          onEmptyCellDrop: () => undefined,
          onGridsterDestroy: () => undefined,
          onGridsterInit: () => undefined,
          onItemInit: () => undefined,
          onLayoutChange: () => undefined
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
