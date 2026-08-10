import { Component, Type } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { readFileSync } from 'fs';
import { setImmediate } from 'node:timers';
import { join } from 'path';

import { DashboardModuleType } from '../../enums/dashboard-module-type';
import type {
  DashboardModuleDefinition,
  DashboardModuleGeometryStep
} from '../../interfaces/interfaces';
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

  /**
   * The module title is a heading, and the level it declares is what gives this
   * canvas a document outline at all.
   *
   * The screens this replaced each opened with a page heading, and the module
   * wrappers hide the one their hosted screen still renders - so with the shell gone
   * the finished canvas contained no heading of any level anywhere, measured as an
   * empty result for every heading selector and every heading audit reporting `not
   * applicable`. That takes away the first shortcut a screen-reader user reaches for:
   * walk the headings to find out what is on the page.
   */
  it('should declare its title as a second-level heading', async () => {
    await bindResolvingDefinition();

    const title = query('mat-card-title');

    expect(title.getAttribute('role')).toBe('heading');

    // One level below the canvas's own heading, whatever order the arrangement puts
    // the modules in: a module is a part of the dashboard, not a section of another
    // module.
    expect(title.getAttribute('aria-level')).toBe('2');
  });

  /**
   * Declared as a role and a level rather than by swapping in an `<h2>` element,
   * which would have repainted every module header with the browser's default
   * heading type and margins. This asserts the visual result of that choice rather
   * than the choice: the title keeps the classes that give it the card's own title
   * type and its truncation behaviour, and gains no heading element.
   */
  it('should carry that heading without changing how the header looks', async () => {
    await bindResolvingDefinition();

    const title = query('mat-card-title');

    expect(title.tagName).toBe('MAT-CARD-TITLE');
    expect(title.classList).toContain('text-truncate');
    expect(title.classList).toContain('mb-0');
    expect(query('h1, h2, h3, h4, h5, h6')).toBeNull();
  });

  // The heading names the module, and the qualifier is part of that name: two cards
  // headed `Settings` are two identical entries in an outline.
  it('should name the module in that heading, qualifier included', async () => {
    fixture.componentRef.setInput('definition', {
      ...createDefinition(() =>
        Promise.resolve<Type<unknown>>(GfFirstTestModuleComponent)
      ),
      context: 'Admin Control',
      name: 'Settings'
    });

    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const title = query('mat-card-title');

    expect(title.getAttribute('role')).toBe('heading');
    expect(title.textContent.trim()).toBe('Settings · Admin Control');
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

    // The gutter is this component's own declaration and NOT the Bootstrap `p-3`
    // utility it used to carry, which is asserted here because the utility was
    // the defect rather than the mechanism: `.p-3` resolves to
    // `padding: 1rem !important`, and `!important` outranks every non-important
    // declaration whatever its specificity - including the conditional trailing
    // reserve the canvas sets on modules that have to clear a floating button.
    // That reserve was computed and then discarded on every one of them, so a
    // module's last row sat 16px from the card edge instead of 80px, underneath
    // the button. Re-adding the class would silently restore the defect while
    // every other assertion here kept passing, so its ABSENCE is the assertion.
    expect(query('.gridster-item-content').classList).not.toContain('p-3');
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

  /**
   * Focus after the handle is pressed with a pointer.
   *
   * The grid starts a drag on `mousedown` and `touchstart` and calls
   * `preventDefault` on both, which is what suppresses the focus a press normally
   * confers. The result is a handle that advertises eight arrow-key shortcuts and,
   * after a press, has none of them working: focus is still on the document body,
   * so the next arrow key is swallowed with no move, no message and nothing to
   * explain it - and a viewer who nudges a module with the pointer and then reaches
   * for the keyboard to line it up is exactly who meets that.
   */
  it('should take focus when the handle is pressed', async () => {
    await bindResolvingDefinition();

    const handle = query<HTMLButtonElement>('.gf-dashboard-module-drag-handle');

    expect(document.activeElement).not.toBe(handle);

    // `pointerdown` rather than `mousedown`, because it fires before both of the
    // events the grid listens on - so focus is already here by the time either
    // `preventDefault` runs, and `preventDefault` suppresses a focus that has not
    // happened yet rather than undoing one that has. Dispatched on the element so
    // the template binding is part of what this covers.
    handle.dispatchEvent(new Event('pointerdown', { bubbles: true }));

    fixture.detectChanges();

    expect(document.activeElement).toBe(handle);
  });

  /**
   * The focus ring for this chrome, and the shape of the rule that carries it.
   *
   * The only item in this chrome's menu REMOVES the module, and a Material menu
   * panel is moved into an overlay attached to the document body - so a rule nested
   * inside `:host` compiles to a host-descendant selector that can never match it,
   * and the most consequential control here had nothing at all to show under
   * keyboard focus while every other control did. It is asserted from the source
   * because this environment applies no component stylesheet and renders no
   * overlay; the rendered ring is measured in a browser.
   */
  describe('the focus ring that has to reach a portalled menu row', () => {
    const readStylesheet = () => {
      return readFileSync(
        join(__dirname, 'dashboard-module-host.scss'),
        'utf8'
      ).replace(/^\s*\/\/.*$/gm, '');
    };

    it('should declare the ring outside the host', () => {
      // At column zero. Emulated encapsulation still stamps the menu row with this
      // component's content attribute, so an unnested `button` selector reaches the
      // card AND the panel while matching nothing a mounted module renders.
      expect(readStylesheet()).toMatch(/^button:focus-visible \{/m);
    });

    it('should not nest a ring under the host, where the menu cannot be reached', () => {
      // Indentation only, not `\s`, which spans the newlines the comment strip
      // leaves behind and would match the column-zero rule itself.
      const nested = readStylesheet().match(/^[ \t]+button:focus-visible/gm);

      expect(nested).toBeNull();
    });

    it('should take its colour from the inherited one', () => {
      const source = readStylesheet();
      const start = source.indexOf('button:focus-visible {');
      const ring = source.slice(start, source.indexOf('}', start));

      // `currentColor` is the only value correct in both places the rule reaches:
      // the card sets a themed colour its header controls inherit, and a menu row
      // inherits the themed colour of the panel it sits in. A literal ink would need
      // a `.theme-dark` mirror, and encapsulation rewrites that mirror into a
      // selector requiring this component's content attribute on the document body -
      // so it would compile, lint, ship and match nothing.
      expect(ring).toContain('outline: 2px solid currentColor;');
      expect(ring).toContain('outline-offset: 2px;');
    });

    /**
     * The drag handle's ring, and the specificity that decides which declaration
     * paints it.
     *
     * The handle carries no trailing margin, deliberately, so that a narrow module
     * keeps its header width for the title. An outward ring therefore lands in the
     * title's box - measured in a browser at 4px by 20px, painted over the stem of
     * the first glyph of the module's name.
     *
     * The correction has to go on the handle's OWN rule, which is nested under
     * `:host`. That nesting is exactly what made the first attempt inert: a sibling
     * of the column-zero `button:focus-visible` rule above compiles one specificity
     * step short of it, so the declaration shipped and never applied. Asserted as a
     * position rather than as a value for that reason - a `-2px` sitting in the
     * wrong rule is indistinguishable from no fix at all.
     */
    it('should draw the drag-handle ring inside the handle, on the rule that wins', () => {
      const source = readStylesheet();
      const handle = source.indexOf('.gf-dashboard-module-drag-handle {');

      expect(handle).toBeGreaterThan(-1);

      // The handle's own rule is nested under the host, so it outranks anything
      // written beside the shared rule at column zero.
      expect(source.slice(0, handle)).toContain(':host {');

      const ring = source.indexOf('&:focus-visible {', handle);

      expect(ring).toBeGreaterThan(-1);

      expect(source.slice(ring, source.indexOf('}', ring))).toContain(
        'outline-offset: -2px;'
      );
    });

    it('should not leave an outward drag-handle ring anywhere in the sheet', () => {
      const source = readStylesheet();

      // The failed first attempt, and the shape it would take again: a rule for the
      // handle written as a sibling of the shared one, where it cannot win.
      expect(source).not.toContain('&.gf-dashboard-module-drag-handle {');
    });

    it('should draw the ring inside a menu row rather than around it', () => {
      const source = readStylesheet();
      const start = source.indexOf('&.mat-mdc-menu-item {');

      expect(start).toBeGreaterThan(-1);

      // A menu panel is sized to its widest row and clips its overflow, so an
      // outward offset is trimmed on the left and right and only the top and bottom
      // edges of the ring survive.
      expect(source.slice(start, source.indexOf('}', start))).toContain(
        'outline-offset: -2px;'
      );
    });
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

    // The sentence, and nothing about the failure beyond it plus the way out of
    // it - asserted as a containment rather than an equality because the body now
    // carries a recovery action, and asserted for the action too so that the
    // "contained" state is not read as "silent". A module fails to arrive almost
    // always transiently - a chunk request lost to a dropped connection, a service
    // worker holding a stale manifest - and without an action the only recovery was
    // reloading the whole canvas or removing and re-adding the module, which is a
    // layout write to recover from something that was never a layout problem.
    const alert = query('.gridster-item-content [role="alert"]');

    expect(alert.textContent).toContain('Oops! Something went wrong.');
    expect(alert.querySelector('button')).toBeTruthy();
    expect(query('ngx-skeleton-loader')).toBeNull();

    expectChromeToBeRendered();
  });

  // The action re-mounts only this module. Asserted through the same public entry
  // point the canvas uses for a global reload, so the button cannot drift onto a
  // second recovery path, and asserted to move NO cell - a failed chunk request is
  // not a layout event and must not become one.
  it('should re-mount just the failed module when its retry is pressed', async () => {
    const unhandledReasons = collectUnhandledRejections();
    let attempt = 0;

    fixture.componentRef.setInput(
      'definition',
      createDefinition(() => {
        attempt += 1;

        return attempt === 1
          ? Promise.reject(createChunkFailure())
          : Promise.resolve<Type<unknown>>(GfFirstTestModuleComponent);
      })
    );

    await settle();

    await new Promise((resolve) => {
      setImmediate(resolve);
    });

    fixture.detectChanges();

    expect(component.hasLoadError).toBe(true);

    const moveEvents: unknown[] = [];
    const removeEvents: unknown[] = [];
    const resizeEvents: unknown[] = [];

    component.move.subscribe((event) => moveEvents.push(event));
    component.remove.subscribe((event) => removeEvents.push(event));
    component.resize.subscribe((event) => resizeEvents.push(event));

    query<HTMLButtonElement>(
      '.gridster-item-content [role="alert"] button'
    ).click();

    await settle();

    expect(attempt).toBe(2);
    expect(component.hasLoadError).toBe(false);
    expect(query('.gridster-item-content [role="alert"]')).toBeNull();
    expect(query('gf-first-test-module')).not.toBeNull();

    expect(moveEvents).toEqual([]);
    expect(removeEvents).toEqual([]);
    expect(resizeEvents).toEqual([]);
    expect(unhandledReasons).toEqual([]);
  });

  /**
   * Getting out of a failed load.
   *
   * The state these tests are about used to be a dead end. A module whose chunk
   * failed said only that something had gone wrong and offered nothing: not on the
   * card, not in its menu, and not from the control bar, whose refresh asked for the
   * module again and received the same failure. Removing the module and adding it
   * back failed identically, because the browser records a failed dynamic import
   * against the chunk's url for the lifetime of the DOCUMENT - measured as an
   * instant rejection with no network request at all, while a plain `fetch()` of the
   * same url returned 200.
   *
   * So there are two recoveries, and which one is right depends on evidence the
   * component can only get by trying. The first failure is offered a retry, because
   * a retry is cheap and genuinely fixes the failures that are not chunk failures.
   * The second failure IS the evidence that this one is, and the module then offers
   * the document reload, which always works.
   */
  describe('recovering from a failed load', () => {
    /**
     * Binds a definition whose loader rejects, and drains the turn of the event
     * loop that decides whether the rejection went unhandled.
     *
     * @returns The rejections nothing handled, so every caller asserts that its
     * failure was absorbed rather than escaping the cell.
     */
    const bindFailingDefinition = async (
      loadComponent: () => Promise<Type<unknown>> = () =>
        Promise.reject(createChunkFailure())
    ) => {
      const unhandledReasons = collectUnhandledRejections();

      fixture.componentRef.setInput(
        'definition',
        createDefinition(loadComponent)
      );

      await settle();

      await new Promise((resolve) => {
        setImmediate(resolve);
      });

      fixture.detectChanges();

      return unhandledReasons;
    };

    /** The recovery actions the failed body is offering, by their visible text. */
    const recoveryActions = () => {
      return Array.from(
        query('.gridster-item-content [role="alert"]').querySelectorAll(
          'button'
        )
      ).map((button) => button.textContent.trim());
    };

    /**
     * Collects the reports jsdom emits for a navigation it will not perform.
     *
     * Registered by extending the suite's existing `console.error` interception for
     * the duration of one test, and torn down by that spy's own restore in
     * `afterEach`, so nothing here can leak into the tests that follow.
     */
    const navigationReports = () => {
      const reports: string[] = [];
      const forward = consoleErrorSpy.getMockImplementation();

      consoleErrorSpy.mockImplementation((...args: unknown[]) => {
        const [detail] = args;

        // Matched on shape rather than with `instanceof`: jsdom raises this from its
        // own realm, so `detail instanceof Error` is false for the very object that
        // arrives.
        const report =
          Object.prototype.toString.call(detail) === '[object Error]'
            ? (detail as Error).message
            : typeof detail === 'string'
              ? detail
              : '';

        if (report.includes('Not implemented: navigation')) {
          reports.push(report);

          return;
        }

        forward(...args);
      });

      return reports;
    };

    const pressRecoveryAction = (label: string) => {
      const action = Array.from(
        query(
          '.gridster-item-content [role="alert"]'
        ).querySelectorAll<HTMLButtonElement>('button')
      ).find((button) => button.textContent.trim() === label);

      expect(action).toBeTruthy();

      action.click();
    };

    it('should offer a retry on the first failure', async () => {
      expect(await bindFailingDefinition()).toEqual([]);

      expect(component.hasLoadError).toBe(true);
      expect(component.loadFailureCount).toBe(1);
      expect(component.hasExhaustedInPlaceRecovery).toBe(false);
      expect(recoveryActions()).toEqual(['Try again']);
    });

    it('should ask for the module again when the retry is pressed', async () => {
      const attempts: number[] = [];

      await bindFailingDefinition(() => {
        attempts.push(attempts.length);

        return Promise.reject(createChunkFailure());
      });

      expect(attempts).toHaveLength(1);

      const unhandledReasons = collectUnhandledRejections();

      pressRecoveryAction('Try again');

      await settle();

      await new Promise((resolve) => {
        setImmediate(resolve);
      });

      fixture.detectChanges();

      // The point of the retry: the loader really is called a second time. What the
      // browser does with that call is the browser's business, and is exactly why
      // the escalation below exists.
      expect(attempts).toHaveLength(2);
      expect(unhandledReasons).toEqual([]);
    });

    it('should recover in place when the retry succeeds', async () => {
      let shouldFail = true;

      await bindFailingDefinition(() => {
        if (shouldFail) {
          return Promise.reject(createChunkFailure());
        }

        return Promise.resolve<Type<unknown>>(GfFirstTestModuleComponent);
      });

      shouldFail = false;

      pressRecoveryAction('Try again');

      await settle();

      expect(component.hasLoadError).toBe(false);
      expect(query('.gf-first-test-module-body')).toBeTruthy();
      expect(query('.gridster-item-content [role="alert"]')).toBeNull();

      // Reset by the success, so a module that fails again much later is offered a
      // retry again rather than being told at once to reload the page.
      expect(component.loadFailureCount).toBe(0);
      expect(component.hasExhaustedInPlaceRecovery).toBe(false);
    });

    it('should escalate to a document reload once a retry has failed', async () => {
      await bindFailingDefinition();

      const unhandledReasons = collectUnhandledRejections();

      pressRecoveryAction('Try again');

      await settle();

      await new Promise((resolve) => {
        setImmediate(resolve);
      });

      fixture.detectChanges();

      expect(unhandledReasons).toEqual([]);
      expect(component.loadFailureCount).toBe(2);
      expect(component.hasExhaustedInPlaceRecovery).toBe(true);

      // The retry is withdrawn rather than kept alongside: offering it again would
      // be offering something now known not to work.
      expect(recoveryActions()).toEqual(['Reload page']);

      // And the escalated state says why, so the reload reads as the remedy rather
      // than as a shrug.
      expect(
        query('.gridster-item-content [role="alert"]').textContent
      ).toContain('cannot be loaded again on its own');
    });

    it('should reload the document when the escalated action is pressed', async () => {
      await bindFailingDefinition();

      pressRecoveryAction('Try again');

      await settle();

      await new Promise((resolve) => {
        setImmediate(resolve);
      });

      fixture.detectChanges();

      // Observed through the report jsdom emits rather than by replacing the method.
      // `window.location` and its members are `[LegacyUnforgeable]` here, so
      // `Object.defineProperty(window, 'location', …)` throws `Cannot redefine
      // property: location` and spying on `reload` throws `Cannot assign to read
      // only property`. What jsdom DOES give is a virtual-console error for the
      // navigation it will not perform, and `reload()` reaches it even though the
      // address is unchanged - it sets `reloadTriggered`, which is what bypasses the
      // same-url short-circuit. This is the technique every other suite in this tree
      // uses for the same reason.
      const navigationAttempts = navigationReports();

      pressRecoveryAction('Reload page');

      expect(navigationAttempts).toHaveLength(1);
    });

    it('should count the arrangement-wide refresh as an attempt', async () => {
      await bindFailingDefinition();

      expect(component.hasExhaustedInPlaceRecovery).toBe(false);

      const unhandledReasons = collectUnhandledRejections();

      // What the control bar does to every module. For a module that is already
      // failing it is the same request the retry makes, so it counts the same way -
      // otherwise a viewer who reached for refresh first would be shown a retry that
      // had, in substance, already been spent.
      component.reload();

      await settle();

      await new Promise((resolve) => {
        setImmediate(resolve);
      });

      fixture.detectChanges();

      expect(unhandledReasons).toEqual([]);
      expect(component.hasExhaustedInPlaceRecovery).toBe(true);
      expect(recoveryActions()).toEqual(['Reload page']);
    });

    it('should treat a loader that resolves to nothing as a failure it can retry', async () => {
      await bindFailingDefinition(() =>
        Promise.resolve<Type<unknown>>(undefined)
      );

      expect(component.hasLoadError).toBe(true);
      expect(component.loadFailureCount).toBe(1);
      expect(recoveryActions()).toEqual(['Try again']);
    });

    it('should move no cell and emit nothing while recovering', async () => {
      const moveSteps: DashboardModuleGeometryStep[] = [];
      const resizeSteps: DashboardModuleGeometryStep[] = [];

      let removeCount = 0;

      component.move.subscribe((step) => moveSteps.push(step));
      component.remove.subscribe(() => (removeCount += 1));
      component.resize.subscribe((step) => resizeSteps.push(step));

      await bindFailingDefinition();

      pressRecoveryAction('Try again');

      await settle();

      await new Promise((resolve) => {
        setImmediate(resolve);
      });

      // Recovery is not an arrangement change. Nothing here may reach the canvas as
      // a move, a resize or a removal, because any of those would be persisted.
      expect(moveSteps).toEqual([]);
      expect(resizeSteps).toEqual([]);
      expect(removeCount).toBe(0);
    });
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

  /**
   * Where the canvas is left when something opened from inside a module closes.
   *
   * The scrolling body is focusable, because a scrolling region that cannot be
   * focused cannot be scrolled from the keyboard - which also makes it the element
   * focus sits on when a dialog is opened from within the module, and therefore the
   * element that dialog restores focus to. A menu restores focus to its trigger
   * instead. A module is routinely taller than the grid's viewport, so the element
   * focus comes back to usually straddles it, and restoring focus to an element that
   * is not fully in view makes the browser scroll it in. What moves is the GRID, not
   * the module: the viewer opened something, dismissed it, and came back several
   * hundred pixels away from where they were, having scrolled nothing themselves.
   *
   * `preventScroll` is not available as a remedy, because the `focus()` call belongs
   * to the dialog or the menu trigger, and those dialogs are opened by the feature
   * components mounted inside modules rather than by anything here.
   *
   * What separates a hand-back from a viewer arriving is where focus sat in
   * between, not the origin the CDK reports: Material stamps its restore with the
   * interaction that dismissed the overlay, so these arrive as `keyboard` and
   * `mouse` and never as `program`.
   */
  describe('keeping the canvas still when focus is handed back', () => {
    /**
     * A scrollable stand-in for the grid, wrapped around the fixture's own host.
     *
     * The real ancestor is the `gridster` element, which this spec deliberately does
     * not mount - the whole point of this component is that it knows nothing about
     * the grid. What it walks is `parentElement`, so any scrollable ancestor
     * exercises the same code, and one built here can report a geometry that jsdom
     * would otherwise pin to zero.
     */
    const createScrollableAncestor = () => {
      const ancestor = document.createElement('div');

      Object.defineProperty(ancestor, 'clientHeight', {
        configurable: true,
        value: 400
      });
      Object.defineProperty(ancestor, 'scrollHeight', {
        configurable: true,
        value: 2000
      });
      Object.defineProperty(ancestor, 'clientWidth', {
        configurable: true,
        value: 800
      });
      Object.defineProperty(ancestor, 'scrollWidth', {
        configurable: true,
        value: 800
      });

      const host = fixture.nativeElement as HTMLElement;

      host.parentElement.insertBefore(ancestor, host);
      ancestor.appendChild(host);

      return ancestor;
    };

    const scrollport = () => query<HTMLElement>('.gridster-item-content');

    let overlayContainer: HTMLElement;

    /**
     * A focusable element inside a real CDK overlay container.
     *
     * The class is the discriminator the component reads, and it is a structural
     * fact of the CDK rather than anything this application applies, so the
     * stand-in carries the real one. Attached to the document body, exactly where
     * the CDK attaches it, so that a focus event dispatched inside it propagates
     * through `document` and reaches the component's listener.
     */
    const createOverlayFocusTarget = () => {
      overlayContainer = document.createElement('div');
      overlayContainer.classList.add('cdk-overlay-container');

      const pane = document.createElement('button');

      overlayContainer.appendChild(pane);
      document.body.appendChild(overlayContainer);

      return pane;
    };

    /**
     * Focus leaving the module for something outside it.
     *
     * `relatedTarget` left null by default: that is what a dialog opening looks
     * like, because focus leaves before the dialog's own focus trap has claimed it.
     */
    const focusOutFrom = (
      aElement: HTMLElement,
      aRelatedTarget: HTMLElement = null
    ) => {
      aElement.dispatchEvent(
        new FocusEvent('focusout', {
          bubbles: true,
          relatedTarget: aRelatedTarget
        })
      );

      fixture.detectChanges();
    };

    /**
     * Focus arriving on an element.
     *
     * Dispatched as a real event rather than by calling `focus()`, because jsdom
     * refuses focus to anything it considers unfocusable and the component reads
     * only the event's target. The component listens on `document` in the capture
     * phase, which is the phase every dispatched event traverses.
     */
    const focusInOn = (aElement: HTMLElement) => {
      aElement.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));

      fixture.detectChanges();
    };

    // What the viewer scrolling does. The component listens for this on
    // `document` in the capture phase, because scroll events do not bubble.
    const scrollNoticed = (aElement: HTMLElement) => {
      aElement.dispatchEvent(new Event('scroll'));

      fixture.detectChanges();
    };

    beforeEach(() => {
      component.definition = createDefinition(() =>
        Promise.resolve(GfFirstTestModuleComponent)
      );

      fixture.detectChanges();
    });

    afterEach(() => {
      overlayContainer?.remove();
      overlayContainer = undefined;
    });

    it('should put the canvas back where it was when a dialog hands focus back', () => {
      const ancestor = createScrollableAncestor();
      const overlayTarget = createOverlayFocusTarget();

      ancestor.scrollTop = 1200;

      // Focus leaves as the dialog opens, which is the last moment the offset is
      // still the one the viewer chose, and the dialog's focus trap then claims it.
      focusOutFrom(scrollport());
      focusInOn(overlayTarget);

      // What the browser does when focus is restored to a partly-visible element.
      ancestor.scrollTop = 0;

      focusInOn(scrollport());

      expect(ancestor.scrollTop).toBe(1200);
    });

    it('should honour a scroll the viewer made while the overlay was up', () => {
      const ancestor = createScrollableAncestor();
      const overlayTarget = createOverlayFocusTarget();

      ancestor.scrollTop = 1200;

      focusOutFrom(scrollport());
      focusInOn(overlayTarget);

      // Scrolling with a menu or a non-modal panel open is perfectly ordinary, and
      // this is the offset the viewer is entitled to come back to - restoring the
      // one from when the overlay opened would throw them somewhere they had
      // already left.
      ancestor.scrollTop = 900;
      scrollNoticed(ancestor);

      ancestor.scrollTop = 0;

      focusInOn(scrollport());

      expect(ancestor.scrollTop).toBe(900);
    });

    it('should correct a hand-back to the chrome as well as to the body', () => {
      const ancestor = createScrollableAncestor();
      const overlayTarget = createOverlayFocusTarget();
      const actionsTrigger = query<HTMLElement>('.module-actions');

      ancestor.scrollTop = 1200;

      // Opening the module's own actions menu: focus moves to the menu panel,
      // which lives in an overlay outside this module.
      focusOutFrom(actionsTrigger);
      focusInOn(overlayTarget);

      ancestor.scrollTop = 0;

      // And closing it: Material restores focus to the trigger, which by then may
      // have scrolled out of view - the same defect as the dialog case, from a
      // different opener. Watching the whole host is what makes one correction
      // serve both.
      focusInOn(actionsTrigger);

      expect(ancestor.scrollTop).toBe(1200);
    });

    it('should decline to correct a return no overlay preceded', () => {
      const ancestor = createScrollableAncestor();

      ancestor.scrollTop = 1200;

      focusOutFrom(scrollport());

      // Nothing took focus in the meantime, so nothing is handing it back: this is
      // the viewer arriving, and the browser bringing what they focused into view
      // is the right answer.
      ancestor.scrollTop = 640;

      focusInOn(scrollport());

      expect(ancestor.scrollTop).toBe(640);
    });

    it('should abandon the correction once focus settles somewhere unrelated', () => {
      const ancestor = createScrollableAncestor();
      const overlayTarget = createOverlayFocusTarget();
      const elsewhere = document.createElement('button');

      document.body.appendChild(elsewhere);

      ancestor.scrollTop = 1200;

      focusOutFrom(scrollport());
      focusInOn(overlayTarget);

      // The overlay closed and focus went to the page rather than back here. A
      // record kept past this point would correct the viewer's next deliberate
      // arrival with an offset they have long since moved past.
      focusInOn(elsewhere);

      ancestor.scrollTop = 300;

      focusInOn(scrollport());

      expect(ancestor.scrollTop).toBe(300);

      elsewhere.remove();
    });

    it('should treat a move between its own controls as no departure at all', () => {
      const ancestor = createScrollableAncestor();
      const overlayTarget = createOverlayFocusTarget();
      const actionsTrigger = query<HTMLElement>('.module-actions');

      ancestor.scrollTop = 1200;

      // Tab from the body to the chrome: focus never leaves the module, so nothing
      // has been interrupted and nothing is owed.
      focusOutFrom(scrollport(), actionsTrigger);
      focusInOn(overlayTarget);

      ancestor.scrollTop = 400;

      focusInOn(actionsTrigger);

      expect(ancestor.scrollTop).toBe(400);
    });

    it('should restore only once per hand-back', () => {
      const ancestor = createScrollableAncestor();
      const overlayTarget = createOverlayFocusTarget();

      ancestor.scrollTop = 1200;

      focusOutFrom(scrollport());
      focusInOn(overlayTarget);

      ancestor.scrollTop = 0;

      focusInOn(scrollport());

      expect(ancestor.scrollTop).toBe(1200);

      // Whatever happens next belongs to the viewer. Holding the offset would fight
      // their own scrolling every time focus came back.
      ancestor.scrollTop = 50;

      focusInOn(scrollport());

      expect(ancestor.scrollTop).toBe(50);
    });

    it('should ignore an ancestor that does not scroll', () => {
      const ancestor = createScrollableAncestor();
      const overlayTarget = createOverlayFocusTarget();

      Object.defineProperty(ancestor, 'scrollHeight', {
        configurable: true,
        value: 400
      });

      ancestor.scrollTop = 1200;

      focusOutFrom(scrollport());
      focusInOn(overlayTarget);

      ancestor.scrollTop = 0;

      focusInOn(scrollport());

      // Nothing about it could have moved the module into view, so nothing about it
      // is this component's to put back.
      expect(ancestor.scrollTop).toBe(0);
    });

    it('should stop watching focus when the module goes away', () => {
      const removeEventListenerSpy = jest.spyOn(
        document,
        'removeEventListener'
      );

      fixture.destroy();

      // Left registered, these outlive the module they were watching for - and a
      // module is removed and re-added as often as the viewer likes.
      expect(removeEventListenerSpy).toHaveBeenCalledWith(
        'focusin',
        expect.any(Function),
        true
      );
      expect(removeEventListenerSpy).toHaveBeenCalledWith(
        'scroll',
        expect.any(Function),
        true
      );

      removeEventListenerSpy.mockRestore();
    });

    it('should leave the canvas alone once the module is gone', () => {
      const ancestor = createScrollableAncestor();
      const overlayTarget = createOverlayFocusTarget();
      const departing = scrollport();

      ancestor.scrollTop = 1200;

      focusOutFrom(departing);
      focusInOn(overlayTarget);

      fixture.destroy();

      ancestor.scrollTop = 0;

      // Dispatched from inside the overlay, which is still in the document, so the
      // event genuinely reaches any listener that survived teardown.
      focusInOn(overlayTarget);

      expect(ancestor.scrollTop).toBe(0);
    });
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
