import { DashboardModuleType } from '@ghostfolio/common/dashboard/enums/dashboard-module-type';

import { Component, Type } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
// The template marks its static strings for translation, and the compiler turns
// those into `$localize` calls that the application polyfill normally installs.
import '@angular/localize/init';

import type { DashboardModuleDefinition } from '../../interfaces/interfaces';
import { GfDashboardModuleHostComponent } from './dashboard-module-host.component';

@Component({
  selector: 'gf-test-module',
  template: '<p class="test-module-body">Module body</p>'
})
class GfTestModuleComponent {}

@Component({
  selector: 'gf-other-test-module',
  template: '<p class="other-test-module-body">Other module body</p>'
})
class GfOtherTestModuleComponent {}

describe('GfDashboardModuleHostComponent', () => {
  let component: GfDashboardModuleHostComponent;
  let fixture: ComponentFixture<GfDashboardModuleHostComponent>;

  /**
   * The shared contract requires the placement defaults and floors below, none of
   * which this component may read; `readMembers` records every access so the
   * isolation can be asserted rather than assumed.
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
      name: 'Holdings',
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
   * Two passes are required: the first delivers the bound input and paints the
   * pending state, and the second paints whatever the loader settled into once
   * the microtask queue has drained.
   */
  const settle = async () => {
    fixture.detectChanges();

    await fixture.whenStable();

    fixture.detectChanges();
  };

  beforeEach(async () => {
    // No collaborator is provided on purpose: the component must be constructible
    // without a data, registry or persistence dependency.
    await TestBed.configureTestingModule({
      imports: [GfDashboardModuleHostComponent]
    }).compileComponents();

    fixture = TestBed.createComponent(GfDashboardModuleHostComponent);
    component = fixture.componentInstance;
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('should render the module name and both grid contract class names', async () => {
    fixture.componentRef.setInput(
      'definition',
      createDefinition(() => Promise.resolve(GfTestModuleComponent))
    );

    await settle();

    expect(query('mat-card-title').textContent.trim()).toBe('Holdings');
    expect(query('.gf-dashboard-module-drag-handle')).toBeTruthy();
    expect(query('.gridster-item-content')).toBeTruthy();

    // The handle has to sit outside the ignored content region, or a press
    // anywhere in the module would start a drag.
    expect(
      query('.gridster-item-content .gf-dashboard-module-drag-handle')
    ).toBeNull();
  });

  it('should render the resolved module inside the content region', async () => {
    fixture.componentRef.setInput(
      'definition',
      createDefinition(() => Promise.resolve(GfTestModuleComponent))
    );

    fixture.detectChanges();

    expect(component.resolvedComponent).toBeUndefined();
    expect(component.hasLoadError).toBe(false);
    expect(query('ngx-skeleton-loader')).toBeTruthy();

    await settle();

    expect(component.resolvedComponent).toBe(GfTestModuleComponent);
    expect(component.hasLoadError).toBe(false);
    expect(query('.gridster-item-content .test-module-body')).toBeTruthy();
  });

  it('should invoke the loader exactly once for one definition', async () => {
    const loadComponent = jest.fn().mockResolvedValue(GfTestModuleComponent);
    const definition = createDefinition(loadComponent);

    fixture.componentRef.setInput('definition', definition);

    await settle();

    fixture.componentRef.setInput('definition', definition);

    await settle();

    expect(loadComponent).toHaveBeenCalledTimes(1);
  });

  it('should not read placement or visibility metadata', async () => {
    const readMembers: string[] = [];

    fixture.componentRef.setInput(
      'definition',
      createDefinition(
        () => Promise.resolve(GfTestModuleComponent),
        readMembers
      )
    );

    await settle();

    expect(readMembers).toEqual([]);
  });

  it('should emit remove exactly once per removal request', async () => {
    fixture.componentRef.setInput(
      'definition',
      createDefinition(() => Promise.resolve(GfTestModuleComponent))
    );

    await settle();

    let removeCount = 0;

    component.remove.subscribe(() => {
      removeCount = removeCount + 1;
    });

    query<HTMLButtonElement>('button[mat-icon-button]').click();

    await settle();

    document.querySelector<HTMLButtonElement>('.mat-mdc-menu-item').click();

    await settle();

    expect(removeCount).toBe(1);
  });

  it('should report a rejected load without escaping the cell', async () => {
    const unhandledReasons: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => {
      unhandledReasons.push(reason);
    };

    process.on('unhandledRejection', onUnhandledRejection);

    fixture.componentRef.setInput(
      'definition',
      createDefinition(() => Promise.reject(new Error('load failed')))
    );

    await settle();
    await new Promise((resolve) => setTimeout(resolve, 0));

    fixture.detectChanges();

    process.off('unhandledRejection', onUnhandledRejection);

    expect(unhandledReasons).toEqual([]);
    expect(component.hasLoadError).toBe(true);
    expect(component.resolvedComponent).toBeUndefined();
    expect(
      query('.gridster-item-content [role="alert"]').textContent.trim()
    ).toBe('Oops! Something went wrong.');
  });

  it('should report a loader that throws before returning a promise', async () => {
    fixture.componentRef.setInput(
      'definition',
      createDefinition(() => {
        throw new Error('load failed');
      })
    );

    await settle();

    expect(component.hasLoadError).toBe(true);
    expect(query('[role="alert"]')).toBeTruthy();
  });

  it('should report a loader that resolves with nothing', async () => {
    fixture.componentRef.setInput(
      'definition',
      createDefinition(() => Promise.resolve(undefined))
    );

    await settle();

    expect(component.hasLoadError).toBe(true);
    expect(component.resolvedComponent).toBeUndefined();
    expect(query('ngx-skeleton-loader')).toBeNull();
  });

  it('should discard a result that arrives for a superseded definition', async () => {
    let resolveSuperseded: (component: Type<unknown>) => void;

    fixture.componentRef.setInput(
      'definition',
      createDefinition(
        () =>
          new Promise<Type<unknown>>((resolve) => {
            resolveSuperseded = resolve;
          })
      )
    );

    // The first definition has to reach the component before it is replaced,
    // otherwise its loader is never invoked and nothing can arrive late.
    fixture.detectChanges();

    fixture.componentRef.setInput(
      'definition',
      createDefinition(() => Promise.resolve(GfOtherTestModuleComponent))
    );

    await settle();

    resolveSuperseded(GfTestModuleComponent);

    await settle();

    expect(component.resolvedComponent).toBe(GfOtherTestModuleComponent);
    expect(query('.other-test-module-body')).toBeTruthy();
    expect(query('.test-module-body')).toBeNull();
  });

  it('should report a missing definition instead of loading forever', async () => {
    await settle();

    expect(component.hasLoadError).toBe(true);
    expect(query('ngx-skeleton-loader')).toBeNull();
    expect(query('[role="alert"]')).toBeTruthy();
  });
});
