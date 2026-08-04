import {
  dashboardModules,
  getDashboardModule,
  isDashboardModulePermitted
} from './dashboard-module';
import { DashboardModuleType } from './enums/dashboard-module-type';

/**
 * The shared module metadata is the one thing both sides of the layout wire agree
 * on: the API measures a submitted footprint against the minimum declared here,
 * and the client normalizes a stored one against the same value. This suite covers
 * the three properties that agreement rests on and that nothing else can check.
 *
 * 1. **`$localize` is available at module scope.** Every display name below is a
 *    tagged template evaluated as this module is *imported*, so a missing global
 *    is not a wrong name - it is a `ReferenceError` before a single assertion
 *    runs. The suite importing at all is therefore the assertion, and it is one
 *    the previous form could not have satisfied outside a browser with the Angular
 *    polyfill loaded.
 * 2. **The lookup narrows an untrusted string.** Its argument reaches it from a
 *    saved layout document or a request body, where it is whatever an older or
 *    hand-written client put there - including a name inherited from
 *    `Object.prototype`, which a bare index would answer with a function.
 * 3. **Every declared minimum is representable.** A module whose minimum exceeded
 *    the grid, or fell below the grid-wide floor, would be one the engine could
 *    never place at its own declared size.
 */
describe('dashboardModules', () => {
  const GRID_COLUMNS = 12;
  const GRID_ROWS = 100;
  const MINIMUM_ITEM_COLS = 2;
  const MINIMUM_ITEM_ROWS = 2;

  it('resolves its display names without a localization polyfill', () => {
    // Node installs no `$localize`, so the fallback in the module under test is
    // the only reason this file can be imported at all. A name that came back
    // empty would mean the tag had been replaced by something that swallows its
    // input.
    for (const dashboardModule of Object.values(dashboardModules)) {
      expect(typeof dashboardModule.name).toBe('string');
      expect(dashboardModule.name.length).toBeGreaterThan(0);
    }
  });

  it('declares one entry per module type, keyed by its own discriminator', () => {
    const moduleTypes = Object.values(DashboardModuleType);

    expect(Object.keys(dashboardModules).sort()).toEqual(
      [...moduleTypes].sort()
    );

    for (const moduleType of moduleTypes) {
      expect(dashboardModules[moduleType].moduleType).toBe(moduleType);
    }
  });

  it('declares a minimum every module can actually be placed at', () => {
    for (const dashboardModule of Object.values(dashboardModules)) {
      expect(dashboardModule.minItemCols).toBeGreaterThanOrEqual(
        MINIMUM_ITEM_COLS
      );
      expect(dashboardModule.minItemRows).toBeGreaterThanOrEqual(
        MINIMUM_ITEM_ROWS
      );
      expect(dashboardModule.minItemCols).toBeLessThanOrEqual(GRID_COLUMNS);
      expect(dashboardModule.minItemRows).toBeLessThanOrEqual(GRID_ROWS);

      // A default smaller than the declared minimum would put a freshly added
      // module below the size the engine is told to reject.
      expect(dashboardModule.defaultItemCols).toBeGreaterThanOrEqual(
        dashboardModule.minItemCols
      );
      expect(dashboardModule.defaultItemRows).toBeGreaterThanOrEqual(
        dashboardModule.minItemRows
      );
      expect(dashboardModule.defaultItemCols).toBeLessThanOrEqual(GRID_COLUMNS);
    }
  });

  describe('getDashboardModule', () => {
    it('resolves a known discriminator to its own definition', () => {
      expect(getDashboardModule(DashboardModuleType.AI_CHAT)).toBe(
        dashboardModules[DashboardModuleType.AI_CHAT]
      );
    });

    it.each([
      'some-future-module',
      '',
      // Inherited members of `Object.prototype`. A bare index would answer each of
      // these with a function, and the caller would treat it as a definition -
      // reading `minItemCols` off it as `undefined` and comparing a footprint
      // against nothing.
      'constructor',
      'hasOwnProperty',
      'toString',
      '__proto__'
    ])('resolves %p to undefined', (moduleType) => {
      expect(getDashboardModule(moduleType)).toBeUndefined();
    });

    it.each([undefined, null, 42, {}])(
      'resolves the non-string %p to undefined rather than throwing',
      (moduleType) => {
        expect(
          getDashboardModule(moduleType as unknown as string)
        ).toBeUndefined();
      }
    );
  });

  describe('isDashboardModulePermitted', () => {
    it('permits a module that declares no permission, whatever the viewer holds', () => {
      expect(isDashboardModulePermitted({ permission: undefined })).toBe(true);
      expect(isDashboardModulePermitted({ permission: undefined }, [])).toBe(
        true
      );
    });

    it('permits a gated module only for a viewer holding its permission', () => {
      const gated = { permission: 'accessAdminControl' };

      expect(isDashboardModulePermitted(gated, ['accessAdminControl'])).toBe(
        true
      );
      expect(isDashboardModulePermitted(gated, ['createAccount'])).toBe(false);
      expect(isDashboardModulePermitted(gated)).toBe(false);
    });
  });
});
