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
  let consoleErrorSpy: jest.SpyInstance;
  let fixture: ComponentFixture<GfDashboardModuleHostComponent>;
  let sanitizedReports: string[];
  let unhandledRejectionListener: ((reason: unknown) => void) | undefined;

  /**
   * The prefix of every diagnostic this component emits.
   *
   * Asserted on rather than the whole identifier in the recorder below, so that
   * the recorder keeps working if a second failure of this component ever needs
   * its own event - while a raw error object, which is what this exists to
   * prevent, still falls through to the real console where it is visible.
   */
  const REPORT_PREFIX = 'GF-DASHBOARD-MODULE-HOST-';

  /**
   * Everything a failed chunk request carries that must never reach a log.
   *
   * Each sits somewhere on the value a rejected dynamic `import()` produces: the
   * chunk url is in the message the loader composes, the deployment's own origin
   * is in that url, and the stack names the frames that asked for it.
   * `console.error(error)` prints all of it; `reportSanitizedError` prints none of
   * it. An assertion that only checks *that* something was logged cannot tell the
   * two apart, which is why these markers exist.
   */
  const SENSITIVE_MARKERS = [
    'chunk-9f3e2b6d.js',
    'ghostfolio.test',
    'Failed to fetch dynamically imported module',
    'at GfDashboardModuleHostComponent'
  ];

  /**
   * A rejection shaped like the one a real chunk request produces.
   *
   * Carries a numeric `status` because that is the one thing the reporting
   * contract is allowed to pass through, and carries every marker above so a leak
   * is detectable rather than merely improbable.
   */
  const createChunkFailure = () => {
    const failure = new Error(
      `Failed to fetch dynamically imported module: https://ghostfolio.test/chunk-9f3e2b6d.js`
    );

    failure.stack = `Error: ${failure.message}\n    at GfDashboardModuleHostComponent.resolveModule`;

    return Object.assign(failure, { status: 404 });
  };

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

  /**
   * Lets a real `MutationObserver` deliver what it has queued.
   *
   * Deliveries land at a microtask checkpoint, so yielding to the task queue is
   * what makes them observable. This is deliberately not a fixture drain: the
   * watcher registers its observer outside Angular, so there is no pending task
   * for the fixture to know about and awaiting stability would return at once
   * having flushed nothing.
   */
  const flushObservers = async () => {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
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

    sanitizedReports = [];

    // Recorded rather than merely silenced. The component's own diagnostic is
    // swallowed so the suite output stays readable, and kept - in full - so both
    // its presence and its content are assertable; anything that is not a single
    // string beginning with the prefix is a raw error object and is forwarded to
    // the real console, where it shows up as noise a reader will investigate.
    //
    // Captured before the spy replaces it, and annotated so the forwarder stays
    // typed rather than merely named: `Function.prototype.bind` widens its result
    // to `any`, which would make every forwarded report an unchecked call.
    const reportError = console.error.bind(console) as (
      ...args: unknown[]
    ) => void;

    consoleErrorSpy = jest
      .spyOn(console, 'error')
      .mockImplementation((...args: unknown[]) => {
        const [report] = args;

        if (typeof report === 'string' && report.startsWith(REPORT_PREFIX)) {
          sanitizedReports.push(report);

          return;
        }

        reportError(...args);
      });

    // No provider is registered, and that omission is the point rather than an
    // economy: see the construction test below.
    await TestBed.configureTestingModule({
      imports: [GfDashboardModuleHostComponent]
    }).compileComponents();

    fixture = TestBed.createComponent(GfDashboardModuleHostComponent);
    component = fixture.componentInstance;
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();

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

    expect(query('button.module-actions')).toBeTruthy();

    // A module with no qualifier reads exactly as its registry title, with no
    // separator and nothing appended - so the composition below cannot cost the
    // seventeen unambiguous modules anything.
    expect(query('mat-card').getAttribute('aria-label')).toBe(moduleName);
    expect(query('button.module-actions').textContent.trim()).toBe(
      `Module actions: ${moduleName}`
    );
  });

  it('should qualify a module whose name the registry reuses, everywhere the chrome names it', async () => {
    // Two registry entries share the name `Settings` and two share `Markets`, each
    // pair distinguished only by a `context`. Both of a pair can be placed at once,
    // so chrome that said `Settings` in all four places would leave a reader with
    // two identical regions, two identical drag handles and two identical action
    // menus, one of which removes the wrong arrangement.
    //
    // The qualifier is asserted in all four places at once, because agreeing with
    // itself is the point: the visible title, the region name and both controls have
    // to say the same thing as the catalog row the module was added from.
    fixture.componentRef.setInput('definition', {
      ...createDefinition(() =>
        Promise.resolve<Type<unknown>>(GfFirstTestModuleComponent)
      ),
      context: 'Admin Control',
      name: 'Settings'
    });

    await settle();

    const qualifiedName = 'Settings · Admin Control';

    expect(component.qualifiedName).toBe(qualifiedName);
    expect(query('mat-card-title').textContent.trim()).toBe(qualifiedName);
    expect(query('mat-card').getAttribute('aria-label')).toBe(qualifiedName);
    expect(query('.gf-dashboard-module-drag-handle').textContent.trim()).toBe(
      `Move or resize module: ${qualifiedName}`
    );
    expect(query('button.module-actions').textContent.trim()).toBe(
      `Module actions: ${qualifiedName}`
    );

    // The same separator the catalog row uses, so the two cannot drift apart. Both
    // halves are already-translated registry values, so composing them here adds no
    // source message and leaves no locale with an untranslated string.
    expect(qualifiedName).toContain(' · ');
  });

  it('should preserve readable title space and a module-scale content gutter', async () => {
    await bindResolvingDefinition();

    expect(query('mat-card-header').classList).toContain('px-2');
    expect(query('.gf-dashboard-module-drag-handle').classList).not.toContain(
      'mr-2'
    );
    expect(query('mat-card-title').parentElement.classList).toContain(
      'module-title'
    );
    expect(query('button.module-actions').classList).toContain(
      'module-actions'
    );
    expect(query('.gridster-item-content').classList).toContain('p-3');
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

  /**
   * The refresh the control bar asks for, delivered where it can actually be
   * delivered.
   *
   * Every module fetches on construction, so re-creating the mounted component is
   * what makes a module re-read its data - and it is the only mechanism that works
   * for ALL modules rather than for the one that happens to subscribe to a bus.
   */
  describe('reloading the mounted module', () => {
    it('should resolve the module again and repaint it', async () => {
      const loadComponent = jest.fn(() => {
        return Promise.resolve<Type<unknown>>(GfFirstTestModuleComponent);
      });

      fixture.componentRef.setInput(
        'definition',
        createDefinition(loadComponent)
      );

      await settle();

      expect(loadComponent).toHaveBeenCalledTimes(1);
      expect(query('.gf-first-test-module-body')).toBeTruthy();

      component.reload();

      // The mounted component is gone the instant the reload is asked for, which
      // is what makes the module genuinely re-created rather than merely re-bound:
      // the outlet has to observe the absence, or it would see an unchanged type
      // and keep the instance it already had.
      expect(query('.gf-first-test-module-body')).toBeNull();

      await settle();

      expect(loadComponent).toHaveBeenCalledTimes(2);
      expect(query('.gf-first-test-module-body')).toBeTruthy();
    });

    it('should mount a brand-new instance rather than reuse the previous one', async () => {
      await bindResolvingDefinition();

      const before = query('.gf-first-test-module-body');

      component.reload();

      await settle();

      const after = query('.gf-first-test-module-body');

      // Identity, not presence. A module that re-reads its data has to have been
      // constructed again, and only a different element proves that.
      expect(before).toBeTruthy();
      expect(after).toBeTruthy();
      expect(after).not.toBe(before);
    });

    it('should clear a previous load failure so a refresh can recover from it', async () => {
      const loadComponent = jest
        .fn<Promise<Type<unknown>>, []>()
        .mockRejectedValueOnce(new Error('chunk unavailable'))
        .mockResolvedValueOnce(GfFirstTestModuleComponent);

      fixture.componentRef.setInput(
        'definition',
        createDefinition(loadComponent)
      );

      await settle();

      expect(component.hasLoadError).toBe(true);

      component.reload();

      await settle();

      expect(component.hasLoadError).toBe(false);
      expect(query('.gf-first-test-module-body')).toBeTruthy();
    });

    it('should do nothing at all when no module is bound', () => {
      component.reload();

      // Nothing to refresh is not a failure, so the host must not enter its error
      // state over it - that state means a module was asked for and could not be
      // produced.
      expect(component.hasLoadError).toBe(false);
      expect(component.resolvedComponent).toBeUndefined();
    });
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

    // A focusable element that does nothing is a dead tab stop: reachable,
    // announced, and leading nowhere. This is a button because it genuinely acts on
    // keys, and it says which ones.
    expect(handle.tagName).toBe('BUTTON');
    expect(handle.disabled).toBe(false);

    // Named from its own clipped content rather than from a label attribute, which
    // is what lets the module's name join the action wording without a new
    // parameterised source message. An attribute could hold only one of the two.
    expect(handle.getAttribute('aria-label')).toBeNull();
    expect(handle.textContent.trim()).toBe(
      `Move or resize module: ${moduleName}`
    );
    expect(query('.gf-dashboard-module-drag-handle span').classList).toContain(
      'sr-only'
    );

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

  /**
   * The chrome's half of the focus contract the canvas relies on after a removal.
   *
   * Removing a module destroys the control the removal was asked for from, so
   * something has to catch focus or a keyboard-only viewer is dropped onto the
   * document body. The canvas decides which module catches it; this component
   * decides where within that module focus goes, and answers honestly when it
   * cannot take it - which is what lets the canvas try the next candidate.
   */
  describe('handing focus to its drag handle', () => {
    it('should focus the handle and report that focus landed', async () => {
      await bindResolvingDefinition();

      const handle = query<HTMLButtonElement>(
        '.gf-dashboard-module-drag-handle'
      );

      expect(document.activeElement).not.toBe(handle);

      expect(component.focusDragHandle()).toBe(true);

      // The handle rather than the card, and rather than the menu trigger: it is the
      // module's only always-present focusable element, and landing on it puts the
      // arrow keys that move and resize the module straight back under the reader's
      // fingers.
      expect(document.activeElement).toBe(handle);
    });

    it('should be safe to ask twice', async () => {
      await bindResolvingDefinition();

      const handle = query<HTMLButtonElement>(
        '.gf-dashboard-module-drag-handle'
      );

      expect(component.focusDragHandle()).toBe(true);
      expect(component.focusDragHandle()).toBe(true);
      expect(document.activeElement).toBe(handle);
    });

    it('should report that focus did not land before the view is rendered', () => {
      // Deliberately unpainted. The view query is unresolved at this point, which is
      // a reachable state for a host the canvas is holding, and the caller needs the
      // honest answer rather than a silent success.
      expect(component.focusDragHandle()).toBe(false);
    });

    it('should report that focus did not land when the handle cannot take it', async () => {
      await bindResolvingDefinition();

      const handle = query<HTMLButtonElement>(
        '.gf-dashboard-module-drag-handle'
      );

      handle.remove();

      // `focus()` on a detached element is a silent no-op in every browser, so the
      // only truthful answer comes from reading back where focus actually ended up.
      // Returning `true` here would strand the caller: it would stop walking its
      // candidates believing focus was placed, and the document body would keep it.
      expect(component.focusDragHandle()).toBe(false);
      expect(document.activeElement).not.toBe(handle);
    });

    it('should place focus without reporting anything or touching its geometry', async () => {
      await bindResolvingDefinition();

      const moveSteps: unknown[] = [];
      const removals: unknown[] = [];
      const resizeSteps: unknown[] = [];

      component.move.subscribe((step) => moveSteps.push(step));
      component.remove.subscribe(() => removals.push(true));
      component.resize.subscribe((step) => resizeSteps.push(step));

      component.focusDragHandle();

      // Focus is not an edit. Nothing about the cell changes, so this produces no
      // grid callback and therefore no layout write.
      expect(moveSteps).toEqual([]);
      expect(removals).toEqual([]);
      expect(resizeSteps).toEqual([]);
    });
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
      createDefinition(() => Promise.reject(createChunkFailure()))
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

  describe('reporting a failed chunk request', () => {
    it('should report the failure as a fixed event with the response status', async () => {
      const unhandledReasons = collectUnhandledRejections();

      fixture.componentRef.setInput(
        'definition',
        createDefinition(() => Promise.reject(createChunkFailure()))
      );

      await settle();

      await new Promise((resolve) => {
        setImmediate(resolve);
      });

      expect(unhandledReasons).toEqual([]);

      // A broken chunk is a real deployment fault - a file a release did not ship,
      // or one a stale service worker is still asking for - and the card that
      // replaces it says only "Oops!", so without a report the only signal is a
      // viewer noticing a module went blank.
      expect(sanitizedReports).toEqual([
        'GF-DASHBOARD-MODULE-HOST-LOAD-FAILED (status 404)'
      ]);
    });

    it('should keep the chunk url, the origin and the stack out of the report', async () => {
      const unhandledReasons = collectUnhandledRejections();

      fixture.componentRef.setInput(
        'definition',
        createDefinition(() => Promise.reject(createChunkFailure()))
      );

      await settle();

      await new Promise((resolve) => {
        setImmediate(resolve);
      });

      expect(unhandledReasons).toEqual([]);

      // The whole point of routing this through the sanitized channel rather than
      // writing the caught value out: the console is readable by every script on
      // the page and captured verbatim by session-replay tooling.
      const emitted = sanitizedReports.join('\n');

      for (const marker of SENSITIVE_MARKERS) {
        expect(emitted).not.toContain(marker);
      }
    });

    it('should not report a rejection that arrives for a superseded module', async () => {
      const unhandledReasons = collectUnhandledRejections();

      let rejectSuperseded: (failure: unknown) => void;

      fixture.componentRef.setInput(
        'definition',
        createDefinition(
          () =>
            new Promise<Type<unknown>>((_, reject) => {
              rejectSuperseded = reject;
            })
        )
      );

      await settle();

      fixture.componentRef.setInput(
        'definition',
        createDefinition(() =>
          Promise.resolve<Type<unknown>>(GfSecondTestModuleComponent)
        )
      );

      await settle();

      rejectSuperseded(createChunkFailure());

      await settle();

      await new Promise((resolve) => {
        setImmediate(resolve);
      });

      expect(unhandledReasons).toEqual([]);

      // A definition replaced while its chunk was in flight is a DISCARDED request,
      // not a fault: the module the viewer is now looking at loaded perfectly well.
      // Reporting it would put a diagnostic in the log for every module swap that
      // outran its own loader, which is exactly the noise that makes a real report
      // easy to miss.
      expect(sanitizedReports).toEqual([]);
      expect(component.hasLoadError).toBe(false);
      expect(query('.gf-second-test-module-body')).toBeTruthy();
    });
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

  it('should give the scrolling body a tab stop of its own', async () => {
    await bindResolvingDefinition();

    // A cell is sized by the arrangement rather than by its content, so a module
    // that overflows is the normal case here. Several of them - a summary, an
    // allocation chart - have nothing focusable below the fold at all, and a
    // scrollport that cannot be focused cannot be scrolled from the keyboard, so
    // the hidden part of those modules would be reachable only with a pointer.
    expect(query('.gridster-item-content').getAttribute('tabindex')).toBe('0');

    // And no role with it: the card is already the labelled `role="region"` for
    // this content, so naming the scrollport as well would announce the module's
    // name twice on the way in.
    expect(query('.gridster-item-content').getAttribute('role')).toBeNull();
  });

  describe('scroll affordance', () => {
    /**
     * Forces the scrolling body into a chosen geometry and lets the component
     * re-measure it.
     *
     * The geometry has to be stubbed: this test DOM lays nothing out, so a real
     * body reports `scrollHeight`, `clientHeight` and `scrollTop` all as 0 and
     * every module would look like it fits. The properties are redefined on the
     * element rather than mocked on the component so the measurement under test
     * is the real one, reading the real element through the real view reference.
     *
     * The event is dispatched on the element instead of calling the handler, so
     * the listener registration - which happens outside Angular - is part of what
     * is covered.
     */
    const setBodyGeometry = ({
      clientHeight,
      clientWidth = 0,
      scrollHeight,
      scrollLeft = 0,
      scrollTop,
      scrollWidth = 0
    }: {
      clientHeight: number;
      clientWidth?: number;
      scrollHeight: number;
      scrollLeft?: number;
      scrollTop: number;
      scrollWidth?: number;
    }) => {
      const body = query<HTMLElement>('.gridster-item-content');

      for (const [property, value] of Object.entries({
        clientHeight,
        clientWidth,
        scrollHeight,
        scrollLeft,
        scrollTop,
        scrollWidth
      })) {
        Object.defineProperty(body, property, {
          configurable: true,
          value
        });
      }

      body.dispatchEvent(new Event('scroll'));

      fixture.detectChanges();
    };

    const hintAbove = () => {
      return query('.gf-dashboard-module-scroll-hint-above');
    };

    const hintBelow = () => {
      return query('.gf-dashboard-module-scroll-hint-below');
    };

    const hintEnd = () => {
      return query('.gf-dashboard-module-scroll-hint-end');
    };

    const hintStart = () => {
      return query('.gf-dashboard-module-scroll-hint-start');
    };

    /**
     * Runs every scheduled frame callback immediately.
     *
     * Installed before the fixture is first rendered, because the watcher books
     * its first measurement during `ngAfterViewInit`. Without this the assertions
     * would race a real frame that Jest's fake DOM may never paint.
     */
    beforeEach(async () => {
      jest
        .spyOn(window, 'requestAnimationFrame')
        .mockImplementation((callback: FrameRequestCallback) => {
          callback(0);

          return 0;
        });

      await bindResolvingDefinition();
    });

    afterEach(() => {
      jest.mocked(window.requestAnimationFrame).mockRestore();
    });

    it('should keep the scrolling body inside the positioned wrapper', () => {
      // The wrapper is what the hints are positioned against, and the body must
      // stay the element carrying the grid's ignore-content class - otherwise a
      // drag would start from anywhere in the module's content.
      expect(
        query('.gf-dashboard-module-body > .gridster-item-content')
      ).toBeTruthy();
    });

    it('should mark nothing when the body fits', () => {
      setBodyGeometry({ clientHeight: 200, scrollHeight: 200, scrollTop: 0 });

      expect(component.hasOverflowAbove).toBe(false);
      expect(component.hasOverflowBelow).toBe(false);

      expect(hintAbove()).toBeNull();
      expect(hintBelow()).toBeNull();
    });

    it('should mark only below while the body sits at its start', () => {
      setBodyGeometry({ clientHeight: 200, scrollHeight: 500, scrollTop: 0 });

      expect(component.hasOverflowAbove).toBe(false);
      expect(component.hasOverflowBelow).toBe(true);

      expect(hintAbove()).toBeNull();
      expect(hintBelow()).toBeTruthy();
    });

    it('should mark both directions in the middle of a scroll', () => {
      setBodyGeometry({ clientHeight: 200, scrollHeight: 500, scrollTop: 150 });

      expect(component.hasOverflowAbove).toBe(true);
      expect(component.hasOverflowBelow).toBe(true);

      expect(hintAbove()).toBeTruthy();
      expect(hintBelow()).toBeTruthy();
    });

    it('should stop marking below once the end is reached', () => {
      setBodyGeometry({ clientHeight: 200, scrollHeight: 500, scrollTop: 300 });

      expect(component.hasOverflowAbove).toBe(true);
      expect(component.hasOverflowBelow).toBe(false);

      expect(hintAbove()).toBeTruthy();
      expect(hintBelow()).toBeNull();
    });

    it('should tolerate a sub-pixel remainder at the end of a scroll', () => {
      // A fractional layout leaves less than a pixel unscrolled; treating that as
      // "more below" would leave the hint permanently lit, which says nothing.
      setBodyGeometry({
        clientHeight: 200,
        scrollHeight: 500,
        scrollTop: 299.6
      });

      expect(component.hasOverflowBelow).toBe(false);

      expect(hintBelow()).toBeNull();
    });

    it('should mark only the end edge while a wide body sits at its start', () => {
      setBodyGeometry({
        clientHeight: 200,
        clientWidth: 400,
        scrollHeight: 200,
        scrollLeft: 0,
        scrollTop: 0,
        scrollWidth: 900
      });

      expect(component.hasOverflowStart).toBe(false);
      expect(component.hasOverflowEnd).toBe(true);

      expect(hintStart()).toBeNull();
      expect(hintEnd()).toBeTruthy();

      // A body that fits vertically must not be marked vertically.
      expect(hintAbove()).toBeNull();
      expect(hintBelow()).toBeNull();
    });

    it('should mark both inline edges in the middle of a sideways scroll', () => {
      setBodyGeometry({
        clientHeight: 200,
        clientWidth: 400,
        scrollHeight: 200,
        scrollLeft: 250,
        scrollTop: 0,
        scrollWidth: 900
      });

      expect(component.hasOverflowStart).toBe(true);
      expect(component.hasOverflowEnd).toBe(true);

      expect(hintStart()).toBeTruthy();
      expect(hintEnd()).toBeTruthy();
    });

    it('should read a right-to-left scroll offset by its distance from the start', () => {
      // A right-to-left locale reports the offset as a negative number; taking it
      // at face value would leave the start edge unmarked no matter how far the
      // reader had travelled.
      setBodyGeometry({
        clientHeight: 200,
        clientWidth: 400,
        scrollHeight: 200,
        scrollLeft: -250,
        scrollTop: 0,
        scrollWidth: 900
      });

      expect(component.hasOverflowStart).toBe(true);
      expect(component.hasOverflowEnd).toBe(true);
    });

    it('should stop marking the end edge once the far side is reached', () => {
      setBodyGeometry({
        clientHeight: 200,
        clientWidth: 400,
        scrollHeight: 200,
        scrollLeft: 500,
        scrollTop: 0,
        scrollWidth: 900
      });

      expect(component.hasOverflowStart).toBe(true);
      expect(component.hasOverflowEnd).toBe(false);

      expect(hintStart()).toBeTruthy();
      expect(hintEnd()).toBeNull();
    });

    it('should mark all four edges when a body continues in every direction', () => {
      setBodyGeometry({
        clientHeight: 200,
        clientWidth: 400,
        scrollHeight: 500,
        scrollLeft: 250,
        scrollTop: 150,
        scrollWidth: 900
      });

      expect(hintAbove()).toBeTruthy();
      expect(hintBelow()).toBeTruthy();
      expect(hintEnd()).toBeTruthy();
      expect(hintStart()).toBeTruthy();
    });

    it('should keep the hints out of the accessibility tree', () => {
      // They duplicate nothing: the whole module subtree is in the accessibility
      // tree whether or not it is scrolled into view.
      setBodyGeometry({ clientHeight: 200, scrollHeight: 500, scrollTop: 150 });

      expect(hintAbove().getAttribute('aria-hidden')).toBe('true');
      expect(hintBelow().getAttribute('aria-hidden')).toBe('true');
    });

    it('should survive an environment without a ResizeObserver', () => {
      // This test DOM provides none, so reaching for one unguarded would have
      // thrown during `ngAfterViewInit` and taken the whole module host down.
      // Reaching the assertions at all is the proof; the scroll path still works.
      expect(query('mat-card')).toBeTruthy();

      setBodyGeometry({ clientHeight: 200, scrollHeight: 500, scrollTop: 0 });

      expect(hintBelow()).toBeTruthy();
    });

    it('should release its observers and its pending frame on destroy', () => {
      const body = query<HTMLElement>('.gridster-item-content');
      const removeEventListener = jest.spyOn(body, 'removeEventListener');
      const cancelAnimationFrame = jest.spyOn(window, 'cancelAnimationFrame');

      fixture.destroy();

      expect(removeEventListener).toHaveBeenCalledWith(
        'scroll',
        expect.any(Function)
      );

      expect(cancelAnimationFrame).toHaveBeenCalled();

      cancelAnimationFrame.mockRestore();
    });

    it('should clear a hint once content that sized itself catches up', async () => {
      // The regression this covers, observed at runtime: narrowing the viewport
      // resizes the body in one frame while a chart canvas inside it is still
      // reporting its old width, so a hint is drawn from that transient
      // measurement. The canvas then reflows - and that reflow adds no node,
      // removes no node and changes no text, it only rewrites an attribute. An
      // observer that ignores attributes therefore never hears about it, the
      // body never changes size again, and the hint advertises overflow that no
      // longer exists until something unrelated happens to scroll.
      setBodyGeometry({
        clientHeight: 200,
        clientWidth: 200,
        scrollHeight: 200,
        scrollTop: 0,
        scrollWidth: 900
      });

      expect(hintEnd()).toBeTruthy();

      const body = query<HTMLElement>('.gridster-item-content');
      const content = body.firstElementChild;

      // Guarded rather than assumed: with nothing in the body there would be no
      // attribute to rewrite and the test would pass without exercising anything.
      expect(content).toBeTruthy();

      Object.defineProperty(body, 'scrollWidth', {
        configurable: true,
        value: 200
      });

      content.setAttribute('width', '200');

      await flushObservers();

      fixture.detectChanges();

      expect(hintEnd()).toBeNull();
    });
  });

  describe('scroll affordance size watching', () => {
    class FakeResizeObserver {
      public static instances: FakeResizeObserver[] = [];

      public observed: Element[] = [];

      public unobserved: Element[] = [];

      public constructor(public callback: () => void) {
        FakeResizeObserver.instances.push(this);
      }

      public disconnect() {
        this.observed = [];
      }

      public observe(target: Element) {
        this.observed.push(target);
      }

      public unobserve(target: Element) {
        this.unobserved.push(target);

        this.observed = this.observed.filter((element) => {
          return element !== target;
        });
      }
    }

    /**
     * Installs the stand-in before the view is ever rendered.
     *
     * The order matters: the watcher registers during `ngAfterViewInit`, which
     * the first change-detection pass triggers, so a stand-in installed after
     * that pass would never be the one under test. The outer `beforeEach` only
     * creates the fixture, which is what leaves room to render it here.
     */
    beforeEach(async () => {
      FakeResizeObserver.instances = [];

      (globalThis as { ResizeObserver?: unknown }).ResizeObserver =
        FakeResizeObserver;

      jest
        .spyOn(window, 'requestAnimationFrame')
        .mockImplementation((callback: FrameRequestCallback) => {
          callback(0);

          return 0;
        });

      await bindResolvingDefinition();
    });

    afterEach(() => {
      jest.mocked(window.requestAnimationFrame).mockRestore();

      delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
    });

    it('should watch what fills the body as well as the body itself', () => {
      const body = query<HTMLElement>('.gridster-item-content');
      const [observer] = FakeResizeObserver.instances;

      expect(observer).toBeTruthy();
      expect(observer.observed).toContain(body);

      // The second target is the load-bearing one. The body settles at its new
      // size on the first frame of a resize and never reports again, so content
      // that catches up afterwards is only visible through its own box.
      expect(observer.observed).toContain(body.firstElementChild);
      expect(observer.observed).toHaveLength(2);
    });

    it('should follow the body content when it is replaced', () => {
      const body = query<HTMLElement>('.gridster-item-content');
      const [observer] = FakeResizeObserver.instances;
      const previous = body.firstElementChild;

      const replacement = document.createElement('div');

      body.replaceChildren(replacement);

      // Any notification is enough to bring the watch back in step, and a scroll
      // is the one this test can raise without depending on observer timing.
      body.dispatchEvent(new Event('scroll'));

      // A watch left on the replaced node is worse than an error: a detached
      // element never reports a size change, so the signal would go quiet for
      // good with nothing to show that it had.
      expect(observer.unobserved).toContain(previous);
      expect(observer.observed).toEqual([body, replacement]);
    });
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
