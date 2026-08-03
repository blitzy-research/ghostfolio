import { Component, Type } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
// The chrome marks its static strings for translation and the template compiler
// turns those into `$localize` calls. Nothing installs that global in a jsdom
// test environment, so it is installed here - and its position matters: this
// group is evaluated before the relative imports below, one of which reaches the
// shared module metadata that localizes its display names at module scope.
import '@angular/localize/init';

import { DashboardModuleType } from '../../enums/dashboard-module-type';
import type { DashboardModuleDefinition } from '../../interfaces/interfaces';
import { GfDashboardModuleHostComponent } from './dashboard-module-host.component';

/**
 * Stands in for a registered module.
 *
 * Declared here rather than imported from `modules/**` deliberately. The host
 * exists to keep module code behind a lazy boundary now that the lazy route
 * boundaries are gone, so a spec that reached for a real wrapper would pull that
 * wrapper and its whole dependency tree into the compilation graph and quietly
 * undo the property it is meant to be proving.
 */
@Component({
  selector: 'gf-first-test-module',
  template: '<p class="gf-first-test-module-body">First module body</p>'
})
class GfFirstTestModuleComponent {}

/**
 * A second, visually distinguishable stand-in, used where a test has to tell one
 * resolved module from another.
 */
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
   * The frame around a module - the part that has to survive whatever the module
   * itself does.
   */
  const expectChromeToBeRendered = () => {
    expect(query('mat-card')).toBeTruthy();
    expect(query('mat-card-header')).toBeTruthy();
    expect(query('.gf-dashboard-module-drag-handle')).toBeTruthy();
    expect(query('button[mat-icon-button]')).toBeTruthy();
  };

  beforeEach(async () => {
    // No provider is registered, and that omission is the point rather than an
    // economy: see the construction test below.
    await TestBed.configureTestingModule({
      imports: [GfDashboardModuleHostComponent]
    }).compileComponents();

    fixture = TestBed.createComponent(GfDashboardModuleHostComponent);
    component = fixture.componentInstance;
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

    // Verbatim: the name arrives already translated, so any casing, truncation
    // or decoration applied here would corrupt thirteen locales at once.
    expect(query('mat-card-title').textContent.trim()).toBe(moduleName);

    // The overflow trigger is the only route to removal, so its accessible name
    // is part of the contract rather than incidental.
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

    // Asserted against the rendered view rather than the backing field, and that
    // distinction is the whole value of this test: the component is `OnPush`, so
    // a resolution that forgot to mark the view would still set the field while
    // painting nothing at all. A field assertion would pass on that component.
    expect(query('.gf-first-test-module-body')).toBeNull();
    expect(query('ngx-skeleton-loader')).toBeTruthy();

    await settle();

    expect(query('.gf-first-test-module-body')).toBeTruthy();
    expect(query('ngx-skeleton-loader')).toBeNull();

    // Invocation lives here and nowhere else: the canvas hands over a thunk and
    // never calls it, so exactly one call per placed module is the contract that
    // keeps a module's code fetched once.
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

    // These two together are the drag contract. Everything interactive sits in
    // the region the grid ignores, so a press on the module's own content cannot
    // start a drag, while the handle sits outside it so a press there can. A
    // mismatch compiles, lints and renders cleanly, then fails silently.
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

    // Exactly once: the canvas owns the placement array and the write that
    // follows, so a second emission would cost a second persisted layout.
    expect(emitSpy).toHaveBeenCalledTimes(1);
  });

  it('should run its whole lifecycle with no data, persistence or navigation collaborator provided', async () => {
    // The testing module registers nothing but the component itself. Everything
    // below therefore runs against an injector that would throw
    // `NullInjectorError` the moment this component acquired a data service, an
    // HTTP client, a navigation dependency or the layout store - which is what
    // keeps the canvas the only origin of a saved layout change. Registering any
    // of those here to be safe would satisfy the injector and silently retire
    // the guard, so none is registered.
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

    // Resolution, rendering and removal all complete unaided, so the component
    // needs no collaborator to do its job.
    expect(query('.gf-first-test-module-body')).toBeTruthy();
    expect(removeCount).toBe(1);
  });

  it('should contain a rejected load inside its own cell', async () => {
    const unhandledReasons: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => {
      unhandledReasons.push(reason);
    };

    // Captured rather than suppressed: an escaping rejection would fail the run
    // here, and in the browser it would surface from a cell that is supposed to
    // absorb its own failure.
    process.on('unhandledRejection', onUnhandledRejection);

    fixture.componentRef.setInput(
      'definition',
      createDefinition(() => Promise.reject(new Error('load failed')))
    );

    await settle();
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });

    fixture.detectChanges();

    process.off('unhandledRejection', onUnhandledRejection);

    expect(unhandledReasons).toEqual([]);

    // An existing source message, reused character for character so the notice
    // is already translated in every shipped locale.
    expect(
      query('.gridster-item-content [role="alert"]').textContent.trim()
    ).toBe('Oops! Something went wrong.');
    expect(query('ngx-skeleton-loader')).toBeNull();

    // The failure is confined to the body region: the frame survives, so the
    // cell can still be moved and removed instead of becoming a dead tile.
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
    // A renamed or deleted export resolves successfully with `undefined`, which
    // would otherwise leave the loading placeholder up for good.
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

    // The first definition has to reach the component before it is replaced,
    // otherwise its loader never runs and nothing can arrive late.
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

    // The grid owns size and position and the layers above own who may see a
    // module, so touching either here would create a second opinion.
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

    // Checked across the prototype chain, so a computed accessor is caught as
    // readily as a field.
    expect(placementMembers.filter((member) => member in component)).toEqual(
      []
    );
  });
});
