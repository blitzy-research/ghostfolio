import {
  DashboardModule,
  dashboardModules,
  getDashboardModule,
  getQualifiedDashboardModuleName,
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

  it('resolves the qualifiers it declares through the same tag', () => {
    // The qualifier is tagged at module scope exactly as the name is, so it
    // depends on the same fallback. An empty one would leave two same-named rows
    // reading identically in the catalog - which is the one thing it exists to
    // prevent - and would do so silently.
    //
    // Read through the declared contract rather than through the map's inferred
    // literal type: `satisfies` keeps each entry's own shape, so an optional
    // member is absent from - rather than optional on - the entries that omit it.
    for (const { context } of Object.values<DashboardModule>(
      dashboardModules
    )) {
      if (context === undefined) {
        continue;
      }

      expect(typeof context).toBe('string');
      expect(context.length).toBeGreaterThan(0);
    }
  });

  it('never reuses a qualifier as some other module`s primary name', () => {
    // The defect this guards against shipped once. Two qualifiers were the route
    // titles of screens that are themselves modules - `Market Data` and `Admin
    // Control` - so within one scroll of the catalog the same words appeared as a
    // small grey qualifier on one row and as the primary name of another, and a
    // viewer had no way to tell that the two were unrelated. A qualifier exists
    // to disambiguate; one that is itself a name cannot.
    const names = new Set(
      Object.values<DashboardModule>(dashboardModules).map(({ name }) => name)
    );

    for (const { context, moduleType } of Object.values<DashboardModule>(
      dashboardModules
    )) {
      if (context === undefined) {
        continue;
      }

      expect({ context, moduleType }).toEqual({
        context: names.has(context)
          ? `${context} (collides with a name)`
          : context,
        moduleType
      });
    }
  });

  it('qualifies every member of a set of modules that share a name', () => {
    // Qualifying only one member of a colliding pair leaves the other unreadable:
    // an absent qualifier is not itself a distinguishing mark, so the bare row was
    // the one row a viewer could not identify from its own label. The markets pair
    // shipped that way - the premium module was qualified and the plain one was
    // not.
    const nameCounts = new Map<string, number>();

    for (const { name } of Object.values<DashboardModule>(dashboardModules)) {
      nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
    }

    for (const { context, moduleType, name } of Object.values<DashboardModule>(
      dashboardModules
    )) {
      if (nameCounts.get(name) === 1) {
        continue;
      }

      expect({ hasContext: !!context, moduleType, name }).toEqual({
        hasContext: true,
        moduleType,
        name
      });
    }
  });

  it('tells two modules sharing a name apart by their qualifiers', () => {
    // The pair is only distinguishable if the qualifiers themselves differ, so
    // this closes the remaining way the rule above could be satisfied without
    // achieving anything.
    const qualifiedNames = Object.values<DashboardModule>(dashboardModules).map(
      ({ context, name }) => (context ? `${name} · ${context}` : name)
    );

    expect([...new Set(qualifiedNames)]).toHaveLength(qualifiedNames.length);
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

  /**
   * The two table modules whose defaults are dictated by their own columns.
   *
   * At a smaller default each hides an interactive control at ordinary desktop
   * widths: the access table's trailing actions column - the only route to editing
   * or revoking a grant - falls outside the visible area at 1280px and below, and
   * the holdings table's trailing performance column renders as a lone letter.
   * Their column sets are FIXED, so unlike the row counts of data-driven modules
   * the requirement is deterministic and a default can genuinely satisfy it. These
   * numbers are therefore pinned rather than left to taste.
   */
  describe('the widths measured against real content', () => {
    /** Content box of a module, in CSS pixels, at a given viewport and column span. */
    const contentWidth = (viewportWidth: number, cols: number) => {
      // Canvas geometry: twelve columns, a 10px margin between and outside them,
      // a 1px card border each side and the module's own 16px gutter each side.
      const columnWidth = (viewportWidth - 130) / GRID_COLUMNS;

      return columnWidth * cols + (cols - 1) * 10 - 2 - 32;
    };

    it.each([
      // Floor with the share address in the details column capped; uncapped, that
      // one cell alone sets a width-invariant 858px floor no viewport can reduce.
      [DashboardModuleType.ACCOUNT_ACCESS, 574],
      // Floor set by the header row, which is `min-width: max-content` per column
      // so a label can never be squeezed to an initial.
      [DashboardModuleType.HOLDINGS, 720]
    ])(
      'places %s wide enough for its own table from 1280px upward',
      (moduleType, minimumContentWidth) => {
        const { defaultItemCols } = dashboardModules[moduleType];

        for (const viewportWidth of [1280, 1440, 1920]) {
          expect(contentWidth(viewportWidth, defaultItemCols)).toBeGreaterThan(
            minimumContentWidth
          );
        }
      }
    );

    it('keeps the access table narrow enough to sit beside something', () => {
      // Widening is bounded on the other side too: a default that fills the grid
      // leaves a freshly added module unable to share a row with anything. That
      // bound is worth holding wherever the content does not need the width, and
      // the access table does not - its widest cell is a share address, which is
      // capped.
      expect(
        dashboardModules[DashboardModuleType.ACCOUNT_ACCESS].defaultItemCols
      ).toBeLessThanOrEqual(8);
    });

    it('gives the holdings table the whole width instead', () => {
      // The exception, and the reason the bound above is stated per module rather
      // than for both.
      //
      // Eight columns satisfy the header-row floor asserted above, and on that
      // arithmetic alone they looked sufficient. They are not, because the floor is
      // not the whole requirement: the NAME column is content-sized, so a portfolio
      // of realistic holdings widens the table past what a fixed column set
      // predicts and the trailing performance header truncates. Measured both ways -
      // four holdings clip nothing at eight columns at 1280, 1440 or 1920, and
      // thirty-one clip at all three, while twelve clip at none.
      //
      // A default that starts with a column header cut in half is worse than one
      // that starts wide, and either way the other state is one resize away. It is
      // also what the three other table-bearing modules already do.
      expect(
        dashboardModules[DashboardModuleType.HOLDINGS].defaultItemCols
      ).toBe(GRID_COLUMNS);
    });

    it('gives the access table room for a header row and a grant', () => {
      const { defaultItemRows, minItemRows } =
        dashboardModules[DashboardModuleType.ACCOUNT_ACCESS];

      // Rows are a constant 80px with a 10px margin between them, and the card
      // header plus the module gutter take roughly 80px out of the cell. Three rows
      // therefore leave about 180px - not enough for a table header and one row -
      // which is why the minimum is four rather than three.
      expect(minItemRows).toBeGreaterThanOrEqual(4);
      expect(
        defaultItemRows * 80 + (defaultItemRows - 1) * 10 - 80
      ).toBeGreaterThan(428);
    });
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

  /**
   * The qualified name is the string every surface that NAMES a module to a person
   * has to agree on: the module chrome's title and region name, the catalog row's
   * accessible name, and every live-region announcement the canvas writes.
   *
   * They had each composed it for themselves, and the moment one of them did not -
   * the canvas, which announced the bare name - a reader was told `Settings removed
   * from the dashboard` about one of the two modules it could have been. Hence one
   * function, tested here rather than four times over.
   */
  describe('getQualifiedDashboardModuleName', () => {
    it('leaves a name no other module shares exactly as the registry gives it', () => {
      expect(
        getQualifiedDashboardModuleName({
          context: undefined,
          name: 'Holdings'
        })
      ).toBe('Holdings');
    });

    it('joins a qualifier with a spaced middle dot', () => {
      expect(
        getQualifiedDashboardModuleName({
          context: 'Account',
          name: 'Settings'
        })
      ).toBe('Settings · Account');
    });

    /**
     * `undefined` rather than the empty string for a module it cannot name, so a
     * caller binding this to an accessible name removes the attribute instead of
     * setting an empty one. A control named by the empty string has no name at all,
     * which is worse than one named by its own content.
     */
    it.each<unknown>([undefined, null, {}, { name: '' }])(
      'answers %p with undefined rather than an empty name',
      (module) => {
        // Deliberately out of contract, and typed to say so. The declared parameter
        // requires a name because every real caller either holds a registry entry or
        // holds nothing - `getDashboardModule` returns `undefined` for a discriminator
        // it does not know, which is the `undefined` case below. The nameless-object
        // cases are defence in depth against a hand-written layout document, so they
        // are cast through the function's own parameter type rather than weakening it:
        // if that signature ever changes, this cast follows it instead of hiding it.
        expect(
          getQualifiedDashboardModuleName(
            module as Parameters<typeof getQualifiedDashboardModuleName>[0]
          )
        ).toBeUndefined();
      }
    );

    // The separator belongs to neither field, which is why neither field carries it.
    it('takes the separator from neither the name nor the qualifier', () => {
      // Annotated because the map is declared with `satisfies` rather than a type, so
      // it keeps each entry's exact inferred shape - and an entry without a qualifier
      // genuinely has no `context` property to read. Widening to the interface is what
      // makes the absent case readable as `undefined` instead of a compile error.
      for (const module of Object.values<DashboardModule>(dashboardModules)) {
        expect(module.name).not.toContain('·');
        expect(module.context ?? '').not.toContain('·');
      }
    });

    /**
     * The whole reason the function exists: every registry entry whose title collides
     * with another's must resolve to a qualified name, and no two entries may resolve
     * to the same one. Asserted over the real map rather than a fixture, so adding a
     * third `Markets` without a qualifier fails here.
     */
    it('gives every registered module a name no other module answers to', () => {
      const names = Object.values(dashboardModules).map((module) => {
        return getQualifiedDashboardModuleName(module);
      });

      expect(new Set(names).size).toBe(names.length);
    });

    // The collisions this is for, named explicitly so the pairs are documented rather
    // than merely counted.
    //
    // BOTH members of a colliding pair carry a qualifier, which is why neither
    // `Markets` nor `Settings` appears here on its own. The absence of a qualifier
    // is not itself a distinguishing mark: left bare, one row read as a plain
    // `Markets` beside a qualified `Markets · …`, and that bare row was the one a
    // viewer could not identify from its own label.
    //
    // Neither qualifier is the primary name of another module either. `Admin
    // Control` names this family's own overview module, and `Market Data` names the
    // administrative market-data module, so using either as a qualifier here would
    // put the same words on one row as a qualifier and two rows away as a name.
    it('tells the modules sharing a title apart', () => {
      // Read off the map directly rather than through the string-keyed lookup, so no
      // assertion is needed to say the entry exists: the map is declared complete over
      // the enum.
      const qualified = (moduleType: DashboardModuleType) => {
        return getQualifiedDashboardModuleName(dashboardModules[moduleType]);
      };

      expect(qualified(DashboardModuleType.MARKETS)).toBe(
        'Markets · Highlights'
      );
      expect(qualified(DashboardModuleType.MARKETS_PREMIUM)).toBe(
        'Markets · Details'
      );
      expect(qualified(DashboardModuleType.ACCOUNT_SETTINGS)).toBe(
        'Settings · Account'
      );
      expect(qualified(DashboardModuleType.ADMIN_SETTINGS)).toBe(
        'Settings · System'
      );

      // The two qualifiers above are distinct from the primary names they could
      // otherwise have collided with.
      expect(qualified(DashboardModuleType.ADMIN_OVERVIEW)).toBe(
        'Admin Control'
      );
      expect(qualified(DashboardModuleType.ADMIN_MARKET_DATA)).toBe(
        'Market Data'
      );
    });
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
