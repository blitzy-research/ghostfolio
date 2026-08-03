import type {
  DashboardModule,
  DashboardModuleType
} from '@ghostfolio/common/dashboard';
import { dashboardModules } from '@ghostfolio/common/dashboard';

import { Injectable } from '@angular/core';

import { dashboardModuleRegistrations } from './dashboard-module.registrations';
import type {
  DashboardModuleDefinition,
  DashboardModuleRegistration
} from './interfaces/interfaces';

/**
 * The single mechanism through which a module type becomes available to the
 * dashboard canvas.
 *
 * The canvas has no other way to turn a persisted `moduleType` discriminator
 * into something renderable: it asks this registry, receives a definition whose
 * `loadComponent` thunk is the only handle on a module class in the
 * application, and hands that definition to the module host. Inserting a
 * component into the grid ad hoc is therefore not merely discouraged, it is
 * unreachable - which is what makes the registry rule an invariant rather than
 * a convention.
 *
 * ## Two authoritative halves, joined exactly once
 *
 * A module's identity is deliberately split across the Nx project boundary, and
 * this service is where the halves meet:
 *
 * - **Metadata** - display name, default and minimum cell dimensions and the
 *   optional visibility permission - is owned by the framework-neutral
 *   `dashboardModules` map in `@ghostfolio/common/dashboard`. It lives in
 *   `libs/common` because `libs/ui` needs it (the assistant searches module
 *   names) and `libs/ui` may not import from `apps/client`.
 * - **Loaders** are owned by `dashboard-module.registrations.ts`, because a
 *   dynamic `import()` of an application component is inherently app-side.
 *
 * Nothing is re-declared here. Every value on a returned definition is either
 * inherited verbatim from the shared metadata or is the loader thunk bound to
 * it, so a name, a dimension or a permission has exactly one place it can be
 * changed and no opportunity to drift.
 *
 * ## Why the definition carries a thunk rather than a component type
 *
 * Collapsing the former 22 lazy route boundaries removed every code-splitting
 * seam in the client. Holding component *types* in this map would drag all 21
 * module trees, and everything they transitively import, into the initial chunk
 * and breach the production `initial` budget. Storing thunks relocates code
 * splitting from route boundaries to registry boundaries, so a module's code is
 * fetched when - and only when - that module is placed on the canvas.
 *
 * That is also why this service never calls a thunk. Construction, lookup and
 * listing are all synchronous and allocation-free with respect to module code;
 * resolution belongs to the module host, which awaits the promise and mounts
 * the result through `NgComponentOutlet`. Calling a loader here would defeat
 * the split it exists to preserve.
 *
 * ## What this service deliberately does not do
 *
 * - **It holds no layout state.** Where a module sits and how large it is
 *   belongs to grid state alone. The dimensions on a definition are *policy*
 *   (the floor a module remains usable at, and the size it is first placed
 *   with), not position, and the grid engine's own item validation is what
 *   enforces the floor.
 * - **It persists nothing and reads nothing from the server.** A layout write
 *   originates only from a grid state change on the canvas.
 * - **It filters nothing by user.** `getAll()` returns every registered module,
 *   permission included; deciding what a given user may see is the catalog's
 *   and the canvas's job, and the API endpoints stay independently guarded
 *   regardless. A registry that hid entries would make that decision
 *   invisible - and untestable - at the point where it actually matters.
 * - **It imports no module component, no grid library and no canvas type.**
 *   Dependencies run one way: the canvas layer depends on this registry, never
 *   the reverse.
 *
 * @example
 * ```ts
 * const definition = this.moduleRegistry.get(item.moduleType);
 *
 * if (!definition) {
 *   // A layout persisted by an older build can name a module that no longer
 *   // exists. Dropping that one item keeps the rest of the canvas intact.
 *   return;
 * }
 *
 * const component = await definition.loadComponent();
 * ```
 */
@Injectable({
  providedIn: 'root'
})
export class DashboardModuleRegistryService {
  /**
   * Type-to-definition lookup, keyed by the discriminator that saved layouts
   * store.
   *
   * Never exposed. Callers receive a definition or a fresh array of them, so
   * the only way to add a module type is {@link register}, and there is no way
   * at all to remove or overwrite one.
   *
   * Insertion order is the order of `dashboardModules`, which follows
   * `DashboardModuleType` declaration order, so catalog listings are stable
   * across sessions and reviewable in a diff.
   */
  private readonly modules = new Map<
    DashboardModuleType,
    DashboardModuleDefinition
  >();

  public constructor() {
    this.registerConfiguredModules();
  }

  /**
   * Resolves a persisted discriminator to the definition that renders it.
   *
   * Returns `undefined` for anything unregistered and never throws: a layout
   * saved by an older build, or hand-edited, may well name a module that has
   * since been removed or renamed. That is a recoverable condition, so the
   * caller drops the offending item and renders the remainder. Manufacturing a
   * placeholder definition instead would put an unrenderable module on the
   * canvas and hide the stale entry from the next write.
   *
   * @param moduleType Discriminator taken from the saved layout.
   * @returns The registered definition, or `undefined` when the type is
   * unknown.
   */
  public get(
    moduleType: DashboardModuleType
  ): DashboardModuleDefinition | undefined {
    return this.modules.get(moduleType);
  }

