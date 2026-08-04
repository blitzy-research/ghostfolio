import { GfPublicPortfolioComponent } from '@ghostfolio/client/components/public-portfolio/public-portfolio.component';
import { DashboardIntentService } from '@ghostfolio/client/core/dashboard-intent.service';
import { TokenStorageService } from '@ghostfolio/client/services/token-storage.service';
import { UserService } from '@ghostfolio/client/services/user/user.service';
import type { UserDashboardLayout } from '@ghostfolio/common/interfaces';
import { permissions } from '@ghostfolio/common/permissions';
import { DataService } from '@ghostfolio/ui/services';

import {
  Component,
  EventEmitter,
  Input,
  Output,
  reflectComponentType
} from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
// The canvas marks its static strings for translation, and the shared module
// metadata its collaborators are typed against reads its own display names the
// same way; both compile to `$localize` calls evaluated at module scope. Nothing
// installs that global in a jsdom test environment - `apps/client/src/polyfills.ts`
// installs it for the application and no test setup file stands in for that - so
// it is installed here.
//
// Its position is load-bearing rather than cosmetic. Prettier sorts imports into
// `@ghostfolio/*`, then third party, then relative, and it sorts side-effect
// imports along with the rest, so this statement can never precede the
// `@ghostfolio/*` group above. Two consequences follow, both measured rather than
// assumed:
//
//  - the module type enum is reached through the relative group below, which is
//    evaluated after this line. `../enums/dashboard-module-type` re-exports the
//    very same symbol from `@ghostfolio/common/dashboard`, so naming that shared
//    entry point directly in the first group would evaluate the metadata map
//    before `$localize` exists;
//  - the user service really is named through its workspace alias in the first
//    group, which is only viable because the dialog that drags the shared route
//    metadata in behind it is cut below.
import '@angular/localize/init';
import { By } from '@angular/platform-browser';
import { ActivatedRoute, Router } from '@angular/router';
import { Gridster, GridsterItem } from 'angular-gridster2';
import type { GridsterItemConfig } from 'angular-gridster2';
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
  DashboardModuleDefinition
} from '../interfaces/interfaces';
import { GfModuleCatalogComponent } from '../module-catalog/module-catalog.component';
import { DashboardModuleRegistryService } from '../module-registry.service';
import { GfDashboardLayoutService } from '../services/dashboard-layout.service';
import { GfDashboardCanvasComponent } from './dashboard-canvas.component';
import { itemValidateCallback } from './dashboard-canvas.config';
import { GfDashboardModuleHostComponent } from './dashboard-module-host/dashboard-module-host.component';
import { GfDashboardToolbarComponent } from './dashboard-toolbar/dashboard-toolbar.component';
import { GfSignInPromptComponent } from './sign-in-prompt/sign-in-prompt.component';

// Cuts the chart tree the shared portfolio brings with it. That tree reaches the
// `color` package, which ships plain `.js` ES modules that this project's Jest
// transform deliberately does not process, so merely naming the real component -
// which this spec must do, to take it back out of the canvas's imports - would
// fail the suite before a single test ran. Nothing real is faked: the stand-in
// registered further down carries the same selector, and the canvas only ever
// renders it, never talks to it.
jest.mock(
  '@ghostfolio/client/components/public-portfolio/public-portfolio.component',
  () => ({ GfPublicPortfolioComponent: class {} })
);

// Cuts the one import chain that would otherwise evaluate the shared route
// metadata - and therefore call `$localize` - before the global above is
// installed: the user service holds a reference to this dialog so that it can
// hand the class to `MatDialog.open`. The user service itself is supplied to the
// canvas as a stub, so neither the dialog nor the code path that opens it is
// reachable from this spec at all.
jest.mock(
  '@ghostfolio/client/components/subscription-interstitial-dialog/subscription-interstitial-dialog.component',
  () => ({ GfSubscriptionInterstitialDialogComponent: class {} })
);

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

/**
 * One emission of the viewer store.
 *
 * `user` is optional because it is genuinely absent at times: the store primes
 * itself with no viewer before the fetch that replaces it resolves, and the canvas
 * treats that "no answer yet" as distinct from an explicit `null`.
 */
interface CanvasViewerState {
  user?: CanvasViewer | null;
}

/**
 * Everything a test may vary about the world the canvas wakes up in.
 *
 * Every member is optional and every default describes the ordinary case - a
 * signed-in viewer, no query parameters, and no saved arrangement - so each test
 * states only the one thing it is actually about.
 */
interface CanvasScenario {
  /** What `GfDashboardLayoutService.get()` answers with. */
  layout?: Observable<UserDashboardLayout | null>;

  /** The query parameters the root route was addressed with. */
  queryParams?: Record<string, string>;

  /**
   * The viewer the store is primed with. `null` is a resolved absence and
   * `undefined` is no answer yet; the canvas must not conflate them.
   */
  viewer?: CanvasViewer | null;

  /**
   * What `UserService.get()` answers with. Only its failure is observable
   * through the canvas, because a success is adopted through the store instead.
   */
  viewerRequest?: Observable<CanvasViewer>;
}

/**
 * Stands in for the control bar.
 *
 * Replaced rather than rendered because the real bar injects thirteen
 * collaborators - a data service, dialogs, notifications, storage and device
 * detection among them - none of which the canvas itself has any opinion about.
 * The canvas passes it nothing and reads nothing back, so the selector is the
 * entire contract and the entire contract is what is kept.
 */
