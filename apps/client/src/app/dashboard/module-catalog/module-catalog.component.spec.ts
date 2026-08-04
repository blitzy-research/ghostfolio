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
  template: '<gf-module-catalog (moduleAdded)="onModuleAdded($event)" />'
})
class GfTestModuleCatalogHostComponent {
  public readonly addedModuleTypes: DashboardModuleType[] = [];

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
 * assertion.** Do not "fix" a future failure by adding one: a catalog that reached for
 * a router API, a data service, an HTTP client or the layout store would fail to
 * instantiate here, which is what makes those structural rather than asserted.
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
      expect(row.tabIndex).toBe(-1);
      expect(row.getAttribute('aria-label')).toBe('Add Holdings module');
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

      expect(renderedModuleNames()).toEqual(['Markets', 'Markets']);

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

  describe('architectural invariants', () => {
    it('should expose one output, no input and the selector the canvas binds', () => {
      const mirror = reflectComponentType(GfModuleCatalogComponent);

      expect(mirror.selector).toBe('gf-module-catalog');
      expect(mirror.inputs).toEqual([]);
      expect(mirror.outputs.map(({ propName }) => propName)).toEqual([
        'moduleAdded'
      ]);
    });

    it('should render no in-application address', () => {
      advance();

      // The URL no longer selects a screen, so a row is a button rather than a
      // link. This is also why no router API, link directive or route constant is
      // named anywhere in this file: the component is created here without one
      // being provided, so reintroducing a dependency on the router would fail
      // this suite outright with an injection error. Please read a failure of that
      // kind as the guard working rather than as a missing provider.
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
