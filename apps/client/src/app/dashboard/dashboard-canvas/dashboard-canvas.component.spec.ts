import { GfPublicPortfolioComponent } from '@ghostfolio/client/components/public-portfolio/public-portfolio.component';
import { DashboardIntentService } from '@ghostfolio/client/core/dashboard-intent.service';
import { TokenStorageService } from '@ghostfolio/client/services/token-storage.service';
import { UserService } from '@ghostfolio/client/services/user/user.service';
import type { UserDashboardLayout } from '@ghostfolio/common/interfaces';
import { permissions } from '@ghostfolio/common/permissions';
import { DataService } from '@ghostfolio/ui/services';

import { HttpErrorResponse } from '@angular/common/http';
import {
  Component,
  EventEmitter,
  Input,
  Output,
  reflectComponentType
} from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { ActivatedRoute, Router } from '@angular/router';
import { Gridster, GridsterItem } from 'angular-gridster2';
import type { GridsterItemConfig } from 'angular-gridster2';
import { StatusCodes } from 'http-status-codes';
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
import { itemValidateCallback } from './dashboard-canvas.config';
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

@Component({ selector: 'gf-module-catalog', template: '' })
class GfTestModuleCatalogComponent {
  @Output() public moduleAdded = new EventEmitter<DashboardModuleType>();
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

  it('should reject a placement that declares no minimum at all', () => {
    // Both members are optional on a grid item, and the predicate substitutes
    // nothing for an absent one: `4 >= undefined` is `false`, so a candidate that
    // presents no contract is rejected however large it is. That is the point
    // rather than an oversight - admitting such a candidate on the grid's own
    // floor is exactly how a module whose registry entry asks for more than 2x2
    // would slip in below what it declared - and it is why the canvas copies the
    // registry minimums onto every item it mints. The library's own drag-over
    // candidate is the one thing that cannot present a contract, and the
    // configuration keeps it away from this predicate with
    // `enableOccupiedCellDrop` rather than by loosening the comparison; the
    // assertion below pins that.
    expect(itemValidateCallback({ cols: 4, rows: 4, x: 0, y: 0 })).toBe(false);
    expect(itemValidateCallback({ cols: 12, rows: 12, x: 0, y: 0 })).toBe(
      false
    );
    expect(
      itemValidateCallback({ cols: 4, minItemCols: 2, rows: 4, x: 0, y: 0 })
    ).toBe(false);
    expect(
      itemValidateCallback({ cols: 4, minItemRows: 2, rows: 4, x: 0, y: 0 })
    ).toBe(false);
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
 * this file - please do not add one to "fix" a failure, because the URL no longer
 * selects a screen.
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
  let originalScrollIntoViewDescriptor: PropertyDescriptor;
  let registryServiceMock: { get: jest.Mock; getAll: jest.Mock };
  let revealModuleSubject: Subject<DashboardModuleType>;
  let routerMock: { navigate: jest.Mock<Promise<boolean>, []> };
  let saveErrorSubject: BehaviorSubject<boolean>;
  let scrollIntoViewMock: jest.Mock;
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
      navigate: jest.fn(() => {
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
   * These are therefore the tests for the *second* time the gate closes. Without
   * them, deleting the navigation chrome would have replaced a permanent gate
   * with one that only ever screens once, and the module it used to hide would
   * stay on screen for the rest of the session.
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
      paint();

      expect(queryElement('gf-public-portfolio')).toBeTruthy();

      expect(queryElement('gf-dashboard-toolbar')).toBeNull();
      expect(queryElement('gridster')).toBeNull();
      expect(queryElement('gf-module-catalog')).toBeNull();
      expect(queryElement('gf-sign-in-prompt')).toBeNull();
      expect(queryElement('.gf-dashboard-catalog-trigger')).toBeNull();
    });

    it('should let a shared link win over the viewer own session', async () => {
      await createCanvas({ queryParams: { accessId: 'abc' } });
      paint();

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
      // no arrangement and none of its four states matching - a blank screen for
      // anyone who followed a share link and then dismissed it.
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

    it('should issue no navigation when no jwt is present', async () => {
      // Permitted and then not used: this is the assertion that the clean-up is
      // conditional rather than unconditional, so the capability has to be
      // available for its absence to mean anything.
      await createCanvas({
        allowsNavigation: true,
        queryParams: { holdingDetailDialog: 'true' }
      });
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

      // Rule 2 in its structural form: one array, one item object per cell, mutated
      // in place by the engine. A canvas that answered a step by rebuilding either
      // would remount every module on the grid and lose the engine's own handle on
      // the item it was told to move.
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
      // candidate carries no per-item minimums, so with the screen in place the strict
      // minimum predicate would reject it and `emptyCellDropCallback` would never be
      // reached - drag-to-add would be silently dead in every browser while every other
      // assertion in this file still passed. Reaching the canvas at all is therefore the
      // point of it.
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
      // tell a restored module from an added one, which is why it is left off: a
      // returning viewer's canvas must not scroll as it loads.
      expect(scrollIntoViewMock).not.toHaveBeenCalled();
      expect(component.options.scrollToNewItems).toBe(false);

      moduleCatalogComponent().moduleAdded.emit(DashboardModuleType.MARKETS);
      paint();

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

        // Both would previously have been walked straight into: the first throws
        // while it is iterated, inside the success handler of the read - the one
        // place a failure must not surface, because the canvas has already
        // concluded the read succeeded - and the second would let this build
        // rewrite a document a newer one wrote, in an older shape.
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

  describe('the catalog trigger', () => {
    it('should pad the document for its lifetime and stop padding it on destroy', async () => {
      await createCanvas();
      paint();

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

    it('should keep the drop path reachable without loosening that predicate', async () => {
      await createCanvas();
      paint();

      // These two options are a pair and must be read as one. The library screens its
      // own drag-over candidate with
      // `if (!$options.enableOccupiedCellDrop && checkCollision(item))`, and that
      // candidate carries no per-item minimums, so the strict predicate above would
      // reject it, the browser would be told `dropEffect = 'none'` and drag-to-add
      // would be unreachable in every browser. Enabling occupied-cell drop takes the
      // screen out of the drop path instead of taking the strictness out of the
      // predicate; the item the canvas appends in response does carry its minimums and
      // is validated in the ordinary way through `addItem`.
      expect(component.options.enableEmptyCellDrop).toBe(true);
      expect(component.options.enableOccupiedCellDrop).toBe(true);
    });
  });
});
