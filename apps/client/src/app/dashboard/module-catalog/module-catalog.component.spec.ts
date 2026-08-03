import { UserService } from '@ghostfolio/client/services/user/user.service';
import { permissions } from '@ghostfolio/common/permissions';

import { A, DOWN_ARROW, ENTER, UP_ARROW } from '@angular/cdk/keycodes';
import { Component, reflectComponentType } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
// The catalog marks its static strings for translation and the shared metadata it
// is typed against reads its own display names the same way, both of which
// compile to `$localize` calls evaluated at module scope. Nothing installs that
// global in a jsdom test environment - `apps/client/src/polyfills.ts` installs it
// for the application and no test setup file stands in for that - so it is
// installed here.
//
// Its position is load-bearing rather than cosmetic, and it constrains the two
// groups around it. Prettier sorts imports into `@ghostfolio/*`, then third
// party, then relative, and it sorts side-effect imports along with the rest, so
// this statement can never precede the `@ghostfolio/*` group above. Two
// consequences follow, both of them measured rather than assumed:
//
//  - the module type enum is reached through the relative group below, which is
//    evaluated after this line. `../enums/dashboard-module-type` re-exports the
//    very same symbol from `@ghostfolio/common/dashboard` - it is neither a deep
//    path into the shared library nor a relative path into `libs/` - whereas
//    naming that shared entry point directly up in the first group would
//    evaluate the metadata map before `$localize` exists;
//  - the user service really is named through its workspace alias in the first
//    group, which is only viable because the dialog that drags the shared route
//    metadata in behind it is cut below.
import '@angular/localize/init';
import { By } from '@angular/platform-browser';
import { BehaviorSubject } from 'rxjs';

import { DashboardModuleType } from '../enums/dashboard-module-type';
import type { DashboardModuleDefinition } from '../interfaces/interfaces';
import { DashboardModuleRegistryService } from '../module-registry.service';
import { GfModuleCatalogItemComponent } from './module-catalog-item/module-catalog-item.component';
import { GfModuleCatalogComponent } from './module-catalog.component';

// Cuts the one import chain that would otherwise evaluate the shared route
// metadata - and therefore call `$localize` - before the global above is
// installed: the user service holds a reference to this dialog so that it can
// hand the class to `MatDialog.open`. Nothing real is faked by replacing it. The
// user service itself is supplied to the catalog as a stub, so neither the dialog
// nor the code path that opens it is reachable from this spec at all.
jest.mock(
  '@ghostfolio/client/components/subscription-interstitial-dialog/subscription-interstitial-dialog.component',
  () => ({ GfSubscriptionInterstitialDialogComponent: class {} })
);

/**
 * The shape of the viewer state the catalog actually reads.
 *
 * Deliberately narrower than the real store's state. The catalog reads exactly
 * one path out of it - the current viewer's permissions - so describing that path
 * and nothing else keeps the harness from implying a dependency on the rest of a
 * user object. Both levels are optional because both are genuinely absent at
 * times: the store primes itself with no viewer before the fetch that replaces
 * it resolves.
 */
interface CatalogViewerState {
  user?: { permissions?: string[] };
}

/**
 * A stand-in for the browser's drag data store.
 *
 * Hand-rolled rather than a real `DataTransfer`, because jsdom's support for that
 * interface is partial and a drag payload is only ever observed through the two
 * members below.
 */
interface DataTransferStub {
  effectAllowed: string;
  setData: jest.Mock;
}

/**
 * Stands in for the dashboard canvas.
 *
 * The catalog's `moduleAdded` output is declared `protected`, which is the
 * component saying that it exists to be bound from a template rather than read
 * off the class. Honouring that is not pedantry here - binding it exactly as the
 * canvas does is what proves the outward contract the canvas depends on, and it
 * lets every emission be counted precisely without a type assertion anywhere.
 *
 * Collecting into an array rather than a spy is deliberate too: it makes "exactly
 * once" and "in this order" the same assertion.
 */
@Component({
  imports: [GfModuleCatalogComponent],
  selector: 'gf-test-module-catalog-host',
  template: '<gf-module-catalog (moduleAdded)="onModuleAdded($event)" />'
})
class GfTestModuleCatalogHostComponent {
  public readonly addedModuleTypes: DashboardModuleType[] = [];

  public onModuleAdded(moduleType: DashboardModuleType) {
    this.addedModuleTypes.push(moduleType);
  }
}

