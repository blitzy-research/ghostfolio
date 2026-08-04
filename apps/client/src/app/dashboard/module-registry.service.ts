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
 * How a module type reaches the dashboard canvas: the canvas resolves a persisted
 * `moduleType` discriminator here, awaits the definition's loader and hands the
 * resulting component type to `NgComponentOutlet`, so it imports no module
 * component and no module component imports it. Routing every module through this
 * map is the convention that keeps that true; nothing in the build enforces it.
 *
 * A definition is composed from two sources, neither of which duplicates the other,
 * so a module's declared minimum footprint has exactly one definition site and the
 * grid's enforcement of it cannot drift from what the catalog advertises:
 *
 * - `dashboardModuleRegistrations` supplies the application-side half - which
 *   component a discriminator resolves to, and how to fetch it lazily;
 * - `@ghostfolio/common/dashboard` supplies the framework-neutral half - display
 *   name, default and minimum footprint, optional visibility permission - so that
 *   `libs/ui` can read the same metadata without importing application code.
 *
 * Registration throws and lookup does not, deliberately: a wiring mistake is static
 * and should fail loudly, whereas an unknown discriminator has to be survivable
 * because a saved layout outlives the module it names.
 */
@Injectable({ providedIn: 'root' })
export class GfModuleRegistryService {
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
   * `undefined` rather than a throw for an unknown discriminator, so a layout saved
   * before a module was renamed or withdrawn loses that one entry instead of failing
   * the whole canvas.
   *
   * The stored definition is returned, not a copy: the module host compares
   * successive definitions by reference to decide whether it must fetch a component
   * again, so a defensive clone would refetch every module on every
   * change-detection pass.
   */
  public get(
    aModuleType: DashboardModuleType
  ): DashboardModuleDefinition | undefined {
    return this.definitions.get(aModuleType);
  }

  /**
   * A fresh array on every call, because the catalog sorts and filters what it is
   * given and handing out the backing collection would let it reorder or empty the
   * registry as a side effect of drawing a list.
   */
  public getAll(): DashboardModuleDefinition[] {
    return Array.from(this.definitions.values());
  }

  /**
   * The three checks run in this order on purpose: loader, then shared metadata, then
   * duplicate discriminator. Checking for a duplicate first would mask a malformed
   * registration behind a duplicate-key message and send whoever has to fix it
   * looking in the wrong place.
   *
   * @throws Error naming the offending discriminator.
   */
  public register(aRegistration: DashboardModuleRegistration): void {
    const { loadComponent, moduleType } = aRegistration;

    if (typeof loadComponent !== 'function') {
      throw new Error(
        `Dashboard module "${moduleType}" was registered without a component loader`
      );
    }

    // Guarded even though the widened index type reports a value for every key.
    // This method is public and is exercised with hand-built registrations, so
    // without the guard a discriminator absent from the shared map would spread
    // `undefined` into a definition instead of failing.
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
