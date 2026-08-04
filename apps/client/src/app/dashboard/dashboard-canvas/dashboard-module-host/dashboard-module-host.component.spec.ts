import { Component, Type } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { setImmediate } from 'node:timers';

import { DashboardModuleType } from '../../enums/dashboard-module-type';
import type { DashboardModuleDefinition } from '../../interfaces/interfaces';
import { GfDashboardModuleHostComponent } from './dashboard-module-host.component';

// Cuts the one dependency of the chrome that this environment cannot load.
// `@ionic/angular/standalone` re-exports `@ionic/core`, which ships plain `.js`
// ES modules rather than `.mjs`, and this project's Jest transform deliberately
// admits only `.mjs` from `node_modules` - the workspace-wide setting that
// `libs/ui` shares - so importing the chrome, which names `IonIcon` among its own
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
 * Declared here rather than imported from `modules/**`: reaching for a real wrapper
 * would pull its whole dependency tree into the compilation graph and undo the lazy
 * boundary this spec exists to prove.
 */
@Component({
  selector: 'gf-first-test-module',
  template: '<p class="gf-first-test-module-body">First module body</p>'
})
class GfFirstTestModuleComponent {}

@Component({
  selector: 'gf-second-test-module',
  template: '<p class="gf-second-test-module-body">Second module body</p>'
})
class GfSecondTestModuleComponent {}