  /**
   * Lists every registered module in shared-metadata declaration order.
   *
   * The array is freshly built on each call, so a caller may sort, filter or
   * search it - as the catalog does, by permission and by search term - without
   * disturbing the registry. The definitions inside it are shared, immutable
   * metadata and must be treated as read-only.
   *
   * @returns A new array of all registered definitions, unfiltered.
   */
  public getAll(): DashboardModuleDefinition[] {
    return Array.from(this.modules.values());
  }

  /**
   * Adds one module type to the registry.
   *
   * Registration is strictly first-write-wins: a second attempt on the same
   * discriminator throws and leaves the original definition in place, rather
   * than silently replacing the component a saved layout already resolves to.
   * Because a duplicate can only be introduced by editing the registration
   * table or the shared metadata, failing loudly turns an ambiguous
   * configuration into an immediate, named error instead of a rendering
   * surprise.
   *
   * @param definition Complete definition, i.e. shared metadata plus the lazy
   * component loader bound to it.
   * @throws {Error} When `definition.moduleType` is already registered.
   */
  public register(definition: DashboardModuleDefinition): void {
    if (this.modules.has(definition.moduleType)) {
      throw new Error(
        `Dashboard module "${definition.moduleType}" is already registered. ` +
          'Every module type must be registered exactly once.'
      );
    }

    this.modules.set(definition.moduleType, definition);
  }

  /**
   * Indexes the registration table by discriminator so metadata can be joined
   * to loaders in a single pass.
   *
   * Building a map rather than searching the array per module also makes a
   * duplicated entry detectable: `Map.set` would quietly keep the last loader
   * for a repeated type, which is precisely the ambiguity that must never be
   * resolved by accident.
   *
   * @returns Discriminator-to-registration lookup.
   * @throws {Error} When a module type is registered more than once.
   */
  private createLoaderLookup(): Map<
    DashboardModuleType,
    DashboardModuleRegistration
  > {
    const loaders = new Map<DashboardModuleType, DashboardModuleRegistration>();

    for (const registration of dashboardModuleRegistrations) {
      if (loaders.has(registration.moduleType)) {
        throw new Error(
          `Dashboard module "${registration.moduleType}" has more than one ` +
            'loader registration. Every module type must appear exactly once ' +
            'in dashboard-module.registrations.ts.'
        );
      }

      loaders.set(registration.moduleType, registration);
    }

    return loaders;
  }

  /**
   * Composes and registers one definition per shared module definition.
   *
   * Driving the loop from the shared metadata - not from the loader table - is
   * what fixes catalog order to `DashboardModuleType` declaration order, and it
   * is why `Object.values` carries an explicit `DashboardModule` type argument:
   * the shared map is declared with `satisfies`, so its inferred value type is
   * a union of 21 distinct object types of which only seven declare
   * `permission`. Reading that optional member off the union without the
   * annotation is a compile error, and the annotation is the honest fix for it.
   *
   * Both halves are then reconciled in both directions, because either kind of
   * mismatch is a configuration defect that must surface at startup rather than
   * as a module that mysteriously never appears: metadata without a loader
   * cannot be rendered, and a loader without metadata has no name, no
   * dimensions and no permission to be listed with. Skipping either quietly
   * would hide a half-finished module behind a working canvas.
   *
   * @throws {Error} When the two halves do not describe the same set of module
   * types.
   */
  private registerConfiguredModules(): void {
    const sharedModules = Object.values<DashboardModule>(dashboardModules);
    const unmatchedLoaders = this.createLoaderLookup();

    for (const sharedModule of sharedModules) {
      const registration = unmatchedLoaders.get(sharedModule.moduleType);

      if (!registration) {
        throw new Error(
          `Dashboard module "${sharedModule.moduleType}" declares shared ` +
            'metadata but no component loader. Add an entry for it to ' +
            'dashboard-module.registrations.ts.'
        );
      }

      // Metadata is inherited wholesale - including `permission` where the
      // shared map declares one - so this service adds the loader and nothing
      // else. The thunk is stored, never called.
      this.register({
        ...sharedModule,
        loadComponent: registration.loadComponent
      });

      unmatchedLoaders.delete(sharedModule.moduleType);
    }

    if (unmatchedLoaders.size > 0) {
      const orphanedModuleTypes = Array.from(unmatchedLoaders.keys()).join(
        ', '
      );

      throw new Error(
        'Dashboard module loader(s) registered without shared metadata: ' +
          `${orphanedModuleTypes}. Declare them in dashboardModules or remove ` +
          'the registration(s).'
      );
    }
  }
}
