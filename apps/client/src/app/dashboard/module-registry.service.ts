import {
  DashboardModule,
  dashboardModules
} from '@ghostfolio/common/dashboard';

import { Injectable } from '@angular/core';

import { dashboardModuleRegistrations } from './dashboard-module.registrations';
import { DashboardModuleType } from './enums/dashboard-module-type';
import type {
  DashboardModuleDefinition,
  DashboardModuleRegistration
} from './interfaces/interfaces';

/**
 * The shared metadata map under a fully general index type.
 *
 * `dashboardModules` is declared with `satisfies Record<DashboardModuleType,
 * DashboardModule>`, which keeps each entry's own narrow type - so reading
 * `permission` straight off an entry that does not declare one is a compile
 * error. Widening it once here, at the single point where this service consults
 * it, gives every lookup the uniform `DashboardModule` shape without weakening
 * the map's own declaration.
 */
const sharedDashboardModules: Record<DashboardModuleType, DashboardModule> =
  dashboardModules;

/**
 * The one and only way a module type can reach the dashboard canvas.
 *
 * The canvas never imports a module component and no module component imports
 * the canvas. Instead the canvas resolves a persisted `moduleType`
 * discriminator through this registry, awaits the definition's loader and hands
 * the resulting component type to `NgComponentOutlet`. That indirection is what
 * makes module isolation structural rather than conventional: because the only
 * handle on a module's component class is a thunk held in this map, there is no
 * expression a developer could write to insert a component into the grid
 * without registering it first.
 *
 * Composition of a definition is deliberately split across two sources:
 *
 * - `dashboardModuleRegistrations` supplies the application-side half - which
 *   component a discriminator resolves to, and how to fetch it lazily;
 * - `@ghostfolio/common/dashboard` supplies the framework-neutral half - the
 *   localized display name, the default footprint, the minimum footprint and
 *   the optional visibility permission - so that `libs/ui` can read the same
 *   metadata without importing application code.
 *
 * Neither half is ever duplicated, so a module's declared minimum footprint has
 * exactly one definition site and the grid engine's enforcement of it cannot
 * drift from what the catalog advertises.
 *
 * Registration is validated rather than trusted. A missing loader, a
 * discriminator with no shared metadata and a duplicate discriminator each
 * throw immediately, because every one of them is a static wiring mistake that
 * would otherwise surface much later as a cell that never paints. Lookup, by
 * contrast, is forgiving: an unknown discriminator returns `undefined` so that
 * a layout persisted before a module was renamed or withdrawn loses that one
 * entry instead of failing the whole canvas.
 *
 * @example
 * ```typescript
 * const definition = this.moduleRegistry.get(item.moduleType);
 *
 * if (!definition) {
 *   return; // A stale persisted entry; drop it and keep rendering.
 * }
 *
 * const moduleComponent = await definition.loadComponent();
 * ```
 */
@Injectable({ providedIn: 'root' })
export class DashboardModuleRegistryService {
  /**
   * Definitions keyed by discriminator.
   *
   * A `Map` rather than an object literal for two reasons: iteration order is
   * guaranteed to be insertion order, so the catalog's ordering is the
   * registration table's ordering; and a lookup can never collide with an
   * inherited `Object.prototype` member, which a persisted discriminator such
   * as `constructor` otherwise could.
   */
  private readonly definitions = new Map<
    DashboardModuleType,
    DashboardModuleDefinition
  >();

  public constructor() {
    for (const registration of dashboardModuleRegistrations) {
      this.register(registration);
    }

    // The two halves of the contract are reconciled in both directions. A
    // loader without shared metadata is rejected by `register` above; the
    // reverse - metadata declaring a module that no table entry can load -
    // would otherwise stay silent, because nothing in the loop looks for it.
    // Such a module has a name, a footprint and a permission but no component,
    // so it can never be rendered, and a canvas that quietly omits it hides a
    // half-finished module behind a working grid.
    const unloadableModuleTypes = (
      Object.keys(sharedDashboardModules) as DashboardModuleType[]
    ).filter((moduleType) => !this.definitions.has(moduleType));

    if (unloadableModuleTypes.length > 0) {
      throw new Error(
        'Dashboard module(s) declared in the shared dashboard module map ' +
          `without a component loader: ${unloadableModuleTypes.join(', ')}. ` +
          'Add an entry for each to dashboard-module.registrations.ts.'
      );
    }
  }

  /**
   * Resolves one definition, or `undefined` when the discriminator is unknown.
   *
   * Returning `undefined` instead of throwing is the behaviour that lets a
   * saved layout survive the removal or rename of a module: the canvas drops
   * the entry it cannot resolve and renders everything else.
   *
   * The returned object is the stored definition itself, not a copy. Consumers
   * rely on that identity - the module host compares successive definitions to
   * decide whether it must fetch a component again - so a defensive clone here
   * would make every change-detection pass look like a new module and refetch
   * it.
   */
  public get(
    aModuleType: DashboardModuleType
  ): DashboardModuleDefinition | undefined {
    return this.definitions.get(aModuleType);
  }

  /**
   * Every registered definition, in registration order.
   *
   * A fresh array on every call: the catalog sorts and filters what it is given,
   * and handing out the backing collection would let a caller reorder or empty
   * the registry as a side effect of drawing a list.
   */
  public getAll(): DashboardModuleDefinition[] {
    return Array.from(this.definitions.values());
  }

  /**
   * Adds one module type to the registry.
   *
   * The three checks run in this order on purpose. The loader is validated
   * first, then the shared metadata, and only then is the discriminator
   * checked for a duplicate - so a genuinely malformed registration is always
   * reported as malformed, even when its discriminator happens to be one that
   * is already registered. Reversing the order would mask a missing loader
   * behind a duplicate-key message and send whoever has to fix it looking in
   * the wrong place.
   *
   * @throws Error when the registration carries no callable loader, when its
   * discriminator has no entry in the shared metadata map, or when its
   * discriminator is already registered. Every message names the offending
   * discriminator.
   */
  public register(aRegistration: DashboardModuleRegistration): void {
    const { loadComponent, moduleType } = aRegistration;

    if (typeof loadComponent !== 'function') {
      throw new Error(
        `Dashboard module "${moduleType}" was registered without a component loader`
      );
    }

    // Guarded even though the index type reports a value for every key: a
    // discriminator can arrive from a persisted layout or from a table that was
    // edited without its shared counterpart, and neither of those is something
    // the type system sees.
    const sharedModule = sharedDashboardModules[moduleType];

    if (!sharedModule) {
      throw new Error(
        `Dashboard module "${moduleType}" has no metadata in the shared dashboard module map`
      );
    }

    if (this.definitions.has(moduleType)) {
      throw new Error(`Dashboard module "${moduleType}" is already registered`);
    }

    this.definitions.set(moduleType, { ...sharedModule, loadComponent });
  }
}
