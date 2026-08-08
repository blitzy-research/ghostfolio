import { UserService } from '@ghostfolio/client/services/user/user.service';
import { permissions } from '@ghostfolio/common/permissions';

import { A, DOWN_ARROW, ENTER, UP_ARROW } from '@angular/cdk/keycodes';
import { Component, reflectComponentType } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { BehaviorSubject } from 'rxjs';

import { DashboardModuleType } from '../enums/dashboard-module-type';
import type { DashboardModuleDefinition } from '../interfaces/interfaces';
import { GfModuleRegistryService } from '../module-registry.service';
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
  template: `<gf-module-catalog
    [placedModuleTypes]="placedModuleTypes"
    [unavailableModuleTypes]="unavailableModuleTypes"
    (dragEnded)="onDragEnded()"
    (dragStarted)="onDragStarted($event)"
    (moduleAdded)="onModuleAdded($event)"
  />`
})
class GfTestModuleCatalogHostComponent {
  public readonly addedModuleTypes: DashboardModuleType[] = [];

  /**
   * Every drag announcement, in the order it arrived.
   *
   * One list rather than two, because the ORDER of the two events is the contract
   * that matters: an end that arrived before its own start, or a start left
   * without an end, would leave the canvas previewing the wrong footprint for the
   * next drag - and two separate counters could not tell either case apart.
   */
  public readonly dragEvents: string[] = [];

  /**
   * Stands in for what the canvas passes down: the types currently on the grid.
   * Empty by default, so every test that does not care about placement sees the
   * catalog exactly as a viewer with a blank canvas would.
   */
  public placedModuleTypes: DashboardModuleType[] = [];

  /**
   * The other thing the canvas passes down: the types the grid has no room for.
   * Also empty by default, so a test that does not care about capacity sees the
   * catalog as a viewer with room to spare would.
   */
  public unavailableModuleTypes: DashboardModuleType[] = [];

  public onDragEnded() {
    this.dragEvents.push('end');
  }

  public onDragStarted(moduleType: DashboardModuleType) {
    this.dragEvents.push(`start:${moduleType}`);
  }

  public onModuleAdded(moduleType: DashboardModuleType) {
    this.addedModuleTypes.push(moduleType);
  }
}

/**
 * Four properties of this harness are load-bearing.
 *
 * **The registry stub hands back everything, gated definitions included.** The real
 * service does not hide entries from a viewer - narrowing is the catalog's own job -
 * so a stub that pre-filtered would make every permission test vacuous. It is stubbed
 * at all because constructing the real one would pull every module component tree
 * into this compilation and undo the lazy boundary the registry exists to hold.
 *
 * **Fake timers are installed before the component is created, not per test.** The
 * catalog seeds its search stream during initialization and that seed travels through
 * the same debounce. `debounceTime` only schedules a new task while it has none
 * pending, so a seed created outside the fake time domain never fires, stays pending
 * and silently swallows every later term.
 *
 * **Keyboard events carry an explicit `keyCode`.** The CDK key manager switches on the
 * legacy `keyCode`, which jsdom leaves at zero for an event built from `key` alone, so
 * the obvious construction reaches the component and does nothing.
 *
 * **No router and no persistence collaborator is provided, and that absence is the
 * assertion.** A catalog that reached for a router API, a data service, an HTTP client
 * or the layout store would fail to instantiate against this harness, which is what
 * makes those absences structural rather than asserted.
 */