/**
 * Unit specification for the searchable dashboard module catalog.
 *
 * The catalog answers one question - which modules may this viewer add, and which
 * of those match what is being searched for - and reports one thing: that a
 * module type was chosen. Almost every test below is therefore about narrowing
 * (by permission, then by term) or about that single emission.
 *
 * Four properties of this harness are load-bearing, and each was established by
 * measurement rather than convention:
 *
 * **The registry is stubbed, and it hands back everything.** The real service
 * builds its map from the application-side registration table, so constructing it
 * would pull all twenty-one module component trees into this compilation and
 * quietly undo the lazy boundary the registry exists to hold. More importantly,
 * the real service does not hide entries from a viewer - narrowing to the current
 * viewer is the catalog's own job - so the stub returns the gated definitions
 * too. A stub that pre-filtered would make every permission test below vacuous.
 *
 * **Fake timers are installed before the component is created, not inside each
 * test.** The catalog seeds its own search stream during initialization, and that
 * seed travels through the same debounce every later term does. `debounceTime`
 * only schedules a new task while it has none pending, so a seed task created
 * outside the fake time domain never fires, stays pending, and silently swallows
 * every subsequent term - which looks exactly like a search that does not work.
 * Installing Jest's fake timers first puts the seed task in the same clock the
 * tests advance, and `afterEach` hands the real timers back.
 *
 * **Keyboard events carry an explicit `keyCode`.** The CDK key manager the
 * catalog delegates to switches on the legacy `keyCode`, which jsdom leaves at
 * zero for an event constructed from `key` alone, so an event built the obvious
 * way reaches the component and then does nothing. The codes come from the CDK's
 * own constants so that the spec compares against the same values the key manager
 * does.
 *
 * **No router and no persistence collaborator is provided, and none is needed.**
 * That absence is the assertion, so please do not "fix" a future failure by
 * adding either one. The URL no longer selects a screen, so a catalog that
 * reached for a router API would fail to instantiate here; and saving an
 * arrangement is triggered only by grid state changing on the canvas, so a
 * catalog that reached for a data service, an HTTP client or the layout store
 * would fail here too. Both are structural properties of this harness rather than
 * claims made in a comment.
 */
