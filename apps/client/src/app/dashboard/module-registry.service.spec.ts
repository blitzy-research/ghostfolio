import type { DashboardModule } from '@ghostfolio/common/dashboard';

import { Type } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { dashboardModuleRegistrations } from './dashboard-module.registrations';
import { DashboardModuleType } from './enums/dashboard-module-type';
import type { DashboardModuleDefinition } from './interfaces/interfaces';
import { GfModuleRegistryService } from './module-registry.service';

/**
 * Declared here rather than imported from `modules/**`: reaching for a real wrapper
 * would pull its whole dependency tree into this compilation and undo the lazy
 * boundary this spec exists to prove. The registry never instantiates what a loader
 * resolves to, so a bare class satisfies `Type<unknown>` in full.
 */
class GfUnregisteredTestModuleComponent {}

/**
 * Two harness decisions here are load-bearing and must not be "simplified" away.
 *
 * The testing module registers the service and nothing else - no fixture, no
 * `Router`, no `HttpClient`, no `DataService`, no grid engine - so any collaborator
 * this service acquired would fail injection rather than be quietly satisfied.
 *
 * The authoritative metadata map is resolved after the import block rather than
 * through it; {@link sharedDashboardModules} records why neither a static nor a
 * dynamic import works. Anchoring assertions to that shared map rather than to a
 * table copied into this file is what stops the suite agreeing only with itself.
 */
describe('GfModuleRegistryService', () => {
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

  const gridColumnCount = 12;

  const asModuleType = (aValue: string) => aValue as DashboardModuleType;

  const staleModuleType = asModuleType('zen-mode');

  /**
   * Both obvious ways of importing the shared metadata map are wrong here. A static
   * value import sorts above `@angular/localize/init` and so evaluates the map before
   * `$localize` exists, failing the suite at load time. `await import(…)` loads late
   * enough, but marks the whole `common` library as lazy-loaded for
   * `@nx/enforce-module-boundaries`, which then rejects every static
   * `@ghostfolio/common/*` import across the client.
   *
   * `requireActual` is neither, so the boundary rule does not see it, and it runs
   * after the import block. It also returns the instance the service under test is
   * already using rather than a second copy.
   */
  const sharedDashboardModules = jest.requireActual<{
    dashboardModules: Record<DashboardModuleType, DashboardModule>;
  }>('@ghostfolio/common/dashboard').dashboardModules;

  let registry: GfModuleRegistryService;

  const splitDefinition = (definition: DashboardModuleDefinition) => {
    const { loadComponent, ...metadata } = definition;

    return { loadComponent, metadata };
  };

  const configureRegistry = () => {
    TestBed.configureTestingModule({
      providers: [GfModuleRegistryService]
    });

    return TestBed.inject(GfModuleRegistryService);
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

      expect(moduleTypes).toHaveLength(21);
      expect(registeredTypes).toHaveLength(21);

      expect([...registeredTypes].sort()).toEqual([...moduleTypes].sort());
      expect(new Set(registeredTypes).size).toBe(registeredTypes.length);
    });

    it('should take its contents from the declarative table and nothing else', () => {
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

      const arities = new Set(
        registry.getAll().map(({ loadComponent }) => loadComponent.length)
      );

      expect([...arities]).toEqual([0]);
    });

    it('should not invoke a single loader while registering the defaults', () => {
      TestBed.resetTestingModule();

      const loaderSpies = dashboardModuleRegistrations.map((registration) => {
        return jest.spyOn(registration, 'loadComponent');
      });

      const isolatedRegistry = configureRegistry();

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

      expect(metadata).toEqual(
        sharedDashboardModules[DashboardModuleType.HOLDINGS]
      );
      expect(metadata.moduleType).toBe(DashboardModuleType.HOLDINGS);
    });

    it('should leave a permission-free module without a permission', () => {
      const definition = registry.get(DashboardModuleType.HOLDINGS);

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

      expect(actual).toEqual(expected);
      expect(actual.length).toBeGreaterThan(0);
      expect(actual.length).toBeLessThan(moduleTypes.length);
    });
  });

  describe('unknown module types', () => {
    it('should return undefined for a stale discriminator instead of throwing', () => {
      expect(() => registry.get(staleModuleType)).not.toThrow();
      expect(registry.get(staleModuleType)).toBeUndefined();
    });

    it('should not resolve inherited object members as module types', () => {
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

      expect(offenders).toEqual([]);
    });

    it('should carry the shared metadata of every module without alteration', () => {
      const sharedModules = Object.values<DashboardModule>(
        sharedDashboardModules
      );

      expect(sharedModules).toHaveLength(moduleTypes.length);

      for (const sharedModule of sharedModules) {
        const definition = registry.get(sharedModule.moduleType);

        expect(definition).toBeDefined();

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

      expect(registry.getAll()).toHaveLength(21);
      expect(registry.get(staleModuleType)).toBeUndefined();
      expect(registry.get(DashboardModuleType.HOLDINGS)).toBeDefined();
    });
  });

  describe('malformed registration', () => {
    it('should reject a registration that carries no loader', () => {
      const definition = registry.get(DashboardModuleType.HOLDINGS);

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

      expect(registry.get(staleModuleType)).toBeUndefined();
      expect(registry.getAll()).toHaveLength(21);
    });
  });
});