describe('GfModuleCatalogComponent', () => {
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
        // Named `Markets` like the row above it, and qualified - which is exactly
        // how the real shared metadata is shaped, because each module name is the
        // route registry's title for the screen it replaces and that registry
        // titles both market screens `Markets`. The qualifier is what separates
        // the two rows a fully entitled viewer sees.
        context: 'Market Data',
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
        // A fresh array holding the very same definition objects, which is
        // exactly what the real service does: it rebuilds the array from its map
        // on every call and shares the definitions inside it by reference,
        // because the module chrome compares them by identity to decide whether
        // it still has to fetch a component class.
        //
        // Copying the objects instead - `definitions.map((d) => ({ ...d }))` -
        // would look safer and be strictly weaker: a catalog that wrote to a
        // definition it was handed would only ever corrupt a throwaway clone, so
        // the mutation would be invisible here and real in production. Each array
        // is kept so that both halves can be checked afterwards: that the array
        // was not reordered or emptied, and that the definitions inside it were
        // not written to.
        const handedOut = [...definitions];

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
          provide: GfModuleRegistryService,
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

  function advance(milliseconds = debounceInMilliseconds) {
    jest.advanceTimersByTime(milliseconds);

    fixture.detectChanges();
  }

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

  function rowComponents() {
    return fixture.debugElement
      .queryAll(By.directive(GfModuleCatalogItemComponent))
      .map((debugElement) => {
        return debugElement.injector.get(GfModuleCatalogItemComponent);
      });
  }

  /**
   * The actionable element of each rendered row: a real button inside the row's
   * card.
   *
   * The row binds its click, its drag and its focus to that button rather than to
   * its own host or to the card, so an interaction has to be dispatched there to
   * travel the path a real one takes. Dispatching on the card instead would go
   * nowhere - an event on an ancestor does not reach a listener on a descendant.
   */
  function rowElements() {
    return queryElements<HTMLButtonElement>('gf-module-catalog-item button');
  }

  function renderedModuleNames() {
    return queryElements('gf-module-catalog-item').map((row) => {
      return row.textContent.trim();
    });
  }

  function displayedModuleTypes() {
    return component.modules.map(({ moduleType }) => {
      return moduleType;
    });
  }

  /**
   * The index of every row that currently holds the roving focus.
   *
   * The state this reads is recorded by each row from its own button's focus and
   * blur events, so it reports where the browser actually put focus rather than
   * an intention recorded alongside it.
   */
  function focusedRowIndexes() {
    return rowComponents().reduce<number[]>((indexes, row, index) => {
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
      expect(renderedModuleNames()).toEqual([
        'Holdings',
        'Markets',
        'Watchlist'
      ]);
    });

    it('should render nothing but the display name on a row', () => {
      advance();

      expect(renderedModuleNames()).toEqual([
        'Holdings',
        'Markets',
        'Watchlist'
      ]);
      expect(rowElements()[0].textContent).not.toMatch(/\d/);
    });

    /**
     * Two modules sharing one display name.
     *
     * They share it because each name is the shared route registry's title for the
     * screen the module replaces, reused verbatim so every locale already
     * translates it - and that registry gives both market screens the title
     * `Markets`. Behind a URL the collision was invisible; in one flat list it
     * leaves two rows a viewer cannot tell apart, so the qualifier carries the
     * distinction instead of the name.
     */
    describe('a module whose display name is shared', () => {
      const entitledViewer: CatalogViewerState = {
        user: { permissions: [permissions.readMarketDataOfMarkets] }
      };

      it('should draw the qualifier beside the name it disambiguates', () => {
        emitViewerState(entitledViewer);
        advance();

        // Registry order, which is catalog order: the qualified row sits where
        // the registry puts it rather than beside the name it shares.
        expect(renderedModuleNames()).toEqual([
          'Holdings',
          'Markets',
          'Watchlist',
          'Markets · Market Data'
        ]);
      });

      it('should keep the qualifier out of the announcement it duplicates', () => {
        emitViewerState(entitledViewer);
        advance();

        // The qualifier sits in its own element and that element is decorative:
        // the button's accessible name already carries the same words, and a
        // screen reader announcing them twice is noise.
        expect(
          queryElements('gf-module-catalog-item .context-qualifier')
        ).toHaveLength(1);
        expect(
          queryElement(
            'gf-module-catalog-item .context-qualifier'
          ).getAttribute('aria-hidden')
        ).toBe('true');
      });

      it('should fold the qualifier into the row name', () => {
        emitViewerState(entitledViewer);
        advance();

        // The distinction has to reach a screen reader as well as the eye: two
        // rows announced as `Add Markets module` are indistinguishable, which is
        // the whole reason the qualifier exists.
        expect(
          rowElements().map((row) => {
            return row.getAttribute('aria-label');
          })
        ).toEqual([
          'Add Holdings module',
          'Add Markets module',
          'Add Watchlist module',
          'Add Markets · Market Data module'
        ]);
      });

      it('should be reachable by searching its qualifier', () => {
        emitViewerState(entitledViewer);
        advance();

        // Searching what the row shows. Without the qualifier in the index, the
        // one word that separates the two rows is the one word that finds
        // neither.
        setSearchTerm('Market Data');
        advance();

        expect(displayedModuleTypes()).toEqual([
          DashboardModuleType.MARKETS_PREMIUM
        ]);
      });
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

    /**
     * The visible hint above the list, and whether the search field actually
     * points at it.
     *
     * The sentence explaining that a row can be dragged as well as clicked has to
     * be associated with the field, or the field announces its label and stops
     * there - and the catalog opens by itself for exactly the viewer who has not
     * yet learned that a row is draggable.
     */
    describe('the search field description', () => {
      it('should point the search field at the visible hint', () => {
        advance();

        const searchField = queryElement<HTMLInputElement>('input[matInput]');
        const describedBy = searchField.getAttribute('aria-describedby');

        expect(describedBy).toBeTruthy();

        // Read as a list, not compared as a string: Material merges its own hint
        // and error ids into this attribute, so the assertion is that ours is
        // among them rather than that ours is the only one.
        const ids = describedBy.split(' ').filter(Boolean);

        expect(ids).toContain('gfDashboardCatalogHint');
      });

      it('should resolve that description to the hint sentence itself', () => {
        advance();

        const hint = queryElement('#gfDashboardCatalogHint');

        expect(hint).toBeTruthy();
        expect(hint.textContent.trim()).toBe(
          'Click a module to add it, or drag it onto the canvas.'
        );

        // The whole point of the association: every id the field advertises has to
        // resolve to something, or the description is a dangling reference that
        // announces nothing.
        const ids = queryElement<HTMLInputElement>('input[matInput]')
          .getAttribute('aria-describedby')
          .split(' ')
          .filter(Boolean);

        for (const id of ids) {
          expect(queryElement(`#${id}`)).toBeTruthy();
        }
      });

      it('should keep the description on the element that carries the sentence', () => {
        advance();

        const hint = queryElement('#gfDashboardCatalogHint');

        // On the text element rather than its wrapper, so the announced description
        // is the sentence and not the wrapper's spacing utilities plus whatever else
        // it might later contain.
        expect(hint.tagName).toBe('SMALL');
        expect(hint.closest('.catalog-hint')).toBeTruthy();
      });

      it('should survive the field being typed into', () => {
        advance();

        setSearchTerm('Markets');
        advance();

        // Material re-synchronises this attribute on every state change of the
        // control, and its own pass rebuilds the list from scratch. If the static
        // attribute were being replaced rather than merged, the association would
        // silently disappear on the first keystroke.
        const ids = queryElement<HTMLInputElement>('input[matInput]')
          .getAttribute('aria-describedby')
          .split(' ')
          .filter(Boolean);

        expect(ids).toContain('gfDashboardCatalogHint');
      });

      it('should name the field from its label rather than from the hint', () => {
        advance();

        const searchField = queryElement<HTMLInputElement>('input[matInput]');

        // A description supplements a name; it must not become one. This field is
        // named by its `<label for>` and carries no `aria-labelledby` at all, so
        // the assertion is that the hint has not been wired in as a name by either
        // route.
        expect(searchField.getAttribute('aria-labelledby') ?? '').not.toContain(
          'gfDashboardCatalogHint'
        );
        expect(searchField.getAttribute('aria-label')).toBeNull();

        const label = queryElement<HTMLLabelElement>('label');

        expect(label.getAttribute('for')).toBe(searchField.id);
        expect(label.textContent.trim()).toBe('Search modules');
      });
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

      setSearchTerm('admin-users');
      advance();

      expect(displayedModuleTypes()).toEqual([]);
    });

    it('should not recompute results for a term that normalises unchanged', () => {
      advance();

      setSearchTerm('Hold');
      advance();

      const narrowedResults = component.modules;

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
      expect(notice.getAttribute('role')).toBe('status');
    });

    it('should drop the results region rather than leave it standing empty', () => {
      advance();

      setSearchTerm('zzzzzzzz');
      advance();

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

    // `nearest` and nothing else, and the two obvious alternatives are defects
    // rather than preferences: `center` re-scrolls a row that is already fully
    // visible, which drags the surrounding viewport on every arrow press, and
    // `smooth` animates that displacement so the list is still moving when the
    // next key arrives. `nearest` scrolls only when the row is actually out of
    // view, which is the whole requirement.
    it('should scroll a newly focused row into view without displacing the viewport', () => {
      advance();

      dispatchKeydown('ArrowDown', DOWN_ARROW);

      expect(scrollIntoViewMock).toHaveBeenCalledWith({ block: 'nearest' });

      const [[options]] = scrollIntoViewMock.mock.calls as [
        [ScrollIntoViewOptions]
      ];

      expect(options.behavior).toBeUndefined();
      expect(options.block).not.toBe('center');
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

      expect(focusedRowIndexes()).toEqual([2]);
    });

    it('should keep the highlight when a step lands on the row that already holds focus', () => {
      advance();

      setSearchTerm('Watch');
      advance();

      expect(renderedModuleNames()).toEqual(['Watchlist']);

      dispatchKeydown('ArrowDown', DOWN_ARROW);
      dispatchKeydown('ArrowDown', DOWN_ARROW);

      // Wrapping a one-row list steps onto the row that already holds focus, and
      // focusing an element that already holds it fires no event at all - so a
      // highlight recorded only from that event would be cleared on the way in
      // and never restored, leaving the browser's focus ring on a row the list
      // had stopped marking as active. The same thing happens when a results
      // update leaves the focused row in place.
      expect(focusedRowIndexes()).toEqual([0]);
      expect(document.activeElement).toBe(rowElements()[0]);
    });

    it('should move real DOM focus onto the row it steps to', () => {
      advance();

      dispatchKeydown('ArrowDown', DOWN_ARROW);

      // The whole point of the roving pattern: a key manager focuses the option it
      // moves to and does nothing else, so the option has to own something the
      // browser can genuinely focus. A row that only painted a highlight would
      // leave keyboard focus stranded wherever it started, and the highlight would
      // be describing focus that is somewhere else entirely.
      expect(document.activeElement).toBe(rowElements()[0]);

      dispatchKeydown('ArrowDown', DOWN_ARROW);

      expect(document.activeElement).toBe(rowElements()[1]);
    });

    it('should paint the highlight from real focus rather than in place of it', () => {
      advance();

      dispatchKeydown('ArrowDown', DOWN_ARROW);

      // Focus and highlight have to name the same row. They are not set together:
      // the row records its state from its button's own focus and blur events, so
      // the highlight follows focus however it arrived.
      expect(focusedRowIndexes()).toEqual([0]);
      expect(document.activeElement).toBe(rowElements()[0]);
    });

    it('should offer the add command as a real button that names its module', () => {
      advance();

      const [row] = rowElements();

      // Activation is the browser's job from here. A real `<button>` fires a click
      // for Enter and for Space with no key handling of ours, which is why neither
      // key is handled anywhere in this component - and jsdom does not implement
      // that translation, so the keystroke half is proven in a browser rather than
      // here. What this asserts is the part that makes it true: the element really
      // is a button, it is not a submit button that would post something, it is
      // reachable by the key manager, and it announces the command rather than
      // just the module name.
      expect(row.tagName).toBe('BUTTON');
      expect(row.type).toBe('button');
      expect(row.disabled).toBe(false);
      expect(row.getAttribute('aria-label')).toBe('Add Holdings module');
    });

    // The rows share exactly one tab stop, which is what makes this a roving
    // list. Asserted as a whole-list shape rather than per row, because both
    // ways of getting it wrong are silent: every row at -1 leaves the results
    // unreachable from the keyboard - the reported defect, where Tab jumped
    // from the search field straight past every module - while every row at 0
    // turns one list into twenty-one consecutive tab stops.
    it('should give the rows a single shared tab stop', () => {
      advance();

      expect(rowElements().map(({ tabIndex }) => tabIndex)).toEqual([
        0,
        ...Array.from({ length: rowElements().length - 1 }, () => -1)
      ]);
    });

    // The tab stop follows the roving focus, so returning to the list with Tab
    // resumes where the arrows left off instead of jumping back to the top.
    it('should move the shared tab stop onto the row the arrows moved to', () => {
      advance();

      dispatchKeydown('ArrowDown', DOWN_ARROW);
      dispatchKeydown('ArrowDown', DOWN_ARROW);

      expect(
        rowElements().findIndex(({ tabIndex }) => {
          return tabIndex === 0;
        })
      ).toBe(1);
      expect(
        rowElements().filter(({ tabIndex }) => {
          return tabIndex === 0;
        })
      ).toHaveLength(1);
    });

    // Focus arriving from outside the key manager - a Tab into the list, a click,
    // the browser restoring it when the panel reopens - has to be adopted, or the
    // next arrow press is measured from "nothing active" and jumps to one end of
    // the list instead of stepping one row from where the viewer is.
    it('should step from the row that was tabbed into rather than from the top', () => {
      advance();

      rowElements()[2].focus();
      fixture.detectChanges();

      expect(focusedRowIndexes()).toEqual([2]);
      expect(
        rowElements().findIndex(({ tabIndex }) => {
          return tabIndex === 0;
        })
      ).toBe(2);

      dispatchKeydown('ArrowUp', UP_ARROW);

      expect(focusedRowIndexes()).toEqual([1]);
      expect(document.activeElement).toBe(rowElements()[1]);
    });

    it('should return the tab stop to the first row when the results change', () => {
      advance();

      dispatchKeydown('ArrowDown', DOWN_ARROW);
      dispatchKeydown('ArrowDown', DOWN_ARROW);

      expect(
        rowElements().findIndex(({ tabIndex }) => {
          return tabIndex === 0;
        })
      ).toBe(1);

      // A nomination that outlived its row would point past the end of a narrowed
      // list and leave the whole panel out of the tab order again.
      component.searchFormControl.setValue('Holdings');
      advance();

      expect(rowElements().map(({ tabIndex }) => tabIndex)).toEqual([0]);
    });

    it('should keep the scrolling results box out of the tab order', () => {
      advance();

      // A browser makes a scroll container keyboard-focusable on its own unless the
      // author says otherwise, which put this box in the tab order ahead of the
      // rows as an unnamed control whose announced name was the run-together
      // labels of everything inside it.
      const resultContainer = queryElement('.result-container');

      expect(resultContainer.getAttribute('tabindex')).toBe('-1');
      expect(resultContainer.getAttribute('role')).toBe('list');
    });

    it('should add the row exactly once when its button is activated', () => {
      advance();

      dispatchKeydown('ArrowDown', DOWN_ARROW);

      (document.activeElement as HTMLElement).click();
      fixture.detectChanges();

      expect(host.addedModuleTypes).toEqual([DashboardModuleType.HOLDINGS]);
      expect(host.addedModuleTypes).toHaveLength(1);
    });

    it('should leave Enter to the focused button instead of handling it', () => {
      advance();

      dispatchKeydown('ArrowDown', DOWN_ARROW);

      const event = dispatchKeydown('Enter', ENTER);

      // Enter reaching the host has to be a no-op here. The focused button already
      // activates on it, so acting on it a second time would add the module twice;
      // swallowing it would break plain Enter in the search field. The row keeps
      // its focus either way.
      expect(host.addedModuleTypes).toEqual([]);
      expect(event.defaultPrevented).toBe(false);
      expect(focusedRowIndexes()).toEqual([0]);
    });

    it('should leave Enter alone when no row is focused', () => {
      advance();

      const event = dispatchKeydown('Enter', ENTER);

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

      expect(focusedRowIndexes()).toEqual([]);
    });

    it('should resume stepping from the top after the results change', () => {
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

      // Both market rows, in relevance order: the qualified one matches the term
      // on its name AND on its qualifier, so it scores ahead of the row that
      // matches on the name alone.
      expect(renderedModuleNames()).toEqual([
        'Markets · Market Data',
        'Markets'
      ]);

      dispatchKeydown('ArrowDown', DOWN_ARROW);

      expect(focusedRowIndexes()).toEqual([0]);
    });
  });

  describe('drag payload', () => {
    it('should write the bare discriminator under text/plain', () => {
      advance();

      const dataTransfer = createDataTransferStub();

      dispatchDragStart(rowElements()[0], dataTransfer);

      expect(dataTransfer.setData).toHaveBeenCalledTimes(1);
      expect(dataTransfer.setData).toHaveBeenCalledWith(
        'text/plain',
        DashboardModuleType.HOLDINGS
      );
    });

    // The single most breakable line in the drag path, and the reason
    // drag-to-add silently did nothing. A browser dispatches `drop` only where
    // the effect the SOURCE allows and the effect the TARGET requests intersect,
    // and the grid engine's own dragover handler unconditionally requests
    // `move`. A source offering only `copy` therefore intersects with nothing:
    // the operation resolves to `none`, no drop is ever dispatched, and the
    // gesture ends in dragend having added no module. Nothing else about it
    // looks wrong, which is why it is pinned here.
    it('should allow the move effect the grid engine requests on dragover', () => {
      advance();

      const dataTransfer = createDataTransferStub();

      dispatchDragStart(rowElements()[0], dataTransfer);

      expect(dataTransfer.effectAllowed).toBe('copyMove');
      expect(dataTransfer.effectAllowed).toMatch(/move/i);
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

      expect(rowComponents()[0].isDragging).toBe(false);
    });

    it('should clear the drag flag when the drag ends', () => {
      advance();

      const row = rowElements()[0];

      dispatchDragStart(row, createDataTransferStub());

      expect(rowComponents()[0].isDragging).toBe(true);

      row.dispatchEvent(new Event('dragend', { bubbles: true }));
      fixture.detectChanges();

      expect(rowComponents()[0].isDragging).toBe(false);
    });

    it('should not emit an add intent merely because a row was dragged', () => {
      advance();

      dispatchDragStart(rowElements()[0], createDataTransferStub());

      expect(host.addedModuleTypes).toEqual([]);
    });
  });

  /**
   * The announcements the grid engine's drop indicator depends on.
   *
   * The engine sizes that indicator from a single grid-wide default and has no way
   * to learn a module's own footprint, so it drew a 4x4 box for every module while
   * the item committed on drop carried the registry's own size - up to twelve
   * columns. Closing that gap needs the canvas to know WHICH module is in flight
   * before any drop happens, and this panel is the only thing that knows. It says
   * so and nothing more: no geometry is read here and none is emitted.
   */
  describe('announcing a drag to the canvas', () => {
    it('should name the dragged module as the drag begins', () => {
      advance();

      dispatchDragStart(rowElements()[0], createDataTransferStub());

      expect(host.dragEvents).toEqual([
        `start:${DashboardModuleType.HOLDINGS}`
      ]);
    });

    it('should name whichever row is dragged', () => {
      advance();

      dispatchDragStart(rowElements()[2], createDataTransferStub());

      expect(host.dragEvents).toEqual([
        `start:${DashboardModuleType.WATCHLIST}`
      ]);
    });

    it('should announce the end after the start', () => {
      advance();

      const row = rowElements()[0];

      dispatchDragStart(row, createDataTransferStub());

      row.dispatchEvent(new Event('dragend', { bubbles: true }));
      fixture.detectChanges();

      expect(host.dragEvents).toEqual([
        `start:${DashboardModuleType.HOLDINGS}`,
        'end'
      ]);
    });

    it('should announce the end of a drag that dropped nothing', () => {
      advance();

      const row = rowElements()[0];

      dispatchDragStart(row, createDataTransferStub());

      // A cancelled drag, or one released outside the grid, raises `dragend` and
      // no drop at all. The end has to arrive anyway, or the canvas would keep
      // previewing this module's footprint for the next one.
      row.dispatchEvent(new Event('dragend', { bubbles: true }));
      fixture.detectChanges();

      expect(host.dragEvents[host.dragEvents.length - 1]).toBe('end');
      expect(host.addedModuleTypes).toEqual([]);
    });

    it('should announce nothing when the drag carries no transfer object', () => {
      advance();

      dispatchDragStart(rowElements()[0]);

      // The row returns before it has a payload to offer, so there is no drag for
      // the canvas to prepare for either.
      expect(host.dragEvents).toEqual([]);
    });

    it('should announce nothing when a row is merely clicked', () => {
      advance();

      rowElements()[0].click();
      fixture.detectChanges();

      expect(host.dragEvents).toEqual([]);
      expect(host.addedModuleTypes).toEqual([DashboardModuleType.HOLDINGS]);
    });
  });

  // A row whose click reveals a module already on the canvas would otherwise be
  // indistinguishable from one that adds a new module, leaving the same gesture
  // doing two different things with no way to tell which. The distinction is
  // carried three ways on purpose: a visible marker, a state class for the leading-edge
  // rule, and - the one that matters most - a different accessible name, since
  // the visible marker is hidden from assistive technology precisely so the name
  // is not announced twice.
  describe('rows for modules already on the canvas', () => {
    function setPlacedModuleTypes(moduleTypes: DashboardModuleType[]) {
      host.placedModuleTypes = moduleTypes;

      fixture.detectChanges();
    }

    it('should mark only the placed rows', () => {
      advance();

      setPlacedModuleTypes([DashboardModuleType.MARKETS]);

      expect(
        rowComponents().map(({ isPlaced }) => {
          return isPlaced;
        })
      ).toEqual([false, true, false]);
      expect(queryElements('.placed-marker')).toHaveLength(1);
      expect(
        queryElements('gf-module-catalog-item mat-card.is-placed')
      ).toHaveLength(1);
    });

    it('should name the command each row actually performs', () => {
      advance();

      setPlacedModuleTypes([DashboardModuleType.MARKETS]);

      expect(
        rowElements().map((row) => {
          return row.getAttribute('aria-label');
        })
      ).toEqual([
        'Add Holdings module',
        'Reveal Markets module',
        'Add Watchlist module'
      ]);
    });

    it('should keep the marker out of the accessibility tree', () => {
      advance();

      setPlacedModuleTypes([DashboardModuleType.MARKETS]);

      // Decorative rather than removed from the flow: the row's own name already
      // draws the distinction, so announcing it again would only be noise.
      expect(queryElement('.placed-marker').getAttribute('aria-hidden')).toBe(
        'true'
      );
    });

    it('should mark no row when the canvas is empty', () => {
      advance();

      expect(
        rowComponents().every(({ isPlaced }) => {
          return !isPlaced;
        })
      ).toBe(true);
      expect(queryElements('.placed-marker')).toHaveLength(0);
    });

    // Placement is presentation here and nothing more. A placed row stays fully
    // actionable, because its click is what reveals the module already on the
    // canvas - disabling it would remove the only way to do that.
    it('should leave a placed row actionable', () => {
      advance();

      setPlacedModuleTypes([DashboardModuleType.HOLDINGS]);

      const [row] = rowElements();

      expect(row.disabled).toBe(false);

      row.click();

      expect(host.addedModuleTypes).toEqual([DashboardModuleType.HOLDINGS]);
    });
  });

  /**
   * The grid is bounded, so a module can be unplaced and still have nowhere to go.
   * A row in that state must say so, because otherwise it looks exactly like a row
   * that would work and its click appears to do nothing at all.
   */
  describe('rows the canvas has no room for', () => {
    function setUnavailableModuleTypes(moduleTypes: DashboardModuleType[]) {
      host.unavailableModuleTypes = moduleTypes;

      fixture.detectChanges();
    }

    it('should mark only the rows with no room', () => {
      advance();

      setUnavailableModuleTypes([DashboardModuleType.WATCHLIST]);

      expect(
        rowComponents().map(({ isUnavailable }) => {
          return isUnavailable;
        })
      ).toEqual([false, false, true]);
      expect(queryElements('.unavailable-marker')).toHaveLength(1);
      expect(
        queryElements('gf-module-catalog-item mat-card.is-unavailable')
      ).toHaveLength(1);
    });

    it('should say so in the row name', () => {
      advance();

      setUnavailableModuleTypes([DashboardModuleType.WATCHLIST]);

      expect(
        rowElements().map((row) => {
          return row.getAttribute('aria-label');
        })
      ).toEqual([
        'Add Holdings module',
        'Add Markets module',
        'Add Watchlist module, no room on the dashboard'
      ]);
    });

    // `aria-disabled` rather than `disabled`, and the difference matters. A disabled
    // button cannot be focused, so a keyboard user would find the row skipped with
    // no explanation and a pointer user would get no response at all. Left enabled
    // and merely marked, the row stays reachable and its activation is what produces
    // the canvas's explanation of how to make room.
    it('should mark the row unavailable without making it unreachable', () => {
      advance();

      setUnavailableModuleTypes([DashboardModuleType.HOLDINGS]);

      const [row] = rowElements();

      expect(row.getAttribute('aria-disabled')).toBe('true');
      expect(row.disabled).toBe(false);

      row.click();

      expect(host.addedModuleTypes).toEqual([DashboardModuleType.HOLDINGS]);
    });

    it('should carry no such marking while there is room', () => {
      advance();

      expect(
        rowComponents().every(({ isUnavailable }) => {
          return !isUnavailable;
        })
      ).toBe(true);
      expect(queryElements('.unavailable-marker')).toHaveLength(0);
      expect(
        rowElements().every((row) => {
          return row.getAttribute('aria-disabled') === null;
        })
      ).toBe(true);
    });

    it('should keep the marker out of the accessibility tree', () => {
      advance();

      setUnavailableModuleTypes([DashboardModuleType.HOLDINGS]);

      expect(
        queryElement('.unavailable-marker').getAttribute('aria-hidden')
      ).toBe('true');
    });

    // Placement wins, because a placed row reveals the module already on the canvas
    // rather than adding anything - it always has somewhere to go. Showing both
    // markers, or naming the row as having no room, would misdescribe it. The canvas
    // already excludes placed types from the unavailable list; this pins the row's
    // own behaviour so it stays correct even if it is ever told both.
    it('should prefer the placed treatment when told both', () => {
      advance();

      host.placedModuleTypes = [DashboardModuleType.HOLDINGS];
      setUnavailableModuleTypes([DashboardModuleType.HOLDINGS]);

      const [row] = rowElements();

      expect(row.getAttribute('aria-label')).toBe('Reveal Holdings module');
      expect(queryElements('.placed-marker')).toHaveLength(1);
      expect(queryElements('.unavailable-marker')).toHaveLength(0);
    });
  });

  /**
   * Taking keyboard focus when the canvas hands it over.
   *
   * The canvas mounts this panel in a Material drawer configured `mode="side"`, and
   * such a drawer manages focus in neither direction: its `autoFocus` resolves to
   * `'dialog'` for that mode, and both the take-focus and restore-focus paths return
   * immediately for that value. Without the hand-over asserted here a viewer who
   * opened the catalog from the keyboard stays on the trigger behind the panel, able
   * to reach a row only by tabbing through the whole canvas. The canvas decides
   * *when* focus should come here - it deliberately does not for the unprompted
   * first-visit open - and this component decides *where* it lands.
   *
   * Every assertion reads `document.activeElement`, because `focus()` on a detached
   * or hidden element is a silent no-op: a spy would report a call that moved
   * nothing.
   */
  describe('taking focus from the canvas', () => {
    it('should put focus on the search field, and say that it landed', () => {
      advance();

      const searchField = queryElement<HTMLInputElement>('input[matInput]');

      expect(component.focusSearchField()).toBe(true);
      expect(document.activeElement).toBe(searchField);
    });

    it('should land on the search field rather than on a row', () => {
      advance();

      component.focusSearchField();

      // The field is the panel's own first tabbable and the one control that
      // narrows every row, so a viewer who arrives there can type or Tab onward.
      // Landing on a row instead would silently skip the field.
      expect(focusedRowIndexes()).toEqual([]);
    });

    it('should fall back to the first row when the search field cannot take focus', () => {
      advance();

      // Detached rather than stubbed out. The view query still holds the element,
      // which is exactly the state a real one is in mid-teardown, and `focus()` on
      // it is the silent no-op the read-back exists to catch.
      queryElement('input[matInput]').remove();

      expect(component.focusSearchField()).toBe(true);
      expect(focusedRowIndexes()).toEqual([0]);
    });

    it('should leave the arrow keys stepping from the row it fell back to', () => {
      advance();

      queryElement('input[matInput]').remove();

      component.focusSearchField();

      dispatchKeydown('ArrowDown', DOWN_ARROW);

      // The second row, not the first. The fallback moves the key manager's active
      // index along with focus, so the next press steps from where the viewer is;
      // moving focus alone would leave the manager at "nothing active yet" and turn
      // this press into a jump back to the top of the list.
      expect(focusedRowIndexes()).toEqual([1]);
    });

    it('should report that focus did not land when there is nowhere to put it', () => {
      setSearchTerm('nothing matches this');
      advance();

      // A term that narrows the list to nothing, and no field either: there is no
      // longer anything in the panel that can hold focus.
      expect(queryElements('gf-module-catalog-item')).toHaveLength(0);

      queryElement('input[matInput]').remove();

      // Reported rather than assumed, because the canvas acts on the answer: a
      // false claim here would leave it believing it owes focus back to a trigger
      // it never took focus from.
      expect(component.focusSearchField()).toBe(false);
    });
  });

  describe('architectural invariants', () => {
    // The catalog's whole surface, pinned. Both inputs are things only the canvas
    // can tell it, and both are deliberately lists of TYPES rather than layout
    // state - no coordinate, no size, and nothing the catalog could use to place
    // anything itself:
    //
    //   - `placedModuleTypes`, so a row that reveals a module already on the
    //     canvas can look different from one that adds a new one;
    //   - `unavailableModuleTypes`, so a row the grid has no room for says so
    //     instead of inviting a click that silently does nothing.
    //
    // The second is the sharper case of the rule and worth stating: whether a
    // module still fits is a question about geometry, so the canvas - which owns
    // the grid - answers it, and only the answer crosses the boundary. Weigh any
    // further input the same way: the catalog is meant to know WHAT exists, never
    // where it sits.
    it('should expose three outputs, two inputs and the selector the canvas binds', () => {
      const mirror = reflectComponentType(GfModuleCatalogComponent);

      expect(mirror.selector).toBe('gf-module-catalog');
      expect(mirror.inputs.map(({ propName }) => propName)).toEqual([
        'placedModuleTypes',
        'unavailableModuleTypes'
      ]);

      // All three are announcements, and none of them carries geometry. Two of
      // them exist because the grid engine sizes its own drop indicator from a
      // single grid-wide default and knows nothing about per-module metadata, so
      // the panel has to say WHICH module is being dragged and WHEN that drag
      // ends; what to do about it stays with the canvas, which is the only thing
      // that owns grid policy.
      expect(mirror.outputs.map(({ propName }) => propName)).toEqual([
        'moduleAdded',
        'dragStarted',
        'dragEnded'
      ]);
    });

    it('should render no in-application address', () => {
      advance();

      // The URL selects no screen, so a row is a button rather than a link. This
      // is also why no router API, link directive or route constant is named
      // anywhere in this file: the component is created here without one being
      // provided, so reintroducing a dependency on the router fails this suite
      // outright with an injection error - which is the guard working rather than
      // a missing provider.
      expect(queryElements('a')).toHaveLength(0);
      expect(queryElement('[href]')).toBeNull();

      // Every interactive element is a button the row owns, never a navigation
      // affordance handed to it from outside. The card around each button is
      // presentation only, so it is the button count that has to match the rows.
      expect(queryElements('gf-module-catalog-item mat-card')).toHaveLength(3);
      expect(rowElements()).toHaveLength(3);

      for (const row of rowElements()) {
        expect(row.tagName).toBe('BUTTON');
      }
    });

    it('should render no panel chrome of its own', () => {
      advance();

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
        expect(handedOut.map(({ moduleType }) => moduleType)).toEqual(
          definitions.map(({ moduleType }) => moduleType)
        );
      }
    });

    it('should not write to a definition the registry hands it', () => {
      // Captured before anything is drawn, and captured per field rather than as
      // a reference, because the arrays above hold the definitions themselves:
      // comparing them to each other could only ever succeed.
      const before = definitions.map((definition) => ({ ...definition }));

      advance();

      setSearchTerm('Hold');
      advance();

      emitViewerState({
        user: { permissions: [permissions.accessAdminControl] }
      });
      advance();

      dispatchKeydown('ArrowDown', DOWN_ARROW);
      dispatchDragStart(rowElements()[0], createDataTransferStub());
      rowElements()[0].click();
      fixture.detectChanges();

      // The registry owns this metadata and every consumer shares it, so a
      // catalog that annotated a definition - with a match score, a visibility
      // flag, a display order - would change what the canvas and the module
      // chrome read. Asserted field by field over the whole set, so a write to any
      // one of them fails here.
      expect(definitions.map((definition) => ({ ...definition }))).toEqual(
        before
      );
    });
  });
});