describe('GfModuleCatalogComponent', () => {
  /**
   * The debounce window the catalog applies to its search term. Named so the
   * boundary either side of it - held at one millisecond less, applied at exactly
   * this value - is legible as one contract rather than two magic numbers.
   */
  const debounceInMilliseconds = 300;

  let catalogElement: HTMLElement;
  let component: GfModuleCatalogComponent;
  let definitions: DashboardModuleDefinition[];
  let fixture: ComponentFixture<GfTestModuleCatalogHostComponent>;
  let handedOutDefinitions: DashboardModuleDefinition[][];
  let host: GfTestModuleCatalogHostComponent;
  let originalScrollIntoViewDescriptor: PropertyDescriptor;
  let registryServiceMock: { getAll: jest.Mock };
  let scrollIntoViewMock: jest.Mock;
  let userServiceMock: { stateChanged: BehaviorSubject<CatalogViewerState> };

  /**
   * The registered modules this spec exercises: three that declare no permission
   * and one behind each of the three permissions the real registry actually uses.
   *
   * Built fresh per test so that the loader assertions cannot leak between tests.
   * Every loader is a mock that must never be called - listing a module's name
   * must not fetch its component - and the display names are the real ones, which
   * is what makes the search assertions meaningful rather than arbitrary.
   *
   * `markets` is present specifically because it declares no permission while
   * `markets-premium` shares its display name and does declare one. That pairing
   * is the difference between a viewer who may see a free module and one who may
   * see both.
   *
   * The four dimension members exist only to satisfy the shared contract. Nothing
   * below reads them, and nothing below should: a module's footprint belongs to
   * the grid, and the catalog neither renders nor emits it.
   */
  const createDefinitions = (): DashboardModuleDefinition[] => {
    return [
      {
        defaultItemCols: 6,
        defaultItemRows: 6,
        loadComponent: jest.fn(),
        minItemCols: 4,
        minItemRows: 4,
        moduleType: DashboardModuleType.HOLDINGS,
        name: 'Holdings'
      },
      {
        defaultItemCols: 4,
        defaultItemRows: 4,
        loadComponent: jest.fn(),
        minItemCols: 3,
        minItemRows: 3,
        moduleType: DashboardModuleType.MARKETS,
        name: 'Markets'
      },
      {
        defaultItemCols: 6,
        defaultItemRows: 5,
        loadComponent: jest.fn(),
        minItemCols: 4,
        minItemRows: 3,
        moduleType: DashboardModuleType.WATCHLIST,
        name: 'Watchlist'
      },
      {
        defaultItemCols: 8,
        defaultItemRows: 6,
        loadComponent: jest.fn(),
        minItemCols: 4,
        minItemRows: 4,
        moduleType: DashboardModuleType.ADMIN_USERS,
        name: 'Users',
        permission: permissions.accessAdminControl
      },
      {
        defaultItemCols: 5,
        defaultItemRows: 6,
        loadComponent: jest.fn(),
        minItemCols: 3,
        minItemRows: 4,
        moduleType: DashboardModuleType.AI_CHAT,
        name: 'AI Chat',
        permission: permissions.readAiPrompt
      },
      {
        defaultItemCols: 8,
        defaultItemRows: 6,
        loadComponent: jest.fn(),
        minItemCols: 4,
        minItemRows: 4,
        moduleType: DashboardModuleType.MARKETS_PREMIUM,
        name: 'Markets',
        permission: permissions.readMarketDataOfMarkets
      }
    ];
  };

  beforeEach(async () => {
    // First, and before the component exists: see the note on fake timers in the
    // suite documentation above.
    jest.useFakeTimers();

    // jsdom implements no `scrollIntoView`, so the key manager's call would throw
    // rather than merely do nothing. The descriptor is captured rather than the
    // method itself so that whatever was there - including nothing at all - can
    // be put back exactly as it was.
    originalScrollIntoViewDescriptor = Object.getOwnPropertyDescriptor(
      Element.prototype,
      'scrollIntoView'
    );
    scrollIntoViewMock = jest.fn();
    Element.prototype.scrollIntoView = scrollIntoViewMock;

    definitions = createDefinitions();
    handedOutDefinitions = [];

    registryServiceMock = {
      getAll: jest.fn(() => {
        // A fresh array of fresh objects on every call, mirroring the real
        // service. Handing back the same mutable array would hide a catalog that
        // sorted or spliced what it was given, so each array is kept and checked
        // afterwards. The loader is copied by reference on purpose: that is what
        // lets the "no loader was ever called" assertion reach the mocks above.
        const handedOut = definitions.map((definition) => {
          return { ...definition };
        });

        handedOutDefinitions.push(handedOut);

        return handedOut;
      })
    };

    // Seeded with the state the real store primes itself with, so the very first
    // frame is rendered for a viewer who has not resolved yet.
    userServiceMock = {
      stateChanged: new BehaviorSubject<CatalogViewerState>({ user: undefined })
    };

    await TestBed.configureTestingModule({
      imports: [GfModuleCatalogComponent],
      providers: [
        {
          provide: DashboardModuleRegistryService,
          useValue: registryServiceMock
        },
        { provide: UserService, useValue: userServiceMock }
      ]
    }).compileComponents();

    fixture = TestBed.createComponent(GfTestModuleCatalogHostComponent);
    host = fixture.componentInstance;

    fixture.detectChanges();

    component = fixture.debugElement
      .query(By.directive(GfModuleCatalogComponent))
      .injector.get(GfModuleCatalogComponent);
    catalogElement = queryElement('gf-module-catalog');
  });

  afterEach(() => {
    // Restored rather than left behind: a leaked fake clock or a patched
    // prototype poisons every later spec in the run, and does so somewhere else.
    if (originalScrollIntoViewDescriptor) {
      Object.defineProperty(
        Element.prototype,
        'scrollIntoView',
        originalScrollIntoViewDescriptor
      );
    } else {
      Reflect.deleteProperty(Element.prototype, 'scrollIntoView');
    }

    jest.useRealTimers();
  });

  /**
   * Advances the fake clock and then lets the view catch up.
   *
   * Both halves are required. The results arrive from a stream rather than from a
   * template-triggered check, and the catalog is `OnPush`, so without the second
   * half a correct component looks broken.
   */
  function advance(milliseconds = debounceInMilliseconds) {
    jest.advanceTimersByTime(milliseconds);

    fixture.detectChanges();
  }

  /** Publishes a new viewer and lets the view catch up. */
  function emitViewerState(state: CatalogViewerState) {
    userServiceMock.stateChanged.next(state);

    fixture.detectChanges();
  }

  function queryElement<T extends HTMLElement>(selector: string) {
    return (fixture.nativeElement as HTMLElement).querySelector<T>(selector);
  }

  function queryElements<T extends HTMLElement>(selector: string) {
    return Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll<T>(selector)
    );
  }

  /** The rendered rows as component instances, in display order. */
  function rowComponents() {
    return fixture.debugElement
      .queryAll(By.directive(GfModuleCatalogItemComponent))
      .map((debugElement) => {
        return debugElement.injector.get(GfModuleCatalogItemComponent);
      });
  }

  /**
   * The actionable element of each rendered row.
   *
   * The row binds its click and its drag to an element inside itself rather than
   * to its own host, so an interaction has to be dispatched there to travel the
   * path a real one takes.
   */
  function rowElements() {
    return queryElements('gf-module-catalog-item mat-card');
  }

  /** The display names on screen, in render order. */
  function renderedModuleNames() {
    return queryElements('gf-module-catalog-item').map((row) => {
      return row.textContent.trim();
    });
  }

  /** The module types the component is currently displaying, in display order. */
  function displayedModuleTypes() {
    return component.modules.map(({ moduleType }) => {
      return moduleType;
    });
  }

  /** The index of every row that currently holds the roving focus. */
  function focusedRowIndexes() {
    return rowComponents().reduce<number[]>((indexes, row, index) => {
      // Read as a property, never called: the row exposes its focus state as a
      // getter, and invoking it would be truthy for every row.
      return row.getHasFocus ? [...indexes, index] : indexes;
    }, []);
  }

  function setSearchTerm(searchTerm: string) {
    component.searchFormControl.setValue(searchTerm);
  }

  /**
   * Dispatches a keystroke on the catalog's own host element.
   *
   * The listener is host-scoped rather than document-scoped - the catalog owns no
   * open state to gate a document listener on - so dispatching on `document`
   * would never reach it.
   *
   * @returns The dispatched event, so a test can assert whether the default
   * action was suppressed.
   */
  function dispatchKeydown(key: string, keyCode: number) {
    const event = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key
    });

    // See the note on `keyCode` in the suite documentation. Defining the property
    // on the instance shadows the prototype accessor jsdom derives from `key`,
    // and needs no type assertion to do it.
    Object.defineProperty(event, 'keyCode', { get: () => keyCode });

    catalogElement.dispatchEvent(event);

    fixture.detectChanges();

    return event;
  }

  function createDataTransferStub(): DataTransferStub {
    return { effectAllowed: '', setData: jest.fn() };
  }

  /**
   * Starts a native drag on a row, optionally without a transfer object.
   *
   * Dispatched as a real event through the row's own template binding rather than
   * by calling the handler, so the wiring is exercised as well as the payload.
   */
  function dispatchDragStart(
    row: HTMLElement,
    dataTransfer?: DataTransferStub
  ) {
    const event = new Event('dragstart', { bubbles: true });

    if (dataTransfer) {
      Object.defineProperty(event, 'dataTransfer', { get: () => dataTransfer });
    }

    row.dispatchEvent(event);

    fixture.detectChanges();
  }

  describe('initial rendering', () => {
    it('should create', () => {
      expect(component).toBeTruthy();
    });

    it('should offer every module the viewer is allowed to see', () => {
      advance();

      expect(displayedModuleTypes()).toEqual([
        DashboardModuleType.HOLDINGS,
        DashboardModuleType.MARKETS,
        DashboardModuleType.WATCHLIST
      ]);
      expect(rowElements()).toHaveLength(3);
    });

    it('should take its contents from the module registry and nowhere else', () => {
      advance();

      expect(registryServiceMock.getAll).toHaveBeenCalledTimes(1);
    });

    it('should fill the list on the first frame, before the debounce elapses', () => {
      // The catalog opens by itself for a viewer with no saved layout, so it
      // cannot afford to be blank for the length of its own debounce window. It
      // avoids that by narrowing once, synchronously, when the viewer arrives -
      // which is why no clock has been advanced at this point.
      expect(renderedModuleNames()).toEqual([
        'Holdings',
        'Markets',
        'Watchlist'
      ]);
    });

    it('should render nothing but the display name on a row', () => {
      advance();

      // Exact equality rather than a substring match, because it is also the
      // assertion that no cell dimension reaches the screen: a module's footprint
      // belongs to the grid, and every fixture above declares one.
      expect(renderedModuleNames()).toEqual([
        'Holdings',
        'Markets',
        'Watchlist'
      ]);
      expect(rowElements()[0].textContent).not.toMatch(/\d/);
    });

    it('should announce the results as a list of items', () => {
      advance();

      expect(queryElement('[role="list"]')).toBeTruthy();
      expect(queryElements('[role="listitem"]')).toHaveLength(3);
    });

    it('should render a search field bound to its own control', () => {
      advance();

      const searchField = queryElement<HTMLInputElement>('input[matInput]');

      expect(queryElement('mat-form-field')).toBeTruthy();
      expect(searchField).toBeTruthy();
      expect(searchField.value).toBe('');
    });
  });

  describe('search', () => {
    it('should narrow the list to the matching module once the debounce elapses', () => {
      advance();

      setSearchTerm('Hold');
      advance();

      expect(displayedModuleTypes()).toEqual([DashboardModuleType.HOLDINGS]);
      expect(renderedModuleNames()).toEqual(['Holdings']);
    });

    it('should hold the previous results until the debounce window closes', () => {
      advance();

      setSearchTerm('Hold');

      advance(debounceInMilliseconds - 1);

      // One millisecond short of the window: still the full list, and - just as
      // importantly - not yet an empty one, because emptying the list early is
      // what would make the no-results notice flash between keystrokes.
      expect(renderedModuleNames()).toEqual([
        'Holdings',
        'Markets',
        'Watchlist'
      ]);
      expect(queryElement('.no-results')).toBeNull();

      advance(1);

      expect(renderedModuleNames()).toEqual(['Holdings']);
    });

    it('should restore the full eligible list when the term is cleared', () => {
      advance();

      setSearchTerm('Hold');
      advance();

      expect(renderedModuleNames()).toEqual(['Holdings']);

      setSearchTerm('');
      advance();

      expect(renderedModuleNames()).toEqual([
        'Holdings',
        'Markets',
        'Watchlist'
      ]);
    });

    it('should match a display name regardless of case', () => {
      advance();

      setSearchTerm('hold');
      advance();

      expect(displayedModuleTypes()).toEqual([DashboardModuleType.HOLDINGS]);
    });

    it('should treat a whitespace-only term as no term at all', () => {
      advance();

      setSearchTerm('   ');
      advance();

      expect(renderedModuleNames()).toEqual([
        'Holdings',
        'Markets',
        'Watchlist'
      ]);
      expect(queryElement('.no-results')).toBeNull();
    });

    it('should search display names only, never module type discriminators', () => {
      emitViewerState({
        user: { permissions: [permissions.accessAdminControl] }
      });
      advance();

      setSearchTerm('Users');
      advance();

      expect(displayedModuleTypes()).toEqual([DashboardModuleType.ADMIN_USERS]);

      // The very same module, searched for by the discriminator that is persisted
      // in a saved layout rather than by the name on its row. A viewer searches
      // for what is on screen, so this has to find nothing.
      setSearchTerm('admin-users');
      advance();

      expect(displayedModuleTypes()).toEqual([]);
    });

    it('should not recompute results for a term that normalises unchanged', () => {
      advance();

      setSearchTerm('Hold');
      advance();

      const narrowedResults = component.modules;

      // Trailing whitespace is trimmed before the distinctness check, so this is
      // the same term arriving twice. A recomputation would replace the array;
      // holding the identical reference is what proves it did not happen.
      setSearchTerm('Hold  ');
      advance();

      expect(component.modules).toBe(narrowedResults);
      expect(renderedModuleNames()).toEqual(['Holdings']);
    });

    it('should narrow to the newest term when several are typed inside one window', () => {
      advance();

      setSearchTerm('Hold');
      advance(100);

      setSearchTerm('Watch');
      advance(debounceInMilliseconds);

      // Only the last term is answered, and it is answered once.
      expect(displayedModuleTypes()).toEqual([DashboardModuleType.WATCHLIST]);
    });
  });

  describe('permission filtering', () => {
    it('should always offer a module that declares no permission', () => {
      emitViewerState({ user: { permissions: [] } });
      advance();

      expect(displayedModuleTypes()).toEqual(
        expect.arrayContaining([
          DashboardModuleType.HOLDINGS,
          // The free markets module is named explicitly because it is the
          // designed non-premium fallback: it shares its display name with a
          // module that is gated, and it must never be gated by association.
          DashboardModuleType.MARKETS,
          DashboardModuleType.WATCHLIST
        ])
      );
    });

    it('should hide the admin, AI chat and premium modules from a viewer holding no permission', () => {
      emitViewerState({ user: { permissions: [] } });
      advance();

      const displayed = displayedModuleTypes();

      expect(displayed).not.toContain(DashboardModuleType.ADMIN_USERS);
      expect(displayed).not.toContain(DashboardModuleType.AI_CHAT);
      expect(displayed).not.toContain(DashboardModuleType.MARKETS_PREMIUM);
      expect(renderedModuleNames()).not.toContain('Users');
      expect(renderedModuleNames()).not.toContain('AI Chat');
    });

    it('should offer the admin module as soon as the viewer holds the admin permission, and no other gated module', () => {
      advance();

      expect(displayedModuleTypes()).not.toContain(
        DashboardModuleType.ADMIN_USERS
      );

      emitViewerState({
        user: { permissions: [permissions.accessAdminControl] }
      });

      const displayed = displayedModuleTypes();

      // No clock is advanced here on purpose: a viewer change re-narrows through
      // the same helper the stream uses rather than by pushing a synthetic term
      // into the form control, so the new list is on screen immediately.
      expect(displayed).toContain(DashboardModuleType.ADMIN_USERS);
      expect(displayed).not.toContain(DashboardModuleType.AI_CHAT);
      expect(displayed).not.toContain(DashboardModuleType.MARKETS_PREMIUM);
      expect(registryServiceMock.getAll).toHaveBeenCalledTimes(2);
    });

    it('should offer each gated module only to a viewer holding its own permission', () => {
      emitViewerState({
        user: {
          permissions: [permissions.readAiPrompt]
        }
      });

      expect(displayedModuleTypes()).toEqual([
        DashboardModuleType.HOLDINGS,
        DashboardModuleType.MARKETS,
        DashboardModuleType.WATCHLIST,
        DashboardModuleType.AI_CHAT
      ]);

      emitViewerState({
        user: {
          permissions: [
            permissions.accessAdminControl,
            permissions.readAiPrompt,
            permissions.readMarketDataOfMarkets
          ]
        }
      });

      // Registry order is preserved, which is what keeps the catalog's ordering
      // reviewable in a diff rather than dependent on a viewer's permissions.
      expect(displayedModuleTypes()).toEqual([
        DashboardModuleType.HOLDINGS,
        DashboardModuleType.MARKETS,
        DashboardModuleType.WATCHLIST,
        DashboardModuleType.ADMIN_USERS,
        DashboardModuleType.AI_CHAT,
        DashboardModuleType.MARKETS_PREMIUM
      ]);
    });

    it('should survive a viewer state that carries no user', () => {
      emitViewerState({
        user: { permissions: [permissions.accessAdminControl] }
      });

      expect(displayedModuleTypes()).toContain(DashboardModuleType.ADMIN_USERS);

      // The state the real store primes itself with. This workspace compiles
      // without strict null checks, so nothing but a test stands between an
      // unresolved viewer and a runtime failure here.
      expect(() => emitViewerState({ user: undefined })).not.toThrow();

      expect(displayedModuleTypes()).toEqual([
        DashboardModuleType.HOLDINGS,
        DashboardModuleType.MARKETS,
        DashboardModuleType.WATCHLIST
      ]);
    });

    it('should survive a viewer state that is absent altogether', () => {
      expect(() => emitViewerState(undefined)).not.toThrow();

      expect(displayedModuleTypes()).toEqual([
        DashboardModuleType.HOLDINGS,
        DashboardModuleType.MARKETS,
        DashboardModuleType.WATCHLIST
      ]);
    });

    it('should re-narrow against the term that is currently typed when the viewer changes', () => {
      advance();

      setSearchTerm('Users');
      advance();

      expect(displayedModuleTypes()).toEqual([]);

      emitViewerState({
        user: { permissions: [permissions.accessAdminControl] }
      });

      expect(displayedModuleTypes()).toEqual([DashboardModuleType.ADMIN_USERS]);
      expect(component.searchFormControl.value).toBe('Users');
    });
  });

  describe('adding a module', () => {
    it('should emit the chosen module type exactly once when a row is clicked', () => {
      advance();

      rowElements()[0].click();
      fixture.detectChanges();

      expect(host.addedModuleTypes).toEqual([DashboardModuleType.HOLDINGS]);
      // Counted rather than merely present: a row that reported its choice both
      // from its own click and from the parent's keyboard path would add the
      // module twice, and only a count catches that.
      expect(host.addedModuleTypes).toHaveLength(1);
      expect(host.addedModuleTypes[0]).toBe(DashboardModuleType.HOLDINGS);
    });

    it('should emit the discriminator of the row that was clicked', () => {
      advance();

      rowElements()[2].click();
      fixture.detectChanges();

      expect(host.addedModuleTypes).toEqual([DashboardModuleType.WATCHLIST]);
    });

    it('should forward a choice made through its public handler unchanged', () => {
      advance();

      component.onAddModule(DashboardModuleType.MARKETS);
      fixture.detectChanges();

      expect(host.addedModuleTypes).toEqual([DashboardModuleType.MARKETS]);
    });

    it('should leave the search term and the results untouched after adding', () => {
      advance();

      setSearchTerm('Hold');
      advance();

      rowElements()[0].click();
      fixture.detectChanges();

      // The catalog does not close itself, clear its term or drop the row: the
      // panel belongs to the canvas, and a viewer may want the same module twice.
      expect(component.searchFormControl.value).toBe('Hold');
      expect(renderedModuleNames()).toEqual(['Holdings']);
    });

    it('should let the same module be added more than once', () => {
      advance();

      rowElements()[0].click();
      fixture.detectChanges();

      rowElements()[0].click();
      fixture.detectChanges();

      expect(host.addedModuleTypes).toEqual([
        DashboardModuleType.HOLDINGS,
        DashboardModuleType.HOLDINGS
      ]);
    });

    it('should never offer a module the viewer may not add', () => {
      advance();

      setSearchTerm('AI');
      advance();

      // Nothing to click, so nothing can be emitted: the permission check runs
      // before a row exists rather than when one is actioned.
      expect(rowElements()).toHaveLength(0);
      expect(host.addedModuleTypes).toEqual([]);
    });
  });

  describe('empty search results', () => {
    it('should replace the list with a polite no-results notice', () => {
      advance();

      setSearchTerm('zzzzzzzz');
      advance();

      const notice = queryElement('.no-results');

      expect(rowElements()).toHaveLength(0);
      expect(notice).toBeTruthy();
      expect(notice.textContent.trim()).toBe('No results found...');
      // Announced without moving focus, because the list it replaces changed
      // underneath a viewer who is still typing.
      expect(notice.getAttribute('role')).toBe('status');
    });

    it('should drop the results region rather than leave it standing empty', () => {
      advance();

      setSearchTerm('zzzzzzzz');
      advance();

      // A list role with no item to own would otherwise be announced as an empty
      // list rather than as a failed search.
      expect(queryElement('[role="list"]')).toBeNull();
    });

    it('should not claim a failed search before anything has been typed', () => {
      advance();

      expect(queryElement('.no-results')).toBeNull();
    });

    it('should not claim a failed search while the term is still debouncing', () => {
      advance();

      setSearchTerm('zzzzzzzz');
      advance(debounceInMilliseconds - 1);

      expect(queryElement('.no-results')).toBeNull();
      expect(rowElements()).toHaveLength(3);

      advance(1);

      expect(queryElement('.no-results')).toBeTruthy();
    });

    it('should recover when a failing term is replaced by a matching one', () => {
      advance();

      setSearchTerm('zzzzzzzz');
      advance();

      expect(queryElement('.no-results')).toBeTruthy();

      setSearchTerm('Watch');
      advance();

      expect(queryElement('.no-results')).toBeNull();
      expect(renderedModuleNames()).toEqual(['Watchlist']);
    });
  });

  describe('keyboard navigation', () => {
    it('should move a single roving focus onto the first row on ArrowDown', () => {
      advance();

      dispatchKeydown('ArrowDown', DOWN_ARROW);

      expect(focusedRowIndexes()).toEqual([0]);
    });

    it('should scroll the newly focused row into view', () => {
      advance();

      dispatchKeydown('ArrowDown', DOWN_ARROW);

      expect(scrollIntoViewMock).toHaveBeenCalledWith({
        behavior: 'smooth',
        block: 'center'
      });
    });

    it('should step through the rows one at a time', () => {
      advance();

      dispatchKeydown('ArrowDown', DOWN_ARROW);
      dispatchKeydown('ArrowDown', DOWN_ARROW);

      expect(focusedRowIndexes()).toEqual([1]);
    });

    it('should wrap to the last row when ArrowUp is pressed on the first', () => {
      advance();

      dispatchKeydown('ArrowDown', DOWN_ARROW);
      dispatchKeydown('ArrowUp', UP_ARROW);

      // Wrapping is what keeps a short list navigable in either direction without
      // a dead end at each edge.
      expect(focusedRowIndexes()).toEqual([2]);
    });

    it('should add the focused row on Enter, exactly once', () => {
      advance();

      dispatchKeydown('ArrowDown', DOWN_ARROW);

      const event = dispatchKeydown('Enter', ENTER);

      expect(host.addedModuleTypes).toEqual([DashboardModuleType.HOLDINGS]);
      expect(host.addedModuleTypes).toHaveLength(1);
      expect(event.defaultPrevented).toBe(true);
    });

    it('should leave Enter alone when no row is focused', () => {
      advance();

      const event = dispatchKeydown('Enter', ENTER);

      // Plain Enter in the search field has to keep behaving normally, so the key
      // is neither acted on nor swallowed while nothing is highlighted.
      expect(host.addedModuleTypes).toEqual([]);
      expect(event.defaultPrevented).toBe(false);
    });

    it('should ignore ordinary text entry', () => {
      advance();

      const event = dispatchKeydown('a', A);

      expect(focusedRowIndexes()).toEqual([]);
      expect(host.addedModuleTypes).toEqual([]);
      expect(event.defaultPrevented).toBe(false);
    });

    it('should neither throw nor add anything while the result list is empty', () => {
      advance();

      setSearchTerm('zzzzzzzz');
      advance();

      expect(() => {
        dispatchKeydown('ArrowDown', DOWN_ARROW);
        dispatchKeydown('ArrowUp', UP_ARROW);
        dispatchKeydown('Enter', ENTER);
      }).not.toThrow();

      expect(host.addedModuleTypes).toEqual([]);
      expect(scrollIntoViewMock).not.toHaveBeenCalled();
    });

    it('should clear the roving focus when the results change', () => {
      advance();

      dispatchKeydown('ArrowDown', DOWN_ARROW);

      expect(focusedRowIndexes()).toEqual([0]);

      setSearchTerm('Watch');
      advance();

      // A highlighted row may not survive the next term at all, so the highlight
      // is dropped rather than carried over onto whichever row now sits there.
      expect(focusedRowIndexes()).toEqual([]);
    });

    it('should resume stepping from the top after the results change', () => {
      // A viewer entitled to everything, so that a term can narrow the list to
      // more than one row and the assertion below is about where stepping resumes
      // rather than about there being only one row left to resume onto.
      emitViewerState({
        user: {
          permissions: [
            permissions.accessAdminControl,
            permissions.readAiPrompt,
            permissions.readMarketDataOfMarkets
          ]
        }
      });
      advance();

      dispatchKeydown('ArrowDown', DOWN_ARROW);
      dispatchKeydown('ArrowDown', DOWN_ARROW);

      expect(focusedRowIndexes()).toEqual([1]);

      setSearchTerm('Market');
      advance();

      expect(renderedModuleNames()).toEqual(['Markets', 'Markets']);

      dispatchKeydown('ArrowDown', DOWN_ARROW);

      // The index the next movement is measured from is reset alongside the
      // highlight, so a step after an update starts at the first row rather than
      // resuming from a position measured against a list that no longer exists.
      expect(focusedRowIndexes()).toEqual([0]);
    });
  });

  describe('drag payload', () => {
    it('should write the bare discriminator under text/plain', () => {
      advance();

      const dataTransfer = createDataTransferStub();

      dispatchDragStart(rowElements()[0], dataTransfer);

      // `text/plain` and the bare value are both required rather than
      // incidental: it is the one transfer key a browser still exposes while a
      // drag is merely hovering, which is when the grid engine inspects the
      // payload, and the bare value is what the registry resolves against.
      expect(dataTransfer.setData).toHaveBeenCalledTimes(1);
      expect(dataTransfer.setData).toHaveBeenCalledWith(
        'text/plain',
        DashboardModuleType.HOLDINGS
      );
      expect(dataTransfer.effectAllowed).toBe('copy');
    });

    it('should write the discriminator of the row that is being dragged', () => {
      advance();

      const dataTransfer = createDataTransferStub();

      dispatchDragStart(rowElements()[2], dataTransfer);

      expect(dataTransfer.setData).toHaveBeenCalledWith(
        'text/plain',
        DashboardModuleType.WATCHLIST
      );
    });

    it('should flag the dragged row only once a payload is attached', () => {
      advance();

      dispatchDragStart(rowElements()[0], createDataTransferStub());

      expect(rowComponents()[0].isDragging).toBe(true);
    });

    it('should survive a drag event that carries no transfer object', () => {
      advance();

      expect(() => dispatchDragStart(rowElements()[0])).not.toThrow();

      // Never advertised as an active drag, because the canvas would have nothing
      // to act on when it landed.
      expect(rowComponents()[0].isDragging).toBe(false);
    });

    it('should clear the drag flag when the drag ends', () => {
      advance();

      const row = rowElements()[0];

      dispatchDragStart(row, createDataTransferStub());

      expect(rowComponents()[0].isDragging).toBe(true);

      row.dispatchEvent(new Event('dragend', { bubbles: true }));
      fixture.detectChanges();

      // `dragend` is the only dependable place to clear it: a drag can also end
      // in a cancel or outside the grid, and neither of those fires a drop.
      expect(rowComponents()[0].isDragging).toBe(false);
    });

    it('should not emit an add intent merely because a row was dragged', () => {
      advance();

      dispatchDragStart(rowElements()[0], createDataTransferStub());

      // Dragging bypasses this component entirely - the canvas reads the payload
      // on drop - so a drag that also emitted would place the module twice.
      expect(host.addedModuleTypes).toEqual([]);
    });
  });

  describe('architectural invariants', () => {
    it('should expose one output, no input and the selector the canvas binds', () => {
      const mirror = reflectComponentType(GfModuleCatalogComponent);

      expect(mirror.selector).toBe('gf-module-catalog');
      // No input at all, which is the structural form of "the canvas owns the
      // panel": there is no open state to hand in, and no geometry either.
      expect(mirror.inputs).toEqual([]);
      expect(mirror.outputs.map(({ propName }) => propName)).toEqual([
        'moduleAdded'
      ]);
    });

    it('should render no in-application address', () => {
      advance();

      // The URL no longer selects a screen, so a row is a card rather than a
      // link. This is also why no router API, link directive or route constant is
      // named anywhere in this file: the component is created here without one
      // being provided, so reintroducing a dependency on the router would fail
      // this suite outright with an injection error. Please read a failure of that
      // kind as the guard working rather than as a missing provider.
      expect(queryElements('a')).toHaveLength(0);
      expect(queryElement('[href]')).toBeNull();

      // Every interactive element is a card the row owns, never a navigation
      // affordance handed to it from outside.
      expect(queryElements('gf-module-catalog-item mat-card')).toHaveLength(3);
    });

    it('should render no panel chrome of its own', () => {
      advance();

      // The drawer, its backdrop and the button that opens it all belong to the
      // canvas, which decides when this content is visible - including opening it
      // unprompted for a viewer with no saved layout.
      expect(queryElement('mat-sidenav')).toBeNull();
      expect(queryElement('mat-drawer')).toBeNull();
      expect(queryElement('.fab-container')).toBeNull();
      expect(queryElement('[mat-fab]')).toBeNull();
    });

    it('should never resolve a module component while listing modules', () => {
      advance();

      setSearchTerm('Hold');
      advance();

      dispatchKeydown('ArrowDown', DOWN_ARROW);
      dispatchDragStart(rowElements()[0], createDataTransferStub());
      rowElements()[0].click();
      fixture.detectChanges();

      // Drawing a list of names must not fetch a single module bundle. Resolving
      // a module class belongs to the module host, and this assertion is the only
      // mechanical guard against a future change that resolves them eagerly here.
      for (const { loadComponent } of definitions) {
        expect(loadComponent).not.toHaveBeenCalled();
      }
    });

    it('should not mutate the collection the registry hands it', () => {
      advance();

      setSearchTerm('Hold');
      advance();

      emitViewerState({
        user: { permissions: [permissions.accessAdminControl] }
      });

      expect(handedOutDefinitions.length).toBeGreaterThan(0);

      for (const handedOut of handedOutDefinitions) {
        // Filtering and sorting a list to draw it must not reorder or empty the
        // registry as a side effect.
        expect(handedOut.map(({ moduleType }) => moduleType)).toEqual(
          definitions.map(({ moduleType }) => moduleType)
        );
      }
    });
  });
});