@Component({ selector: 'gf-dashboard-toolbar', template: '' })
class GfTestDashboardToolbarComponent {}

/**
 * Stands in for the shared-portfolio surface, for the same reason and with the
 * same contract: the canvas only decides whether it is on screen.
 */
@Component({ selector: 'gf-public-portfolio', template: '' })
class GfTestPublicPortfolioComponent {}

/**
 * Stands in for the sign-in prompt. Also bindingless.
 */
@Component({ selector: 'gf-sign-in-prompt', template: '' })
class GfTestSignInPromptComponent {}

/**
 * Stands in for the catalog panel, and carries the one output the canvas binds.
 *
 * Emitting from here rather than calling `onAddModule` directly is what proves the
 * outward wiring: a canvas that stopped listening to `moduleAdded` would fail the
 * add tests below even though its handler still worked.
 */
@Component({ selector: 'gf-module-catalog', template: '' })
class GfTestModuleCatalogComponent {
  @Output() public moduleAdded = new EventEmitter<DashboardModuleType>();
}

/**
 * Stands in for a module's chrome, recording the definition it was handed.
 *
 * This stand-in is what makes two assertions possible at once. It never awaits a
 * lazy loader, so "the canvas resolved no module component" is genuinely about the
 * canvas rather than about its child; and it keeps the definition it was bound to,
 * so the registry object the canvas hands over can be compared by identity - which
 * is the contract the real chrome relies on to avoid remounting a module on every
 * change-detection pass.
 */
@Component({ selector: 'gf-dashboard-module-host', template: '' })
class GfTestDashboardModuleHostComponent {
  @Input() public definition: DashboardModuleDefinition;

  @Output() public remove = new EventEmitter<void>();
}

/**
 * Specification for the grid engine's minimum-footprint gate.
 *
 * Held apart from every other suite in this file, and deliberately so: this
 * predicate is the hook through which a footprint declared in the registry becomes
 * a footprint the engine *enforces*, and the whole reason it lives in its own
 * module is that enforcing it can be proven without a component, a fixture, a DOM
 * or an injector. Nothing below constructs any of those. A future change that made
 * this suite need a `TestBed` would be a change that had moved policy back into the
 * canvas.
 *
 * The engine consults the predicate before it commits a resize and before it admits
 * a drop, so returning `false` genuinely rejects a placement rather than merely
 * reporting on one.
 */
describe('itemValidateCallback', () => {
  /**
   * A placement that declares the 2x2 floor as its own minimum. Spread into each
   * case below so that every assertion differs from its neighbours in exactly the
   * dimension it is about.
   */
  const atFloor: GridsterItemConfig = {
    cols: 2,
    minItemCols: 2,
    minItemRows: 2,
    rows: 2,
    x: 0,
    y: 0
  };

  /**
   * A placement whose module asks for more room than the grid-wide floor, used to
   * show that the stricter of the two is what is measured against.
   */
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
    // 3x3 clears the grid-wide 2x2 floor outright, so the only thing that can
    // reject it is the module's own declared minimum. This is the case that
    // distinguishes an enforced per-item minimum from a merely recorded one.
    expect(itemValidateCallback({ ...stricterThanFloor, cols: 3 })).toBe(false);
  });

  it('should hold a placement that declares no minimum to the grid floor', () => {
    // Both members are optional on a grid item, and the absent case has to fall
    // back to the grid's own floor rather than compare against `undefined`,
    // because `4 >= undefined` is `false`. That is not defensive padding: the
    // library mints its own drop candidate as nothing but a cell and a size, so a
    // predicate that rejected it would make catalog drag-to-add unreachable in
    // every browser - and the drop callback is the only place the canvas could
    // ever attach the minimums. Nothing is weakened, because the substituted
    // floor is the same 2x2 the engine is configured with.
    expect(itemValidateCallback({ cols: 4, rows: 4, x: 0, y: 0 })).toBe(true);
    expect(itemValidateCallback({ cols: 1, rows: 4, x: 0, y: 0 })).toBe(false);
    expect(itemValidateCallback({ cols: 4, rows: 1, x: 0, y: 0 })).toBe(false);
  });
});