describe('GfDashboardModuleHostComponent', () => {
  /**
   * Deliberately plain rather than `$localize`-tagged: the shared metadata has
   * already translated a real module's name by the time it reaches this input,
   * so the chrome's job is to render whatever string it is handed untouched.
   */
  const moduleName = 'Test Module';

  let component: GfDashboardModuleHostComponent;
  let fixture: ComponentFixture<GfDashboardModuleHostComponent>;
  let unhandledRejectionListener: ((reason: unknown) => void) | undefined;

  /**
   * Builds a definition that satisfies the shared contract in full.
   *
   * Every member the host must not consume is exposed as a getter that records
   * its own access, which turns "this component ignores placement and visibility
   * metadata" from a claim into something a test can assert.
   */
  const createDefinition = (
    loadComponent: () => Promise<Type<unknown>>,
    readMembers: string[] = []
  ): DashboardModuleDefinition => {
    return {
      get defaultItemCols() {
        readMembers.push('defaultItemCols');

        return 4;
      },
      get defaultItemRows() {
        readMembers.push('defaultItemRows');

        return 4;
      },
      loadComponent,
      get minItemCols() {
        readMembers.push('minItemCols');

        return 2;
      },
      get minItemRows() {
        readMembers.push('minItemRows');

        return 2;
      },
      get moduleType() {
        readMembers.push('moduleType');

        return DashboardModuleType.HOLDINGS;
      },
      name: moduleName,
      get permission() {
        readMembers.push('permission');

        return 'accessAdminControl';
      }
    };
  };

  const query = <T extends Element>(selector: string) => {
    return (fixture.nativeElement as HTMLElement).querySelector<T>(selector);
  };

  /**
   * Presses a key on the drag handle itself.
   *
   * Dispatched on the real element rather than by calling the handler, so the
   * template binding is part of what each assertion covers.
   *
   * @returns The dispatched event, so a test can assert whether the default
   * action was suppressed - which is the difference between a key this handle
   * acts on and one it leaves to the page.
   */
  const pressOnHandle = (key: string, shiftKey = false) => {
    const event = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key,
      shiftKey
    });

    query<HTMLButtonElement>('.gf-dashboard-module-drag-handle').dispatchEvent(
      event
    );

    fixture.detectChanges();

    return event;
  };

  /**
   * Binds a definition whose module resolves immediately and renders it, which is
   * the starting point for every interaction test below.
   */
  const bindResolvingDefinition = async () => {
    fixture.componentRef.setInput(
      'definition',
      createDefinition(() =>
        Promise.resolve<Type<unknown>>(GfFirstTestModuleComponent)
      )
    );

    await settle();
  };

  /**
   * Two render passes with a microtask drain between them: the first delivers the
   * bound input and paints the pending state, the second paints whatever the
   * loader settled into.
   */
  const settle = async () => {
    fixture.detectChanges();

    await fixture.whenStable();

    fixture.detectChanges();
  };

  const expectChromeToBeRendered = () => {
    expect(query('mat-card')).toBeTruthy();
    expect(query('mat-card-header')).toBeTruthy();
    expect(query('.gf-dashboard-module-drag-handle')).toBeTruthy();
    expect(query('button[mat-icon-button]')).toBeTruthy();
  };

  /**
   * Registers a process-level listener for rejections nothing handled, and
   * records it so that it is removed no matter how the test that installed it
   * ends.
   *
   * A listener left behind is not a tidiness problem: it is process-global, so it
   * would keep collecting rejections raised by every later test in this file and
   * attribute them to an array that nobody reads any more. Registration and
   * release are therefore separated - the caller only ever registers, and
   * `afterEach` always releases.
   */
  const collectUnhandledRejections = () => {
    const reasons: unknown[] = [];

    unhandledRejectionListener = (reason: unknown) => {
      reasons.push(reason);
    };

    process.on('unhandledRejection', unhandledRejectionListener);

    return reasons;
  };

  beforeEach(async () => {
    unhandledRejectionListener = undefined;

    // No provider is registered, and that omission is the point rather than an
    // economy: see the construction test below.
    await TestBed.configureTestingModule({
      imports: [GfDashboardModuleHostComponent]
    }).compileComponents();

    fixture = TestBed.createComponent(GfDashboardModuleHostComponent);
    component = fixture.componentInstance;
  });

  afterEach(() => {
    if (unhandledRejectionListener) {
      process.off('unhandledRejection', unhandledRejectionListener);

      unhandledRejectionListener = undefined;
    }
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('should render the module chrome and the module name verbatim', async () => {
    fixture.componentRef.setInput(
      'definition',
      createDefinition(() =>
        Promise.resolve<Type<unknown>>(GfFirstTestModuleComponent)
      )
    );

    await settle();

    expectChromeToBeRendered();

    expect(query('mat-card-title').textContent.trim()).toBe(moduleName);

    expect(query('button[aria-label="Module actions"]')).toBeTruthy();
  });

  it('should paint the resolved module only once its loader settles', async () => {
    const loadComponent = jest.fn(() => {
      return Promise.resolve<Type<unknown>>(GfFirstTestModuleComponent);
    });

    fixture.componentRef.setInput(
      'definition',
      createDefinition(loadComponent)
    );

    fixture.detectChanges();

    expect(query('.gf-first-test-module-body')).toBeNull();
    expect(query('ngx-skeleton-loader')).toBeTruthy();

    await settle();

    expect(query('.gf-first-test-module-body')).toBeTruthy();
    expect(query('ngx-skeleton-loader')).toBeNull();

    expect(loadComponent).toHaveBeenCalledTimes(1);
  });

  it('should not reload when the same definition is bound again', async () => {
    const loadComponent = jest.fn(() => {
      return Promise.resolve<Type<unknown>>(GfFirstTestModuleComponent);
    });
    const definition = createDefinition(loadComponent);

    fixture.componentRef.setInput('definition', definition);

    await settle();

    fixture.componentRef.setInput('definition', definition);

    await settle();

    expect(loadComponent).toHaveBeenCalledTimes(1);
  });

  it('should carry the drag handle class the grid matches by name', async () => {
    fixture.componentRef.setInput(
      'definition',
      createDefinition(() =>
        Promise.resolve<Type<unknown>>(GfFirstTestModuleComponent)
      )
    );

    await settle();

    // Spelled out instead of imported from the grid configuration. The two sides
    // agree by string, so sharing a constant would make this assertion
    // tautological - it would still pass with the same typo on both sides, which
    // is the one failure it exists to catch.
    expect(query('.gf-dashboard-module-drag-handle')).toBeTruthy();
  });

  it('should keep the module inside the ignored content region and the handle outside it', async () => {
    fixture.componentRef.setInput(
      'definition',
      createDefinition(() =>
        Promise.resolve<Type<unknown>>(GfFirstTestModuleComponent)
      )
    );

    await settle();

    // Spelled out for the same reason as the handle class above.
    expect(query('.gridster-item-content')).toBeTruthy();

    expect(
      query('.gridster-item-content .gf-first-test-module-body')
    ).toBeTruthy();
    expect(
      query('.gridster-item-content .gf-dashboard-module-drag-handle')
    ).toBeNull();
  });

  it('should emit remove exactly once when the menu action is chosen', async () => {
    fixture.componentRef.setInput(
      'definition',
      createDefinition(() =>
        Promise.resolve<Type<unknown>>(GfFirstTestModuleComponent)
      )
    );

    const emitSpy = jest.spyOn(component.remove, 'emit');

    await settle();

    query<HTMLButtonElement>('button[mat-icon-button]').click();

    await settle();

    // The menu projects its items into the CDK overlay on the document body, so
    // they are unreachable from the fixture's own element. Driving the real
    // trigger rather than calling the handler proves the template wiring too.
    const menuItems = document.querySelectorAll<HTMLButtonElement>(
      '.cdk-overlay-container button.mat-mdc-menu-item'
    );

    expect(menuItems).toHaveLength(1);
    expect(menuItems[0].textContent.trim()).toBe('Remove');

    menuItems[0].click();

    await settle();

    expect(emitSpy).toHaveBeenCalledTimes(1);
  });

  it('should expose the drag handle as a real button that advertises what its keys do', async () => {
    await bindResolvingDefinition();

    const handle = query<HTMLButtonElement>('.gf-dashboard-module-drag-handle');

    // The handle was already focusable before it did anything, which is the exact
    // shape of a dead tab stop: reachable, announced, and leading nowhere. It is a
    // button now because it genuinely acts on keys, and it says which ones.
    expect(handle.tagName).toBe('BUTTON');
    expect(handle.disabled).toBe(false);
    expect(handle.getAttribute('aria-label')).toBe('Move or resize module');
    expect(handle.getAttribute('aria-keyshortcuts')).toBe(
      'ArrowUp ArrowDown ArrowLeft ArrowRight Shift+ArrowUp Shift+ArrowDown Shift+ArrowLeft Shift+ArrowRight'
    );

    // Not a submit button. It sits in no form here, but the default type would
    // still give Enter and Space an action, and this control has none - only its
    // arrow keys act.
    expect(handle.type).toBe('button');

    // The glyph inside carries no accessible name of its own, so the button reads
    // as one control rather than announcing an icon name after it.
    expect(query('.gf-dashboard-module-drag-handle ion-icon')).toBeTruthy();
    expect(
      query('.gf-dashboard-module-drag-handle ion-icon').getAttribute(
        'aria-hidden'
      )
    ).toBe('true');
  });

  it('should request a one-cell move for each bare arrow key', async () => {
    await bindResolvingDefinition();

    const moveSteps: unknown[] = [];
    const resizeSteps: unknown[] = [];

    component.move.subscribe((step) => moveSteps.push(step));
    component.resize.subscribe((step) => resizeSteps.push(step));

    const events = [
      pressOnHandle('ArrowUp'),
      pressOnHandle('ArrowDown'),
      pressOnHandle('ArrowLeft'),
      pressOnHandle('ArrowRight')
    ];

    // Steps, never coordinates: the grid owns where a module actually is, so this
    // host can only ask for a relative change and let the canvas resolve it.
    expect(moveSteps).toEqual([
      { deltaCols: 0, deltaRows: -1 },
      { deltaCols: 0, deltaRows: 1 },
      { deltaCols: -1, deltaRows: 0 },
      { deltaCols: 1, deltaRows: 0 }
    ]);
    expect(resizeSteps).toEqual([]);

    // Suppressed only for the keys that produced a step, so the arrow keys keep
    // scrolling the canvas everywhere else.
    for (const event of events) {
      expect(event.defaultPrevented).toBe(true);
    }
  });

  it('should request a one-cell resize when Shift accompanies an arrow key', async () => {
    await bindResolvingDefinition();

    const moveSteps: unknown[] = [];
    const resizeSteps: unknown[] = [];

    component.move.subscribe((step) => moveSteps.push(step));
    component.resize.subscribe((step) => resizeSteps.push(step));

    pressOnHandle('ArrowRight', true);
    pressOnHandle('ArrowDown', true);
    pressOnHandle('ArrowLeft', true);
    pressOnHandle('ArrowUp', true);

    // The same four steps, reinterpreted as growth and shrinkage of the
    // bottom-right corner - the pair of edges the pointer handles expose, so the
    // keyboard reaches exactly what a mouse reaches and no more.
    expect(resizeSteps).toEqual([
      { deltaCols: 1, deltaRows: 0 },
      { deltaCols: 0, deltaRows: 1 },
      { deltaCols: -1, deltaRows: 0 },
      { deltaCols: 0, deltaRows: -1 }
    ]);
    expect(moveSteps).toEqual([]);
  });

  it('should emit exactly one step per keystroke', async () => {
    await bindResolvingDefinition();

    const moveSpy = jest.spyOn(component.move, 'emit');

    pressOnHandle('ArrowRight');
    pressOnHandle('ArrowRight');

    // One request per press, and identical each time: the step carries a delta
    // rather than an accumulating position, so a repeated press cannot drift.
    expect(moveSpy).toHaveBeenCalledTimes(2);
    expect(moveSpy).toHaveBeenNthCalledWith(1, { deltaCols: 1, deltaRows: 0 });
    expect(moveSpy).toHaveBeenNthCalledWith(2, { deltaCols: 1, deltaRows: 0 });
  });

  it('should leave every key other than the arrows alone', async () => {
    await bindResolvingDefinition();

    const moveSpy = jest.spyOn(component.move, 'emit');
    const resizeSpy = jest.spyOn(component.resize, 'emit');
    const removeSpy = jest.spyOn(component.remove, 'emit');

    const events = [
      pressOnHandle('Enter'),
      pressOnHandle(' '),
      pressOnHandle('Tab'),
      pressOnHandle('Escape'),
      pressOnHandle('a'),
      pressOnHandle('Home')
    ];

    // Nothing acted on and nothing swallowed. Tab has to keep moving focus,
    // Escape has to keep reaching whatever handles it, and activation has to stay
    // inert on a control with no activation behaviour.
    expect(moveSpy).not.toHaveBeenCalled();
    expect(resizeSpy).not.toHaveBeenCalled();
    expect(removeSpy).not.toHaveBeenCalled();

    for (const event of events) {
      expect(event.defaultPrevented).toBe(false);
    }
  });

  it('should keep the geometry request free of any placement decision', async () => {
    const readMembers: string[] = [];

    fixture.componentRef.setInput(
      'definition',
      createDefinition(
        () => Promise.resolve<Type<unknown>>(GfFirstTestModuleComponent),
        readMembers
      )
    );

    await settle();

    pressOnHandle('ArrowRight');
    pressOnHandle('ArrowDown', true);

    // A move or resize request must not consult the declared minimum, the default
    // size or anything else on the definition. The grid engine enforces the floor
    // and refuses a step that would break it, and a second opinion here could
    // only ever disagree with it.
    expect(readMembers).toEqual([]);
  });

  it('should run its whole lifecycle with no data, persistence or navigation collaborator provided', async () => {
    // Nothing but the component is registered, so the injector throws
    // `NullInjectorError` the moment this component acquires a data service, HTTP
    // client, navigation dependency or the layout store. Registering any of them
    // here "to be safe" would satisfy the injector and retire that guard.
    const isolatedFixture = TestBed.createComponent(
      GfDashboardModuleHostComponent
    );

    expect(isolatedFixture.componentInstance).toBeTruthy();

    let removeCount = 0;

    component.remove.subscribe(() => {
      removeCount = removeCount + 1;
    });

    fixture.componentRef.setInput(
      'definition',
      createDefinition(() =>
        Promise.resolve<Type<unknown>>(GfFirstTestModuleComponent)
      )
    );

    await settle();

    component.onRemove();

    expect(query('.gf-first-test-module-body')).toBeTruthy();
    expect(removeCount).toBe(1);
  });

  it('should contain a rejected load inside its own cell', async () => {
    // Captured rather than suppressed: an escaping rejection would fail the run
    // here, and in the browser it would surface from a cell that is supposed to
    // absorb its own failure. Released by `afterEach` rather than at the end of
    // this body, so a failed assertion below cannot leak a process-global
    // listener into the tests that follow.
    const unhandledReasons = collectUnhandledRejections();

    fixture.componentRef.setInput(
      'definition',
      createDefinition(() => Promise.reject(new Error('load failed')))
    );

    await settle();

    // Node decides a rejection is unhandled once the microtask queue has drained
    // and the current turn of the event loop has completed, so the check has to
    // happen after such a turn rather than after a wall-clock delay.
    // `setImmediate` is that turn exactly, and it is imported from `node:timers`
    // because the jsdom environment does not publish it as a global. A
    // `setTimeout(…, 0)` would instead be a timer, whose duration a fake clock
    // could stall and whose ordering here is only incidentally right.
    await new Promise((resolve) => {
      setImmediate(resolve);
    });

    fixture.detectChanges();

    expect(unhandledReasons).toEqual([]);

    expect(
      query('.gridster-item-content [role="alert"]').textContent.trim()
    ).toBe('Oops! Something went wrong.');
    expect(query('ngx-skeleton-loader')).toBeNull();

    expectChromeToBeRendered();
  });

  it('should report a loader that throws before returning a promise', async () => {
    fixture.componentRef.setInput(
      'definition',
      createDefinition(() => {
        throw new Error('load failed');
      })
    );

    await settle();

    expect(query('[role="alert"]')).toBeTruthy();
    expect(query('ngx-skeleton-loader')).toBeNull();
    expectChromeToBeRendered();
  });

  it('should report a loader that resolves with nothing', async () => {
    fixture.componentRef.setInput(
      'definition',
      createDefinition(() => Promise.resolve<Type<unknown>>(undefined))
    );

    await settle();

    expect(query('[role="alert"]')).toBeTruthy();
    expect(query('ngx-skeleton-loader')).toBeNull();
  });

  it('should report a missing definition instead of loading forever', async () => {
    await settle();

    expect(query('[role="alert"]')).toBeTruthy();
    expect(query('ngx-skeleton-loader')).toBeNull();
    expectChromeToBeRendered();
  });

  it('should discard a result that arrives for a superseded definition', async () => {
    let resolveSuperseded: (moduleComponent: Type<unknown>) => void;

    fixture.componentRef.setInput(
      'definition',
      createDefinition(() => {
        return new Promise<Type<unknown>>((resolve) => {
          resolveSuperseded = resolve;
        });
      })
    );

    fixture.detectChanges();

    fixture.componentRef.setInput(
      'definition',
      createDefinition(() =>
        Promise.resolve<Type<unknown>>(GfSecondTestModuleComponent)
      )
    );

    await settle();

    resolveSuperseded(GfFirstTestModuleComponent);

    await settle();

    expect(query('.gf-second-test-module-body')).toBeTruthy();
    expect(query('.gf-first-test-module-body')).toBeNull();
  });

  it('should not read placement or visibility metadata from the definition', async () => {
    const readMembers: string[] = [];

    fixture.componentRef.setInput(
      'definition',
      createDefinition(
        () => Promise.resolve<Type<unknown>>(GfFirstTestModuleComponent),
        readMembers
      )
    );

    await settle();

    expect(readMembers).toEqual([]);
  });

  it('should expose no placement state of its own', () => {
    const placementMembers = [
      'cols',
      'defaultItemCols',
      'defaultItemRows',
      'minItemCols',
      'minItemRows',
      'rows',
      'x',
      'y'
    ];

    expect(placementMembers.filter((member) => member in component)).toEqual(
      []
    );
  });
});
