import type { DashboardModule } from '@ghostfolio/common/dashboard';

import { Type } from '@angular/core';
import { TestBed } from '@angular/core/testing';
// The shared dashboard metadata localizes its display names at module scope, so
// evaluating it calls `$localize`. Nothing installs that global in a jsdom test
// environment - `apps/client/src/polyfills.ts` installs it for the application
// and no Jest setup file stands in for that - so it is installed here.
//
// Its position is load-bearing rather than cosmetic. Prettier sorts imports into
// `@ghostfolio/*`, then third party, then relative, and it sorts side-effect
// imports along with the rest, so this statement can never precede the
// `@ghostfolio/*` group. That is exactly why the only `@ghostfolio` import below
// is type-only - it is erased and evaluates nothing - while every value that
// reaches the shared metadata is reached through the relative group underneath,
// which is evaluated after this line.
import '@angular/localize/init';

import { dashboardModuleRegistrations } from './dashboard-module.registrations';
import { DashboardModuleType } from './enums/dashboard-module-type';
import type { DashboardModuleDefinition } from './interfaces/interfaces';
import { DashboardModuleRegistryService } from './module-registry.service';

/**
 * Stands in for a module component.
 *
 * Declared here rather than imported from `modules/**` on purpose. The registry
 * exists to keep every module's component behind a lazy boundary now that the
 * lazy route boundaries are gone, so a spec that reached for a real wrapper
 * would pull that wrapper and its whole dependency tree into this compilation
 * and quietly undo the property it is meant to be proving. The registry never
 * instantiates or renders what a loader resolves to, so a bare class satisfies
 * `Type<unknown>` in full.
 */
class GfUnregisteredTestModuleComponent {}

/**
 * Unit specification for the dashboard module registry.
 *
 * The registry is the single mechanism through which a module type can reach the
 * canvas, which makes four of its properties load-bearing in ways no compiler
 * can check:
 *
 * 1. **Completeness and singularity.** The declarative registration table is the
 *    only thing that populates the registry, and it must cover every persisted
 *    discriminator exactly once. A missing entry is a module that can never be
 *    added; a duplicate entry is a module whose definition silently depends on
 *    array order.
 * 2. **Laziness.** Every definition holds a thunk, and constructing the registry
 *    must not call a single one of them. Invoking loaders eagerly still
 *    compiles, still passes every behavioural test and still renders correctly -
 *    it only shows up as twenty-one module trees collapsing into the initial
 *    bundle and breaching its size budget.
 * 3. **Forgiving lookup, strict registration.** An unknown discriminator has to
 *    read back as `undefined` so a layout saved before a module was renamed
 *    loses one cell instead of failing the canvas, while a malformed
 *    registration has to fail loudly, because it is a static wiring mistake that
 *    would otherwise surface much later as a cell that never paints.
 * 4. **Declared minimums.** The grid engine enforces per-item minimums by
 *    rejecting any placement below them, and it reads those minimums from what
 *    the registry hands over. A definition that arrived without them would have
 *    *every* placement rejected, leaving a module that can be neither moved nor
 *    resized.
 *
 * Two harness decisions follow from the environment and are recorded here so
 * they are not "simplified" away:
 *
 * - No fixture, no DOM query, no `Router`, no `HttpClient`, no `DataService` and
 *   no grid engine appear anywhere below. The testing module registers the
 *   service and nothing else, so any collaborator this service acquired would
 *   fail injection here rather than being quietly satisfied.
 * - The authoritative metadata map is resolved after the import block rather
 *   than through it; {@link sharedDashboardModules} records why neither a static
 *   nor a dynamic import works. Every metadata assertion is anchored to that
 *   shared source of truth rather than to a table copied into this file, which
 *   would pass while agreeing only with itself.
 */