/**
 * Specification for the single canvas the application is mounted on.
 *
 * The canvas owns three things, and almost every test below is about one of them:
 * which of four states the viewer is looking at, the one array that says where
 * every module sits and how large it is, and when an arrangement is worth saving.
 *
 * Six properties of this harness are load-bearing, and each was established by
 * measurement rather than convention.
 *
 * **The real grid engine is mounted, not stubbed.** That was not the safe
 * assumption - it was checked. In this environment `angular-gridster2` renders
 * without a layout engine, references no observer API, leaves a hydrated item's
 * cell and size untouched, and raises none of its own callbacks, so keeping it
 * real costs nothing in determinism and buys the assertions that the required
 * `options` input is genuinely satisfied and that one grid cell really is rendered
 * per placed module. It also supplies properly typed `Gridster` and `GridsterItem`
 * instances, which is what lets every grid callback below be invoked through the
 * configuration the canvas hands the engine, with no type assertion anywhere.
 *
 * **The viewer is delivered through the store, never through the fetch.** The
 * canvas adopts a viewer only from `UserService.stateChanged`; `UserService.get()`
 * exists for it to observe a *failure*. Seeding the store with a `BehaviorSubject`
 * therefore completes hydration inside the constructor, which is exactly what
 * makes "the catalog is already open on the first frame" a statement about the
 * first frame rather than about the second.
 *
 * **The chrome around the canvas is replaced, the empty notice is not.** The
 * control bar, the sign-in prompt, the shared portfolio and the catalog panel each
 * bring a large collaborator tree the canvas has no opinion about, and the module
 * chrome is replaced so that "no module component was resolved" is a statement
 * about the canvas rather than about its child. The empty notice injects nothing at
 * all, so it is rendered for real.
 *
 * **The registry stub performs a real lookup.** It answers `get` by searching its
 * definitions and `getAll` with all of them, unfiltered - narrowing to a viewer is
 * the canvas's own job. A stub that pre-filtered, or that answered every lookup
 * with the same definition, would make the visibility and stale-discriminator tests
 * vacuous.
 *
 * **A `Router` mock is provided, and that is the Rule 5 guard rather than a hole in
 * it.** The canvas injects `Router` as a constructor dependency, so its absence
 * cannot be the assertion here; what it does with it can be, and is. Every test
 * that expects no navigation says so explicitly, and the one navigation the canvas
 * is allowed to make is asserted down to its exact arguments: the empty command
 * array, one nulled parameter and a merge. No route table, `provideRouter` or
 * router testing module is configured anywhere in this file - please do not add one
 * to "fix" a failure, because the URL no longer selects a screen.
 *
 * **No timer is faked and none is needed.** The canvas does not debounce; the five
 * hundred millisecond window belongs to `GfDashboardLayoutService`, whose own spec
 * owns it. Everything here settles synchronously, so there is no clock to advance
 * and none to hand back.
 */
describe('GfDashboardCanvasComponent', () => {
  /** The ordinary viewer: signed in, holding no elevated permission. */
  const signedInViewer: CanvasViewer = { id: 'viewer-1', permissions: [] };

  let component: GfDashboardCanvasComponent;
  let activatedRouteMock: {
    queryParams: Observable<Record<string, string>>;
    snapshot: { queryParams: Record<string, string> };
  };
  let dashboardLayoutServiceMock: {
    get: jest.Mock;
    // Typed precisely, unlike its neighbours, for one reason: the assertions that
    // exactly one array is ever reported have to read the recorded argument and
    // compare it by identity, and an untyped mock would hand that back as `any`.
    scheduleSave: jest.Mock<void, [DashboardLayoutItem[]]>;
  };
  let dataServiceMock: {
    fetchUserDashboardLayout: jest.Mock;
    patchUserDashboardLayout: jest.Mock;
  };
  let definitions: DashboardModuleDefinition[];
  let fixture: ComponentFixture<GfDashboardCanvasComponent>;
  let originalScrollIntoViewDescriptor: PropertyDescriptor;
  let registryServiceMock: { get: jest.Mock; getAll: jest.Mock };
  let revealModuleSubject: Subject<DashboardModuleType>;
  let routerMock: { navigate: jest.Mock };
  let scrollIntoViewMock: jest.Mock;
  let tokenStorageServiceMock: { saveToken: jest.Mock };
  let userServiceMock: {
    get: jest.Mock;
    // Widened to allow no state at all, because the real store genuinely emits that
    // way before it has been primed - and the canvas has to survive it.
    stateChanged: BehaviorSubject<CanvasViewerState | null>;
  };

  /**
   * The registered modules this spec exercises.
   *
   * Two declare no permission and three sit behind one each, which mirrors the real
   * registry: of its twenty-one entries, exactly seven are gated, across the three
   * permissions used here. `markets` is present specifically because it is free
   * while `markets-premium` is not, so a viewer entitled to nothing still sees
   * something - which is what stops the visibility tests from passing for the wrong
   * reason.
   *
   * Every footprint differs from its neighbours so that "the size came from this
   * definition" cannot be satisfied by accident, and every loader is a mock that
   * must never be called: placing or hydrating a module may not fetch its bundle.
   *
   * Rebuilt per test so that loader call records cannot leak between them.
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
   * Builds the canvas for one scenario, stopping short of the first render.
   *
   * Painting is left to each test on purpose. The canvas finishes resolving the
   * viewer and their arrangement while it is being constructed, so the gap between
   * construction and the first change-detection pass is precisely where "before the
   * canvas was first painted" can be observed.
   */
  const createCanvas = async (scenario: CanvasScenario = {}) => {
    const {
      layout = of(null),
      queryParams = {},
      viewerRequest = EMPTY
    } = scenario;

    // Read with `in` rather than through a destructuring default, because
    // `undefined` is a meaningful value here - it is the store's "nobody has
    // answered yet" - and a default would silently replace it with a viewer.
    const viewer = 'viewer' in scenario ? scenario.viewer : signedInViewer;

    activatedRouteMock = {
      queryParams: of(queryParams),
      snapshot: { queryParams }
    };

    dashboardLayoutServiceMock = {
      get: jest.fn(() => layout),
      scheduleSave: jest.fn<void, [DashboardLayoutItem[]]>()
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
    routerMock = { navigate: jest.fn() };
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
          provide: DashboardModuleRegistryService,
          useValue: registryServiceMock
        },
        { provide: DataService, useValue: dataServiceMock },
        {
          provide: GfDashboardLayoutService,
          useValue: dashboardLayoutServiceMock
        },
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

  /** Runs initialization and lets the view catch up. */
  const paint = () => {
    fixture.detectChanges();
  };

  /**
   * Reads one element out of the rendered canvas.
   *
   * The host element is narrowed once, here, because a fixture hands it back
   * untyped; every caller below is then fully typed and nothing else in this file
   * has to restate the shape of the DOM.
   */
  function queryElement<T extends HTMLElement>(aSelector: string) {
    return (fixture.nativeElement as HTMLElement).querySelector<T>(aSelector);
  }

  function queryElements<T extends HTMLElement>(aSelector: string) {
    return Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll<T>(aSelector)
    );
  }

  /**
   * The live grid, reached through the injector rather than through
   * `componentInstance` so that it arrives properly typed.
   */
  const gridsterComponent = (): Gridster => {
    return fixture.debugElement
      .query(By.directive(Gridster))
      .injector.get(Gridster);
  };

  /** The grid's own cell components, in render order. */
  const gridsterItemComponents = (): GridsterItem[] => {
    return fixture.debugElement
      .queryAll(By.directive(GridsterItem))
      .map((cell) => {
        return cell.injector.get(GridsterItem);
      });
  };

  /** The catalog stand-in, so its one output can be emitted the way the real one does. */
  const moduleCatalogComponent = (): GfTestModuleCatalogComponent => {
    return fixture.debugElement
      .query(By.directive(GfTestModuleCatalogComponent))
      .injector.get(GfTestModuleCatalogComponent);
  };

  /** The module chrome stand-ins, in render order. */
  const moduleHostComponents = (): GfTestDashboardModuleHostComponent[] => {
    return fixture.debugElement
      .queryAll(By.directive(GfTestDashboardModuleHostComponent))
      .map((host) => {
        return host.injector.get(GfTestDashboardModuleHostComponent);
      });
  };

  /**
   * The module types actually rendered onto the canvas, in render order.
   *
   * The definition is read optionally so that a canvas which rendered chrome for a
   * discriminator the registry could not resolve reports itself as an `undefined`
   * entry in a diff, rather than faulting inside this helper and hiding what went
   * wrong behind a null dereference.
   */
  const renderedModuleTypes = (): DashboardModuleType[] => {
    return moduleHostComponents().map(
      ({ definition }) => definition?.moduleType
    );
  };

  /** Cell and size of every placed module, in the array's own order. */
  const placedGeometry = () => {
    return component.modules.map(({ cols, moduleType, rows, x, y }) => ({
      cols,
      moduleType,
      rows,
      x,
      y
    }));
  };

  /** The declared minimum copied onto every placed module. */
  const placedMinimums = () => {
    return component.modules.map(
      ({ minItemCols, minItemRows, moduleType }) => ({
        minItemCols,
        minItemRows,
        moduleType
      })
    );
  };

  /**
   * Every one of the grid's four change triggers, read off the configuration the
   * canvas handed the engine.
   *
   * Collected as a list so that "all four reach the same handler" is one assertion
   * over the complete set rather than four assertions that could each be satisfied
   * by a separate subject.
   */
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

  /**
   * Hands the configuration's drop callback a payload shaped exactly the way a
   * catalog row writes one.
   *
   * The payload contract is frozen and reproduced here verbatim: the bare
   * kebab-case discriminator under the `text/plain` key, with no JSON, no wrapper
   * object, no prefix and no custom MIME type. The stub answers *only* for that key,
   * so a canvas that read any other one would receive nothing and place nothing -
   * which makes the key part of the assertion rather than part of the setup.
   *
   * jsdom implements neither `DragEvent` nor `DataTransfer`, so the event is a real
   * `MouseEvent` carrying the single member the canvas reads, handed over through a
   * locally widened alias of the callback. That alias is the entire seam, it is
   * cast-free, and it is why nothing in this file asserts a type.
   *
   * @param aModuleType the discriminator to advertise, or `null` to model a drag
   * that carries no transfer object at all.
   * @param aCell the cell the grid had already positioned the candidate at.
   */
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

      // Asserted before the first change-detection pass deliberately. The flag has
      // to be set by the time the canvas becomes visible, not shortly afterwards,
      // or a first-time viewer sees one frame of a blank canvas with the panel shut
      // and then watches it swing open.
      expect(component.isCatalogOpen).toBe(true);
      expect(component.isInitialized).toBe(true);
    });

    it('should render the empty notice with the catalog panel already open', async () => {
      await createCanvas({ layout: of(null) });
      paint();

      expect(queryElement('gf-empty-canvas-state')).toBeTruthy();
      // The panel is genuinely open in the rendered output, not merely flagged open
      // on the class.
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

      // The drop target a dragged catalog row needs has to exist precisely when the
      // canvas is still empty, which is when it is most likely to be used, so the
      // notice is drawn over the grid rather than instead of it.
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

      // The first read is the only one entitled to a cached answer; every later one
      // is forced, because a cached absence belonging to a previous viewer is exactly
      // the value that would open the catalog for whoever just signed in.
      expect(dashboardLayoutServiceMock.get).toHaveBeenCalledTimes(1);
      expect(dashboardLayoutServiceMock.get).toHaveBeenCalledWith(false);
    });

    it('should issue no navigation', async () => {
      await createCanvas({ layout: of(null) });
      paint();

      // The router still owns the one root route and the canvas never addresses a
      // screen. This assertion is the mechanical form of that rule; see the note on
      // the `Router` mock in this suite's documentation.
      expect(routerMock.navigate).not.toHaveBeenCalled();
    });
  });

  describe('a saved arrangement that names no modules', () => {
    it('should treat an empty module list exactly as no saved arrangement', async () => {
      await createCanvas({ layout: of({ modules: [], version: 1 }) });

      expect(component.isCatalogOpen).toBe(true);

      paint();

      // "No saved row" and "a saved row with nothing in it" have to be the same
      // experience, or a viewer who removes their last module is stranded on a blank
      // canvas with no way back to the catalog.
      expect(component.modules).toEqual([]);
      expect(queryElement('gf-empty-canvas-state')).toBeTruthy();
      expect(queryElement('mat-sidenav.mat-drawer-opened')).toBeTruthy();
    });
  });

  describe('a returning viewer', () => {
    /**
     * A saved arrangement whose sizes deliberately disagree with the defaults the
     * registry declares - holdings defaults to six by four and markets to four by
     * three - so that "the saved size was used" cannot be satisfied by a canvas that
     * simply re-applied the registry's defaults. Holdings also sits away from the
     * top row, so honouring `y` is proven rather than assumed.
     *
     * Both placements fit inside the twelve columns and occupy disjoint column
     * ranges, and that is a requirement of the fixture rather than a nicety. The
     * engine is real here, and it was measured doing exactly what it documents: an
     * item that cannot be placed where it was asked for is relocated by
     * `autoPositionItem`, and that relocation is announced through
     * `itemChangeCallback` - a genuine persistence trigger. A fixture that overflowed
     * the grid or self-collided would therefore be measuring the engine's recovery
     * instead of the canvas's hydration, and would schedule a spurious write while
     * doing it.
     */
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

      // Required rather than tidy. The engine measures a placement against these two
      // members, they are optional on a grid item, and the registry definition is
      // their only source - the saved document does not carry them, because a
      // module's minimum is the application's to declare and not the viewer's to
      // have frozen.
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

      // Drawing an arrangement must not fetch a single module bundle here: awaiting
      // the lazy loader belongs to the module chrome, one level down, and that is
      // what preserves the code-splitting boundary the collapsed route table used to
      // provide. This is the only mechanical guard against a future canvas that
      // resolved them eagerly.
      for (const { loadComponent } of definitions) {
        expect(loadComponent).not.toHaveBeenCalled();
      }
    });

    it('should hand the module chrome the registry own definition object', async () => {
      await createCanvas({ layout: of(savedLayout) });
      paint();

      const [holdings, markets] = definitions;

      // Identity, not equality. The chrome compares successive definitions to decide
      // whether it still has to fetch a component class, so a fresh object per call
      // would make every change-detection pass look like a new module and remount it.
      expect(moduleHostComponents()[0].definition).toBe(holdings);
      expect(moduleHostComponents()[1].definition).toBe(markets);
    });

    it('should report no layout change merely by hydrating', async () => {
      await createCanvas({ layout: of(savedLayout) });
      paint();

      // Putting a saved arrangement back on screen is not the viewer arranging
      // anything, so it must not schedule a write.
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

      // An arrangement saved before a module was renamed or withdrawn has to survive
      // with everything still recognisable intact, because the alternative is a
      // viewer whose whole canvas disappears the release after a module is retired.
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

      // The registry is the only thing consulted, and it is consulted for every
      // entry. There is no second route by which a component could reach a cell -
      // which is what makes "register it or it cannot appear" structural rather than
      // conventional.
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

      // Cells are keyed on the discriminator, so a repeated one could not be told
      // apart from the first. Keeping only the first is what makes that key safe.
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

      // An arrangement that survives as nothing is, from the viewer's side, an empty
      // canvas - so it gets the same treatment rather than a blank screen with no
      // route back to the catalog.
      expect(component.isCatalogOpen).toBe(true);

      paint();

      expect(queryElement('gf-empty-canvas-state')).toBeTruthy();
    });
  });

  describe('module visibility', () => {
    /**
     * An arrangement holding one free module and one behind each of the three
     * permissions the real registry actually uses. Column ranges are disjoint so
     * that whichever subset survives is placeable exactly as saved.
     */
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

      // Deleting the navigation chrome removed the only place a client-side
      // permission was ever checked, so this filter is what replaces it. Nothing is
      // special-cased by name: the metadata is the entire rule.
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
  });

  describe('a portfolio shared by access link', () => {
    it('should render only the shared portfolio', async () => {
      await createCanvas({ queryParams: { accessId: 'abc' }, viewer: null });
      paint();

      expect(queryElement('gf-public-portfolio')).toBeTruthy();

      // None of these acts on somebody else's portfolio, so none of them is drawn.
      expect(queryElement('gf-dashboard-toolbar')).toBeNull();
      expect(queryElement('gridster')).toBeNull();
      expect(queryElement('gf-module-catalog')).toBeNull();
      expect(queryElement('gf-sign-in-prompt')).toBeNull();
      expect(queryElement('.gf-dashboard-catalog-trigger')).toBeNull();
    });

    it('should let a shared link win over the viewer own session', async () => {
      await createCanvas({ queryParams: { accessId: 'abc' } });
      paint();

      // The state order is behaviour rather than an implementation detail: whose
      // session happens to be open has no bearing on what a link handed to a stranger
      // shows.
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

      // `accessId` is not exclusively a share-link parameter. The account access
      // module puts `?accessId=<id>&editDialog=true` on this very route to reopen its
      // own edit dialog, so matching on `accessId` alone would replace a signed-in
      // viewer's entire canvas with a stranger's portfolio the moment they edited one
      // of their own access grants.
      expect(component.isPublicPortfolio).toBe(false);
      expect(queryElement('gf-public-portfolio')).toBeNull();
      expect(queryElement('gridster')).toBeTruthy();
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

      // The store primes itself with no viewer before anything has been fetched, and
      // that is not an absence. Concluding one would show the sign-in prompt to
      // somebody who is signed in, for exactly as long as their session took to
      // resolve.
      expect(component.isSignedOut).toBe(false);
      expect(component.isInitialized).toBe(false);
      expect(queryElement('gf-sign-in-prompt')).toBeNull();
      expect(queryElement('gridster')).toBeNull();
      expect(queryElement('gf-public-portfolio')).toBeNull();
    });

    it('should ask for an unresolved viewer exactly once', async () => {
      await createCanvas({ viewer: undefined, viewerRequest: EMPTY });
      paint();

      // Both the query-parameter subscription and initialization name the resolution
      // entry point, so the guard inside it is what keeps that from becoming two
      // requests.
      expect(userServiceMock.get).toHaveBeenCalledTimes(1);
    });

    it('should mark the viewer signed out when the request for them fails', async () => {
      await createCanvas({
        viewer: undefined,
        viewerRequest: throwError(() => new Error('unauthorized'))
      });
      paint();

      // A failed request for the viewer is the one thing that establishes "not signed
      // in"; a success arrives through the store instead.
      expect(component.isSignedOut).toBe(true);
      expect(queryElement('gf-sign-in-prompt')).toBeTruthy();
    });

    it('should not ask for a viewer who has already resolved', async () => {
      await createCanvas();
      paint();

      expect(userServiceMock.get).not.toHaveBeenCalled();
    });
  });

  describe('the spent jwt parameter', () => {
    it('should strip only the jwt parameter, merging every other', async () => {
      await createCanvas({
        queryParams: { holdingDetailDialog: 'true', jwt: 'a-signed-token' }
      });
      paint();

      // The empty command array is this workspace's route-agnostic convention - it
      // rewrites the current URL rather than addressing anything - and merging is what
      // preserves every other parameter, a shared portfolio id and each dialog flag
      // among them. Nulling the single key is how it is dropped.
      expect(routerMock.navigate).toHaveBeenCalledTimes(1);
      expect(routerMock.navigate).toHaveBeenCalledWith([], {
        queryParams: { jwt: null },
        queryParamsHandling: 'merge',
        relativeTo: activatedRouteMock
      });
    });

    it('should not adopt the token a second time', async () => {
      await createCanvas({ queryParams: { jwt: 'a-signed-token' } });
      paint();

      // The route guard already exchanged and stored the token, precisely because
      // navigating from inside `canActivate` risks cancelling the navigation in
      // progress. The canvas owns the other half and only the other half: removing the
      // spent parameter from the address bar.
      expect(tokenStorageServiceMock.saveToken).not.toHaveBeenCalled();
    });

    it('should issue no navigation when no jwt is present', async () => {
      await createCanvas({ queryParams: { holdingDetailDialog: 'true' } });
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

      // Where a module fits is the engine's answer to give, never the canvas's to
      // guess, so the cell the engine wrote onto the candidate is the cell the module
      // ends up in.
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

      // The declared default size and the declared minimum both travel with the
      // candidate. The minimum has to, or the engine's own validation would measure
      // the placement against nothing.
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

      // A full canvas means adding nothing. Placing the module anyway would stack it
      // on top of something the viewer put there.
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

      // The two are not interchangeable, and this is the only place that difference is
      // observable: the component instance's member returns a `boolean` reporting
      // whether a free cell exists, while the identically named member of the public
      // api surface returns `void`. Click-to-add needs that answer, so reaching for
      // the api object would leave the canvas unable to tell a placed module from an
      // unplaceable one.
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

      // Handing a different grid to the configuration's init callback is what redirects
      // the question, which is the proof that the callback really is where the canvas
      // acquires its engine - rather than the canvas reaching for one some other way.
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

      // Cells are keyed on the discriminator, so the canvas could not represent the
      // same module twice even if it wanted to. Bringing the existing one into view is
      // the useful reading of the request, and it changes nothing worth saving.
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

      // `x-ray` is a genuine discriminator that this spec's registry deliberately does
      // not hold, which models a module withdrawn from the registry while an intent
      // naming it was still in flight.
      expect(component.modules).toEqual([]);
      expect(dashboardLayoutServiceMock.scheduleSave).not.toHaveBeenCalled();
    });

    it('should ignore a module the viewer may not see', async () => {
      await createCanvas({ viewer: { id: 'viewer-1', permissions: [] } });
      paint();

      moduleCatalogComponent().moduleAdded.emit(
        DashboardModuleType.ADMIN_OVERVIEW
      );

      // The same visibility check the render path applies, applied at the same place,
      // so a gated module cannot be smuggled onto the canvas by an intent that
      // bypassed the catalog's own filtering.
      expect(component.modules).toEqual([]);
    });
  });

  describe('the single persistence path', () => {
    /**
     * The smallest arrangement that still yields a real grid cell, which the grid's
     * own change triggers need as their second argument.
     */
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

      expect(dashboardLayoutServiceMock.scheduleSave).toHaveBeenCalledTimes(1);
      expect(
        dashboardLayoutServiceMock.scheduleSave.mock.calls[0][0]
      ).toHaveLength(1);
    });

    it('should report a layout change when a module is removed from its chrome', async () => {
      await createCanvas({ layout: of(singleModuleLayout) });
      paint();

      moduleHostComponents()[0].remove.emit();

      expect(component.modules).toEqual([]);
      expect(dashboardLayoutServiceMock.scheduleSave).toHaveBeenCalledTimes(1);
      expect(dashboardLayoutServiceMock.scheduleSave.mock.calls[0][0]).toEqual(
        []
      );
    });

    it('should report a layout change when a module is dropped onto an empty cell', async () => {
      await createCanvas();
      paint();

      dropOnEmptyCell(DashboardModuleType.HOLDINGS, { x: 3, y: 5 });

      // The cell comes from the candidate the engine had already positioned under the
      // pointer; the size comes from the definition. Neither is computed here.
      expect(placedGeometry()).toEqual([
        {
          cols: 6,
          moduleType: DashboardModuleType.HOLDINGS,
          rows: 4,
          x: 3,
          y: 5
        }
      ]);
      expect(dashboardLayoutServiceMock.scheduleSave).toHaveBeenCalledTimes(1);
    });

    it('should read the drop payload from the text/plain key', async () => {
      await createCanvas();
      paint();

      const getData = dropOnEmptyCell(DashboardModuleType.HOLDINGS);

      // Frozen contract with the catalog row, which writes the bare kebab-case
      // discriminator under exactly this key. It is the one transfer key a browser
      // still exposes while a drag is merely hovering, which is when the engine
      // inspects the payload.
      expect(getData).toHaveBeenCalledWith('text/plain');
      expect(component.modules).toHaveLength(1);
    });

    it('should report a layout change from each of the grid four change triggers', async () => {
      await createCanvas({ layout: of(singleModuleLayout) });
      paint();

      const [itemComponent] = gridsterItemComponents();
      const callbacks = gridChangeCallbacks();

      // Drag, resize, add and remove - the complete set, and no fifth. Every one of
      // them is declared in the grid configuration rather than as a template binding,
      // which is what keeps a module component from ever reaching a save path.
      expect(callbacks).toHaveLength(4);

      for (const callback of callbacks) {
        expect(typeof callback).toBe('function');

        callback(component.modules[0], itemComponent);
      }

      expect(dashboardLayoutServiceMock.scheduleSave).toHaveBeenCalledTimes(4);
    });

    it('should hand the layout service the one array it owns', async () => {
      await createCanvas({ layout: of(singleModuleLayout) });
      paint();

      const ownedArray = component.modules;
      const [itemComponent] = gridsterItemComponents();

      component.options.itemChangeCallback(ownedArray[0], itemComponent);
      moduleHostComponents()[0].remove.emit();

      // Identity on every call, and the same identity before and after a mutation.
      // Exactly one array describes where every module sits, it is mutated in place
      // because the engine writes coordinates straight onto the objects inside it, and
      // there is no second copy anywhere for the two to disagree about.
      expect(component.modules).toBe(ownedArray);
      expect(dashboardLayoutServiceMock.scheduleSave.mock.calls).toHaveLength(
        2
      );

      for (const [reported] of dashboardLayoutServiceMock.scheduleSave.mock
        .calls) {
        expect(reported).toBe(ownedArray);
      }
    });

    it('should never write the layout itself', async () => {
      await createCanvas({ layout: of(singleModuleLayout) });
      paint();

      const [itemComponent] = gridsterItemComponents();

      component.options.itemResizeCallback(component.modules[0], itemComponent);
      dropOnEmptyCell(DashboardModuleType.MARKETS, { x: 6, y: 0 });
      moduleHostComponents()[0].remove.emit();

      // Scheduling is the whole of the canvas's involvement. The debounce, the
      // projection onto the wire shape and the request itself all belong to the layout
      // service, which is the single origin of the write - so the http facade must stay
      // untouched from here even though it is reachable in this injector.
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

      // Removal is located by identity rather than by discriminator, because the item
      // handed back is the very object the engine has been maintaining. An item that is
      // not in the array cannot be removed from it, and reporting a change would
      // schedule a write of an arrangement nobody altered.
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
      // the viewer had saved. The arrangement is deliberately left in the array for the
      // same reason.
      expect(component.isSignedOut).toBe(true);
      expect(dashboardLayoutServiceMock.scheduleSave).not.toHaveBeenCalled();
      expect(component.modules).toHaveLength(1);
    });

    it('should report nothing before the canvas has finished initializing', async () => {
      await createCanvas({ viewer: undefined, viewerRequest: EMPTY });
      paint();

      revealModuleSubject.next(DashboardModuleType.HOLDINGS);

      // An intent that arrives before the saved arrangement has been applied must not
      // place anything, because doing so would then be overwritten by the arrangement -
      // and would have scheduled a write of a state that never existed.
      expect(component.isInitialized).toBe(false);
      expect(component.modules).toEqual([]);
      expect(dashboardLayoutServiceMock.scheduleSave).not.toHaveBeenCalled();
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

      // A feature component that used to send the viewer to another screen now
      // publishes an intent instead. It never learns that a canvas exists, which is
      // what keeps the dependency pointing one way only.
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

      // Nobody has answered who the viewer is, so nothing is known about what they may
      // see - and an unknown entitlement is not an entitlement. Reading the permissions
      // of a viewer who does not exist yet has to withhold the module rather than fault.
      expect(component.modules).toEqual([]);
    });

    it('should not fault when revealing a module the grid has not drawn yet', async () => {
      await createCanvas();
      paint();

      jest
        .spyOn(gridsterComponent(), 'getNextPossiblePosition')
        .mockReturnValue(true);

      // Placed and deliberately left unpainted, so the grid holds no cell for it. A
      // second request to reveal it therefore finds the module in the arrangement but
      // finds no element to bring into view, which is exactly the window between a
      // module being added and the grid drawing it.
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

      // Deliberately unpainted: the arrangement is already applied, because that
      // happens while the canvas is being constructed, but no grid exists yet to be
      // asked for an element. A document with no layout engine implements neither the
      // lookup nor the scroll, which is why both are reached optionally.
      expect(() =>
        revealModuleSubject.next(DashboardModuleType.HOLDINGS)
      ).not.toThrow();

      expect(component.modules).toHaveLength(1);
      expect(scrollIntoViewMock).not.toHaveBeenCalled();
      expect(dashboardLayoutServiceMock.scheduleSave).not.toHaveBeenCalled();
    });
  });

  describe('a failed read of the saved arrangement', () => {
    it('should mark the canvas ready without opening the catalog', async () => {
      await createCanvas({
        layout: throwError(() => new Error('service unavailable'))
      });

      // A failed read is not an empty arrangement and must not be reported as one:
      // doing so would open the catalog as though this were a first visit, telling a
      // returning viewer their canvas is new when in fact it merely could not be
      // fetched.
      expect(component.isInitialized).toBe(true);
      expect(component.isCatalogOpen).toBe(false);

      paint();

      expect(queryElement('mat-sidenav.mat-drawer-opened')).toBeNull();
      expect(queryElement('gridster')).toBeTruthy();
    });

    it('should report no layout change after a failed read', async () => {
      await createCanvas({
        layout: throwError(() => new Error('service unavailable'))
      });
      paint();

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

      // The layout store caches on its slice being defined rather than on it being
      // truthy, so a cached absence belonging to the previous viewer would otherwise be
      // served to whoever just signed in - and served as "no saved arrangement", which
      // is precisely the state that opens the catalog. Signing in with an access token
      // reaches this path with no navigation at all, because the root route is already
      // the active one.
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

      // The store is primed before anything has been fetched, and an emission with no
      // state is neither a viewer nor an absence. Concluding either from it would be
      // wrong, so nothing is concluded.
      expect(() => userServiceMock.stateChanged.next(null)).not.toThrow();

      expect(component.isSignedOut).toBe(false);
      expect(component.isInitialized).toBe(true);
      expect(dashboardLayoutServiceMock.get).toHaveBeenCalledTimes(1);
    });

    it('should not read the arrangement again for another emission about the same viewer', async () => {
      await createCanvas();
      paint();

      // The store emits for reasons that have nothing to do with the arrangement - a
      // settings write, a refreshed subscription - and refetching on each of those
      // would be a request per unrelated change.
      userServiceMock.stateChanged.next({ user: signedInViewer });
      userServiceMock.stateChanged.next({ user: { ...signedInViewer } });

      expect(dashboardLayoutServiceMock.get).toHaveBeenCalledTimes(1);
    });
  });

  describe('the catalog trigger', () => {
    it('should pad the document for its lifetime and stop padding it on destroy', async () => {
      await createCanvas();
      paint();

      // Companion of the global rule that positions the floating trigger: it pads the
      // document so the trigger never sits on top of the end of the canvas. Asserted
      // inside this test body rather than afterwards, because the harness destroys the
      // fixture between tests and that destruction is what removes the class.
      expect(document.body.classList.contains('has-fab')).toBe(true);

      fixture.destroy();

      expect(document.body.classList.contains('has-fab')).toBe(false);
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

      // The notice's own action is the other way back to the catalog, and it only ever
      // opens the panel rather than toggling it.
      expect(component.isCatalogOpen).toBe(true);
      expect(queryElement('mat-sidenav.mat-drawer-opened')).toBeTruthy();
    });

    it('should follow the drawer when it closes itself', async () => {
      await createCanvas();
      paint();

      // The library closes a drawer on Escape without being asked, and a viewer who
      // dismissed the panel that way would otherwise leave this flag - and with it the
      // trigger's glyph and its expanded state - claiming the panel was still open.
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

  describe('architectural invariants', () => {
    it('should take nothing in and report nothing out', async () => {
      await createCanvas();
      paint();

      const mirror = reflectComponentType(GfDashboardCanvasComponent);

      // The router mounts this component and hands it nothing, which is the structural
      // form of "the canvas is the root". An input or an output here would mean
      // something above it was composing it, and there is nothing above it.
      expect(mirror.selector).toBe('gf-dashboard-canvas');
      expect(mirror.inputs).toEqual([]);
      expect(mirror.outputs).toEqual([]);
    });

    it('should render no in-application address', async () => {
      await createCanvas();
      paint();

      // The URL no longer selects a screen, so there is nothing here to link to. No
      // route markup, no link directive and no route constant is named anywhere in this
      // file either - and the router mock provided to this suite is asserted against
      // rather than exercised, so a canvas that started navigating would be caught by
      // the navigation tests rather than pass quietly here.
      expect(queryElements('a')).toHaveLength(0);
      expect(queryElement('[href]')).toBeNull();
      expect(queryElement('router-outlet')).toBeNull();
    });

    it('should hand the grid the shared minimum-footprint predicate', async () => {
      await createCanvas();
      paint();

      // Identity with the function this file asserts in isolation at the top. That is
      // what closes the loop: the pure suite proves the predicate rejects an undersized
      // placement, and this proves the engine the canvas configures is consulting that
      // very predicate rather than an inline copy of it that could drift.
      expect(component.options.itemValidateCallback).toBe(itemValidateCallback);
    });
  });
});