describe('DashboardModuleRegistryService', () => {
  /**
   * The complete set of persisted discriminators, in declaration order.
   */
  const moduleTypes = Object.values(DashboardModuleType);

  /**
   * The smallest footprint the grid engine will admit, in grid cells. Spelled
   * out rather than imported from the canvas configuration: the two sides agree
   * by value, so sharing a constant would make the assertion tautological and it
   * would still pass with the same wrong number on both sides.
   */
  const minimumItemDimension = 2;

  /**
   * The fixed column count of the canvas, which bounds every declared width.
   */
  const gridColumnCount = 12;

  /**
   * Reads a raw string as a discriminator, which is exactly what a persisted
   * layout hands the registry.
   *
   * The parameter is declared as `string`, and a string is comparable to a string
   * enum, so the assertion needs no unsafe cast, no double assertion and no
   * compiler suppression. Going through this helper also keeps the value honestly
   * outside the enum instead of pretending the enum has a member it does not
   * have, which is the whole point of the tests that use it.
   */
  const asModuleType = (aValue: string) => aValue as DashboardModuleType;

  /**
   * A discriminator that no longer exists, standing in for an entry in a layout
   * that was saved before a module was renamed or withdrawn.
   */
  const staleModuleType = asModuleType('zen-mode');

  /**
   * The authoritative, framework-neutral metadata map.
   *
   * Resolved through the module registry rather than with a top-level `import`,
   * for a reason that is worth spelling out because both obvious alternatives
   * are wrong here:
   *
   * - a static value import is sorted above `@angular/localize/init` (see the
   *   note on the import block) and therefore evaluates the shared metadata
   *   before anything has installed `$localize`, which fails the whole suite at
   *   load time;
   * - `await import('@ghostfolio/common/dashboard')` would load it late enough,
   *   but a dynamic import marks the whole `common` library as lazy-loaded for
   *   `@nx/enforce-module-boundaries`, which then rejects *every* static import
   *   of `@ghostfolio/common/*` anywhere in the client - dozens of errors in
   *   files this spec has nothing to do with.
   *
   * `requireActual` avoids both traps: it is neither a static nor a dynamic
   * import, so the boundary rule does not see it, and it runs while the suite is
   * being collected, which is after the import block above has run. It also
   * returns the very instance the service under test is using, because the
   * relative import below has already put it in the module registry - so this is
   * the same object the production code composed its definitions from, not a
   * second copy of it.
   */
  const sharedDashboardModules = jest.requireActual<{
    dashboardModules: Record<DashboardModuleType, DashboardModule>;
  }>('@ghostfolio/common/dashboard').dashboardModules;

  let registry: DashboardModuleRegistryService;

  /**
   * Splits a definition into the loader and everything else, so a test can
   * compare the metadata half against the shared map with a single assertion
   * while checking the loader on its own terms.
   */
  const splitDefinition = (definition: DashboardModuleDefinition) => {
    const { loadComponent, ...metadata } = definition;

    return { loadComponent, metadata };
  };

  const configureRegistry = () => {
    TestBed.configureTestingModule({
      providers: [DashboardModuleRegistryService]
    });

    return TestBed.inject(DashboardModuleRegistryService);
  };

  beforeEach(() => {
    registry = configureRegistry();
  });

  afterEach(() => {
    // The declarative registration table is a module-scoped array shared by
    // every test in this file, and one test spies on its loaders. Restoring here
    // keeps that test from leaking a spy into the ones that follow it.
    jest.restoreAllMocks();
  });

  describe('default registration', () => {
    it('should be created with nothing but itself provided', () => {
      expect(registry).toBeTruthy();
    });

    it('should register exactly one definition per module type', () => {
      const registeredTypes = registry
        .getAll()
        .map(({ moduleType }) => moduleType);

      // Pins the vocabulary itself, so adding a module type without registering
      // it fails here rather than passing a comparison of two lists that grew
      // together.
      expect(moduleTypes).toHaveLength(21);
      expect(registeredTypes).toHaveLength(21);

      // Same membership, and no discriminator appearing twice: a duplicate would
      // otherwise keep the length correct while dropping a different module.
      expect([...registeredTypes].sort()).toEqual([...moduleTypes].sort());
      expect(new Set(registeredTypes).size).toBe(registeredTypes.length);
    });

    it('should take its contents from the declarative table and nothing else', () => {
      // Order included deliberately. The registry preserves insertion order and
      // the catalog draws what it is given, so the table's order is the order a
      // user sees. Asserting membership alone would let that silently change.
      expect(registry.getAll().map(({ moduleType }) => moduleType)).toEqual(
        dashboardModuleRegistrations.map(({ moduleType }) => moduleType)
      );
    });

    it('should store every loader as an uninvoked zero-argument thunk', () => {
      const offenders = registry
        .getAll()
        .filter(({ loadComponent }) => {
          return typeof loadComponent !== 'function';
        })
        .map(({ moduleType }) => moduleType);

      expect(offenders).toEqual([]);

      // Zero declared parameters, because the canvas calls the loader with no
      // arguments. A loader that expected one would resolve `undefined` and the
      // cell would report a failed module instead of rendering it.
      const arities = new Set(
        registry.getAll().map(({ loadComponent }) => loadComponent.length)
      );

      expect([...arities]).toEqual([0]);
    });

    it('should not invoke a single loader while registering the defaults', () => {
      // The instance built in `beforeEach` already exists, so the spies have to
      // be installed against a registry that has not been constructed yet.
      TestBed.resetTestingModule();

      const loaderSpies = dashboardModuleRegistrations.map((registration) => {
        return jest.spyOn(registration, 'loadComponent');
      });

      const isolatedRegistry = configureRegistry();

      // Construction, a full listing and a lookup: none of the three is allowed
      // to fetch a module's code. This is the assertion that keeps twenty-one
      // module trees out of the initial bundle, and it is the only mechanical
      // guard that exists for it.
      expect(isolatedRegistry.getAll()).toHaveLength(21);
      expect(isolatedRegistry.get(DashboardModuleType.HOLDINGS)).toBeDefined();

      const invoked = dashboardModuleRegistrations
        .map(({ moduleType }, index) => {
          return {
            callCount: loaderSpies[index].mock.calls.length,
            moduleType
          };
        })
        .filter(({ callCount }) => callCount > 0)
        .map(({ moduleType }) => moduleType);

      expect(invoked).toEqual([]);
    });
  });

  describe('lookup', () => {
    it('should resolve a known module type to its shared metadata and its loader', () => {
      const definition = registry.get(DashboardModuleType.HOLDINGS);

      expect(definition).toBeDefined();

      const { loadComponent, metadata } = splitDefinition(definition);

      expect(typeof loadComponent).toBe('function');

      // One assertion over the whole metadata half, against the shared entry
      // rather than a copy of its values. It proves the display name, both
      // defaults and both minimums came through unchanged *and* that nothing
      // extra was invented, which a field-by-field comparison would miss.
      expect(metadata).toEqual(
        sharedDashboardModules[DashboardModuleType.HOLDINGS]
      );
      expect(metadata.moduleType).toBe(DashboardModuleType.HOLDINGS);
    });

    it('should leave a permission-free module without a permission', () => {
      const definition = registry.get(DashboardModuleType.HOLDINGS);

      // Checked as an absent key, not merely an undefined value: the catalog and
      // the canvas treat "no permission declared" as "visible to everyone", so a
      // key present and empty would be a different statement about the module.
      expect('permission' in definition).toBe(false);
      expect(definition.permission).toBeUndefined();
    });

    it('should preserve a declared permission verbatim', () => {
      const definition = registry.get(DashboardModuleType.ADMIN_USERS);
      const sharedPermission =
        sharedDashboardModules[DashboardModuleType.ADMIN_USERS].permission;

      expect(typeof sharedPermission).toBe('string');
      expect(definition.permission).toBe(sharedPermission);
    });

    it('should preserve the permission of every module that declares one, and only those', () => {
      const expected = Object.values<DashboardModule>(sharedDashboardModules)
        .filter(({ permission }) => Boolean(permission))
        .map(({ moduleType }) => moduleType)
        .sort();

      const actual = registry
        .getAll()
        .filter(({ permission }) => Boolean(permission))
        .map(({ moduleType }) => moduleType)
        .sort();

      // Both directions in one comparison: a permission dropped during
      // composition would shorten `actual` and expose an admin module to
      // everyone, while an invented one would lengthen it and hide a module that
      // should be offered to all.
      expect(actual).toEqual(expected);
      expect(actual.length).toBeGreaterThan(0);
      expect(actual.length).toBeLessThan(moduleTypes.length);
    });
  });

  describe('unknown module types', () => {
    it('should return undefined for a stale discriminator instead of throwing', () => {
      // This is the behaviour that lets the canvas drop one entry from a layout
      // saved before a module was withdrawn and carry on rendering the rest.
      // Throwing here would take the whole canvas down with it.
      expect(() => registry.get(staleModuleType)).not.toThrow();
      expect(registry.get(staleModuleType)).toBeUndefined();
    });

    it('should not resolve inherited object members as module types', () => {
      // Discriminators arrive from persisted JSON, so `constructor` and
      // `toString` are reachable values. A registry backed by an object literal
      // would answer both of them with an inherited function; a `Map` cannot.
      const inheritedMemberNames = ['constructor', 'toString', 'valueOf'];

      for (const inheritedMemberName of inheritedMemberNames) {
        expect(registry.get(asModuleType(inheritedMemberName))).toBeUndefined();
      }
    });
  });

  describe('duplicate registration', () => {
    it('should reject re-registering an existing definition', () => {
      const definition = registry.get(DashboardModuleType.HOLDINGS);

      expect(() => registry.register(definition)).toThrow(Error);

      // The message has to name the offender. A registry that rejected
      // duplicates anonymously would be correct and useless, because twenty-one
      // registrations from one declarative table look identical in a stack
      // trace.
      expect(() => registry.register(definition)).toThrow(
        DashboardModuleType.HOLDINGS
      );
    });

    it('should neither overwrite nor append when a duplicate is rejected', () => {
      const definition = registry.get(DashboardModuleType.HOLDINGS);
      const impostor: DashboardModuleDefinition = {
        ...definition,
        loadComponent: () =>
          Promise.resolve<Type<unknown>>(GfUnregisteredTestModuleComponent),
        name: 'Impostor'
      };

      expect(() => registry.register(impostor)).toThrow(Error);

      // Identity rather than equality: the module host compares successive
      // definitions to decide whether it must fetch a component again, so the
      // stored object has to be the very one that was already there.
      expect(registry.get(DashboardModuleType.HOLDINGS)).toBe(definition);
      expect(registry.get(DashboardModuleType.HOLDINGS).name).not.toBe(
        impostor.name
      );
      expect(registry.getAll()).toHaveLength(21);
    });
  });

  describe('declared minimums and defaults', () => {
    it('should declare a footprint at or above the grid floor for every module', () => {
      const offenders = registry
        .getAll()
        .filter((definition) => {
          return !(
            Number.isInteger(definition.minItemCols) &&
            Number.isInteger(definition.minItemRows) &&
            definition.minItemCols >= minimumItemDimension &&
            definition.minItemRows >= minimumItemDimension
          );
        })
        .map(({ moduleType }) => moduleType);

      // The grid engine rejects any placement narrower or shorter than the
      // per-item minimum it is handed, and `4 >= undefined` evaluates to false,
      // so a definition missing either value leaves its module immovable and
      // unresizable rather than merely small.
      expect(offenders).toEqual([]);
    });

    it('should default to a footprint that fits the grid and honours its own minimum', () => {
      const offenders = registry
        .getAll()
        .filter((definition) => {
          return !(
            Number.isInteger(definition.defaultItemCols) &&
            Number.isInteger(definition.defaultItemRows) &&
            definition.defaultItemCols >= definition.minItemCols &&
            definition.defaultItemRows >= definition.minItemRows &&
            definition.defaultItemCols <= gridColumnCount &&
            definition.minItemCols <= gridColumnCount
          );
        })
        .map(({ moduleType }) => moduleType);

      // A default below the module's own minimum would be rejected the instant
      // it was placed, and one wider than the fixed column count could never be
      // placed at all.
      expect(offenders).toEqual([]);
    });

    it('should carry the shared metadata of every module without alteration', () => {
      // Iterated from the shared map rather than from the registry, so a module
      // that was never registered surfaces here as an undefined lookup. The
      // explicit generic gives every entry the full contract type, including the
      // optional permission that the map's `satisfies` declaration otherwise
      // narrows away entry by entry.
      const sharedModules = Object.values<DashboardModule>(
        sharedDashboardModules
      );

      expect(sharedModules).toHaveLength(moduleTypes.length);

      for (const sharedModule of sharedModules) {
        const definition = registry.get(sharedModule.moduleType);

        expect(definition).toBeDefined();

        // Compared as a whole against the authoritative entry instead of field
        // by field against values copied into this file: only this form catches
        // a member that was invented during composition as well as one that was
        // lost.
        expect(splitDefinition(definition).metadata).toEqual(sharedModule);
      }
    });
  });

  describe('defensive listing', () => {
    it('should hand out a fresh array that cannot reach the backing collection', () => {
      const firstListing = registry.getAll();
      const secondListing = registry.getAll();

      expect(secondListing).not.toBe(firstListing);
      expect(secondListing).toEqual(firstListing);

      firstListing.length = 0;
      firstListing.push({
        defaultItemCols: 4,
        defaultItemRows: 4,
        loadComponent: () =>
          Promise.resolve<Type<unknown>>(GfUnregisteredTestModuleComponent),
        minItemCols: minimumItemDimension,
        minItemRows: minimumItemDimension,
        moduleType: staleModuleType,
        name: 'Impostor'
      });

      // Emptied and then refilled with a module that was never registered. The
      // catalog sorts and filters whatever listing it is handed, so a listing
      // that shared the registry's own storage would let drawing a list rewrite
      // the registry.
      expect(registry.getAll()).toHaveLength(21);
      expect(registry.get(staleModuleType)).toBeUndefined();
      expect(registry.get(DashboardModuleType.HOLDINGS)).toBeDefined();
    });
  });

  describe('malformed registration', () => {
    it('should reject a registration that carries no loader', () => {
      const definition = registry.get(DashboardModuleType.HOLDINGS);

      // Reported as a missing loader even though this discriminator is already
      // registered, because the loader is validated before the duplicate check.
      // A duplicate-key message here would send whoever has to fix it looking at
      // the wrong half of the entry.
      expect(() =>
        registry.register({
          loadComponent: undefined,
          moduleType: DashboardModuleType.HOLDINGS
        })
      ).toThrow(/loader/i);

      expect(registry.get(DashboardModuleType.HOLDINGS)).toBe(definition);
      expect(registry.getAll()).toHaveLength(21);
    });

    it('should reject a loader whose module type has no shared metadata', () => {
      expect(() =>
        registry.register({
          loadComponent: () =>
            Promise.resolve<Type<unknown>>(GfUnregisteredTestModuleComponent),
          moduleType: staleModuleType
        })
      ).toThrow(staleModuleType);

      // Nothing partial is left behind. Without shared metadata there would be
      // no declared minimum, and the grid engine would then reject every
      // placement of the resulting cell.
      expect(registry.get(staleModuleType)).toBeUndefined();
      expect(registry.getAll()).toHaveLength(21);
    });
  });
});
