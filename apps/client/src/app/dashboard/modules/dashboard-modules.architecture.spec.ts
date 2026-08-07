import {
  DashboardModule,
  dashboardModules
} from '@ghostfolio/common/dashboard';
import { internalRoutes } from '@ghostfolio/common/routes/routes';

import { readFileSync, readdirSync } from 'node:fs';
import { basename, join, sep } from 'node:path';

import { DashboardModuleType } from '../enums/dashboard-module-type';

/**
 * The dependency direction between a module wrapper and the canvas layer,
 * asserted as an architectural fact rather than trusted as a convention.
 *
 * A module must never import from or reference the canvas layer; everything it
 * needs arrives through the existing services. That constraint is what lets the
 * canvas own layout state alone, and it is enforced twice over at runtime -
 * `NgComponentOutlet` means a wrapper is never handed a canvas reference, and
 * the registry holds lazy loaders so a wrapper cannot be reached any other way.
 *
 * Neither of those enforcements, however, stops somebody *typing* the import.
 * A wrapper that pulled in the layout service would compile, pass every existing
 * test and quietly acquire the ability to persist a layout - defeating the rule
 * that grid state changes are the only thing that trigger a save. `libs`-to-`app`
 * direction is policed by `@nx/enforce-module-boundaries`, but a wrapper
 * importing a *sibling* directory inside the same project is invisible to it,
 * because both sides sit in the same Nx project and no tag rule is crossed. This
 * suite is that missing check.
 *
 * It reads the wrappers as text on purpose. Importing them would prove nothing:
 * a forbidden import is a compile-time fact, and by the time a module object
 * exists the import statement has been erased. Reading the source is the only
 * way to observe the thing being forbidden.
 */
describe('the dashboard module wrappers', () => {
  /** Resolved from this spec's own location, so the walk cannot drift. */
  const modulesDirectory = __dirname;

  /** The canvas layer, of which the module tree is a sibling. */
  const dashboardDirectory = join(modulesDirectory, '..');

  /**
   * The one file in the whole canvas layer permitted to name a wrapper, which is
   * what makes the registry the only way to reach one.
   */
  const registrationsFileName = 'dashboard-module.registrations.ts';

  /**
   * A discriminator rendered as the class-name fragment its wrapper is named
   * for: `x-ray` becomes `XRay`, `admin-market-data` becomes `AdminMarketData`.
   *
   * Declared once, because both the registration-table binding and the
   * canvas-layer bypass scan derive their expectations from it and a second copy
   * would let the two drift apart.
   */
  const toPascalCase = (aModuleType: string) => {
    return aModuleType
      .split('-')
      .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
      .join('');
  };

  /** The class every wrapper of a given discriminator exports. */
  const wrapperClassNameOf = (aModuleType: string) => {
    return `Gf${toPascalCase(aModuleType)}ModuleComponent`;
  };

  /**
   * Import specifiers a wrapper may never name, each with the reason so a
   * failure explains itself rather than merely pointing at a string.
   */
  const forbiddenImports = [
    {
      reason:
        'the canvas owns the grid; a wrapper that reaches back into it inverts the dependency and could move itself',
      specifier: 'dashboard-canvas'
    },
    {
      reason:
        'the registry is the only mechanism that introduces a module type, so a module registering anything would make it a second one',
      specifier: 'module-registry'
    },
    {
      reason:
        'layout saves must originate only from grid state changes, so no module may reach a layout API',
      specifier: 'dashboard-layout.service'
    },
    {
      reason:
        'grid policy is declared in exactly one place, and it is not here',
      specifier: 'dashboard-canvas.config'
    },
    {
      reason:
        'the registration table references wrappers, so a wrapper referencing it would close a cycle',
      specifier: 'dashboard-module.registrations'
    },
    {
      reason:
        'a module must not know it is on a grid at all; only the canvas layer may touch the grid engine',
      specifier: 'angular-gridster2'
    }
  ];

  /** Every wrapper directory, discovered rather than listed. */
  const wrapperDirectories = readdirSync(modulesDirectory, {
    withFileTypes: true
  })
    .filter((entry) => entry.isDirectory())
    .map(({ name }) => name)
    .sort();

  /**
   * Deliberately assertion-free: this runs while Jest is collecting the suite,
   * and an `expect` that fails there aborts the whole file with no named test to
   * point at. Anomalies are recorded and asserted inside real tests below, so a
   * missing or duplicated wrapper reports itself precisely.
   */
  const wrapperFilesOf = (directory: string) => {
    return readdirSync(join(modulesDirectory, directory))
      .filter((file) => file.endsWith('.module.component.ts'))
      .sort();
  };

  const wrappers = wrapperDirectories.map((directory) => {
    const files = wrapperFilesOf(directory);

    return {
      directory,
      files,
      name: files.length === 1 ? basename(files[0]) : undefined,
      source: files
        .map((file) =>
          readFileSync(join(modulesDirectory, directory, file), 'utf8')
        )
        .join('\n')
    };
  });

  /**
   * Every import specifier in a wrapper, taken from both static `import` forms
   * and dynamic `import()` calls so neither route around the rule is missed.
   */
  const specifiersOf = (source: string) => {
    return [...source.matchAll(/(?:from|import)\s*\(?\s*'([^']+)'/g)].map(
      ([, specifier]) => specifier
    );
  };

  describe('the wrapper inventory', () => {
    it('provides exactly one wrapper for every registered module type', () => {
      // Pinned against the discriminator vocabulary rather than a hand-written
      // count, so adding an enum member without a wrapper fails here instead of
      // at runtime when the catalog offers a module the canvas cannot resolve.
      expect(wrappers).toHaveLength(Object.keys(DashboardModuleType).length);
    });

    it('names each wrapper directory after the discriminator it serves', () => {
      // The persisted discriminator is the directory name, which is what makes
      // the registration table's dynamic import paths predictable.
      expect(wrapperDirectories).toEqual(
        Object.values(DashboardModuleType).map(String).sort()
      );
    });

    it('holds exactly one wrapper component in each directory', () => {
      // Zero would leave a registered discriminator unresolvable; two would leave
      // it ambiguous. Reported per directory so the failure names the offender.
      expect(
        wrappers.map(({ directory, files }) => `${directory}: ${files.length}`)
      ).toEqual(wrapperDirectories.map((directory) => `${directory}: 1`));
    });

    it('follows the same file-naming convention throughout', () => {
      expect(
        wrappers.map(({ directory, name }) => `${directory}/${name}`)
      ).toEqual(
        wrapperDirectories.map(
          (directory) => `${directory}/${directory}.module.component.ts`
        )
      );
    });

    // A display name is not decoration, and neither is its provenance. Each name
    // is the shared route registry's title for the screen the module replaces,
    // reused verbatim so the existing translation unit - and with it all twelve
    // locales - applies at no cost. That reuse is the contract, and it is what
    // makes the registry titles below the authority rather than this map.
    //
    // Two of those titles collide by construction: the registry titles both
    // market screens `Markets` and both settings screens `Settings`. The names
    // therefore MUST collide too, and the qualifier - a separate field - is what
    // tells the rows apart. Asserted here so neither half can drift: not the exact
    // reuse, and not the disambiguation that makes the reuse safe.
    it('reuses the exact route title as every module display name', () => {
      const titles = {
        [DashboardModuleType.ACCOUNT_ACCESS]:
          internalRoutes.account.subRoutes.access.title,
        [DashboardModuleType.ACCOUNT_MEMBERSHIP]:
          internalRoutes.account.subRoutes.membership.title,
        [DashboardModuleType.ACCOUNT_SETTINGS]: internalRoutes.account.title,
        [DashboardModuleType.ACCOUNTS]: internalRoutes.accounts.title,
        [DashboardModuleType.ACTIVITIES]:
          internalRoutes.portfolio.subRoutes.activities.title,
        [DashboardModuleType.ADMIN_JOBS]:
          internalRoutes.adminControl.subRoutes.jobs.title,
        [DashboardModuleType.ADMIN_MARKET_DATA]:
          internalRoutes.adminControl.subRoutes.marketData.title,
        [DashboardModuleType.ADMIN_OVERVIEW]: internalRoutes.adminControl.title,
        [DashboardModuleType.ADMIN_SETTINGS]:
          internalRoutes.adminControl.subRoutes.settings.title,
        [DashboardModuleType.ADMIN_USERS]:
          internalRoutes.adminControl.subRoutes.users.title,
        [DashboardModuleType.ALLOCATIONS]:
          internalRoutes.portfolio.subRoutes.allocations.title,
        [DashboardModuleType.FIRE]:
          internalRoutes.portfolio.subRoutes.fire.title,
        [DashboardModuleType.HOLDINGS]:
          internalRoutes.home.subRoutes.holdings.title,
        [DashboardModuleType.MARKETS]:
          internalRoutes.home.subRoutes.markets.title,
        [DashboardModuleType.MARKETS_PREMIUM]:
          internalRoutes.home.subRoutes.marketsPremium.title,
        [DashboardModuleType.PORTFOLIO_ANALYSIS]:
          internalRoutes.portfolio.subRoutes.analysis.title,
        [DashboardModuleType.PORTFOLIO_OVERVIEW]: internalRoutes.home.title,
        [DashboardModuleType.PORTFOLIO_SUMMARY]:
          internalRoutes.home.subRoutes.summary.title,
        [DashboardModuleType.WATCHLIST]:
          internalRoutes.home.subRoutes.watchlist.title,
        [DashboardModuleType.X_RAY]:
          internalRoutes.portfolio.subRoutes.xRay.title
      };

      // Compared as one object so a failure names every module that drifted
      // rather than stopping at the first.
      expect(
        Object.fromEntries(
          Object.entries(titles).map(([moduleType]) => [
            moduleType,
            dashboardModules[moduleType as DashboardModuleType].name
          ])
        )
      ).toEqual(titles);

      // The AI chat module is the one module with no screen to inherit a title
      // from, and therefore the only display name this refactor introduces.
      expect(dashboardModules[DashboardModuleType.AI_CHAT].name).toBe(
        'AI Chat'
      );
      expect(Object.keys(titles)).toHaveLength(
        Object.keys(DashboardModuleType).length - 1
      );
    });

    it('makes every registered module distinguishable in the catalog', () => {
      // What the catalog actually renders and announces: the name, followed by
      // the qualifier where there is one. Two rows may share a name - the route
      // titles do - but no two may read identically, or a screen reader announces
      // them the same way and the eye cannot separate them either.
      // Read through the declared contract rather than the map's inferred literal
      // type: `satisfies` keeps each entry's own shape, so an optional member is
      // absent from - rather than optional on - the entries that omit it.
      const labels = Object.values<DashboardModule>(dashboardModules).map(
        ({ context, name }) => {
          return context ? `${name} · ${context}` : name;
        }
      );
      const duplicated = [
        ...new Set(
          labels.filter((label, index) => {
            return labels.indexOf(label) !== index;
          })
        )
      ];

      // Reported as the offending labels rather than as a bare count, so a
      // failure says which modules collided instead of only that some did.
      expect(duplicated).toEqual([]);
      expect(new Set(labels).size).toBe(
        Object.keys(DashboardModuleType).length
      );
    });

    it('qualifies only the modules whose display name is shared', () => {
      const names = Object.values(dashboardModules).map(({ name }) => name);

      // A qualifier exists for one reason: to separate a name two modules share.
      // On an unshared name it is noise on the row and a second string to keep
      // translated, so it is asserted away rather than left to judgement.
      //
      // The converse is deliberately NOT asserted. A shared name needs the pair
      // to be distinguishable, which the preceding test checks, and that does not
      // require both rows to be qualified: `Markets` beside `Markets · Market
      // Data` already says which is which, and qualifying the plain one as well
      // would add a word that separates nothing.
      expect(
        Object.entries<DashboardModule>(dashboardModules)
          .filter(([, { context, name }]) => {
            const isShared =
              names.filter((candidate) => candidate === name).length > 1;

            return !!context && !isShared;
          })
          .map(([moduleType]) => moduleType)
      ).toEqual([]);
    });

    it('gives every registered module a non-empty display name', () => {
      expect(
        Object.entries(dashboardModules)
          .filter(([, { name }]) => {
            return !name?.trim();
          })
          .map(([moduleType]) => moduleType)
      ).toEqual([]);
    });
  });

  describe('isolation from the canvas layer', () => {
    it.each(wrappers.map(({ directory }) => directory))(
      '%s imports nothing from the canvas layer',
      (directory) => {
        const { source } = wrappers.find(
          (wrapper) => wrapper.directory === directory
        );

        const offences = specifiersOf(source).flatMap((specifier) => {
          return forbiddenImports
            .filter((forbidden) => specifier.includes(forbidden.specifier))
            .map(({ reason }) => `${specifier} (${reason})`);
        });

        expect(offences).toEqual([]);
      }
    );

    it('reaches the rest of the application only through public entry points', () => {
      const offenders = wrappers.flatMap(({ directory, source }) => {
        return specifiersOf(source)
          .filter((specifier) => {
            // A relative specifier that climbs out of the wrapper's own
            // directory is how a canvas-layer import would most plausibly be
            // written, and it evades the name-based list above.
            return specifier.startsWith('../');
          })
          .map((specifier) => `${directory}: ${specifier}`);
      });

      expect(offenders).toEqual([]);
    });

    it('declares no dependency on the grid engine anywhere in its own tree', () => {
      // Broader than the per-wrapper check: catches a template, a stylesheet or
      // a helper file added beside a wrapper rather than the wrapper itself.
      const offenders = readdirSync(modulesDirectory, { recursive: true })
        .map(String)
        .filter((entry) => /\.(html|scss|ts)$/.test(entry))
        .filter((entry) => !entry.endsWith('.spec.ts'))
        .filter((entry) => {
          return readFileSync(join(modulesDirectory, entry), 'utf8').includes(
            'angular-gridster2'
          );
        });

      expect(offenders).toEqual([]);
    });
  });

  /**
   * Which wrapper each persisted discriminator actually resolves to.
   *
   * The checks above establish that a wrapper exists for every discriminator and
   * that the naming lines up. What none of them establishes is the *binding*:
   * that `holdings` loads the holdings wrapper rather than the watchlist one.
   * Two loader thunks are interchangeable as far as types, arity, laziness and
   * inventory are concerned, so swapping any two of them - a one-line editing
   * slip in a 21-entry table, or a rename that moved a class but not the entry
   * naming it - produced a canvas that silently served the wrong module for a
   * saved arrangement, and every existing assertion stayed green.
   *
   * Read as source rather than exercised at run time, and that is a deliberate
   * trade rather than a shortcut. Invoking 21 loaders would materialise 21
   * component trees, and their transitive graphs, inside one Jest process -
   * defeating the lazy boundary these entries exist to create and making this
   * suite the slowest and heaviest in the project. The source carries everything
   * the binding is made of: the directory the loader imports, the symbol it
   * reads off the module, and - checked against the wrapper file itself - whether
   * that symbol is really exported there under the selector the discriminator
   * names. A swapped thunk cannot satisfy all three.
   */
  describe('the registration table', () => {
    const registrationsSource = readFileSync(
      join(dashboardDirectory, registrationsFileName),
      'utf8'
    );

    /**
     * Every `(import specifier, exported symbol, discriminator)` triple in the
     * table, in file order.
     *
     * `[^{}]*?` between the three parts is what keeps a match inside a single
     * entry: an entry's loader body contains no brace of its own, so the pattern
     * cannot bridge two entries and pair one module's import with another's
     * discriminator - which is the very defect being looked for.
     */
    const bindings = [
      ...registrationsSource.matchAll(
        /import\('([^']+)'\)[^{}]*?\bm\.([A-Za-z0-9_]+)[^{}]*?moduleType:\s*DashboardModuleType\.([A-Z0-9_]+)/g
      )
    ].map(([, specifier, exportedSymbol, enumMember]) => {
      return { enumMember, exportedSymbol, specifier };
    });

    it('parses as one lazy loader per discriminator, in catalog order', () => {
      // Guards the two assertions this describe rests on: that the pattern above
      // really matched every entry (an unparsed entry would silently drop out of
      // every check below), and that the table's order still is the enum's.
      expect(bindings.map(({ enumMember }) => enumMember)).toEqual(
        Object.keys(DashboardModuleType)
      );
    });

    it.each(Object.entries(DashboardModuleType))(
      '%s resolves to the wrapper that carries the %s discriminator',
      (enumMember, moduleType) => {
        const binding = bindings.find(
          (candidate) => candidate.enumMember === enumMember
        );

        expect(binding).toBeDefined();

        // 1. The loader imports the discriminator's own directory. This is the
        //    half a swap breaks first, because the directory name IS the
        //    persisted discriminator.
        expect(binding.specifier).toBe(
          `./modules/${moduleType}/${moduleType}.module.component`
        );

        // 2. It reads the symbol that directory's wrapper is named for.
        const expectedSymbol = wrapperClassNameOf(moduleType);

        expect(binding.exportedSymbol).toBe(expectedSymbol);

        // 3. And that symbol is genuinely exported there, under the selector the
        //    discriminator names - checked against the wrapper file rather than
        //    against the table, so the table cannot agree only with itself.
        const wrapperSource = readFileSync(
          join(
            modulesDirectory,
            moduleType,
            `${moduleType}.module.component.ts`
          ),
          'utf8'
        );

        expect(wrapperSource).toContain(`export class ${expectedSymbol}`);
        expect(wrapperSource).toContain(`selector: 'gf-${moduleType}-module'`);
      }
    );
  });

  /**
   * The reverse dependency direction: the canvas layer must not name a wrapper.
   *
   * Rule 3 makes the registry the only mechanism that introduces a module type.
   * The wrapper-side checks above stop a module reaching into the canvas; they
   * say nothing about the canvas reaching into `modules/**`. A `@if` on a module
   * type in the canvas template, a static import in the host, or one special
   * case in the catalog would each be a second introduction mechanism - and,
   * being eager, would also pull that wrapper's tree into the initial bundle and
   * undo the code splitting the loaders exist to provide.
   */
  describe('the canvas layer', () => {
    const moduleTypes = Object.values(DashboardModuleType).map(String);

    /** Every wrapper class name, which is what an eager reference would use. */
    const wrapperClassNames = moduleTypes.map(wrapperClassNameOf);

    /**
     * Every wrapper element selector.
     *
     * Derived from the discriminators rather than matched by shape, because the
     * canvas layer legitimately owns several `gf-dashboard-module-*` names of its
     * own - the host's selector, the drag handle class, the body and scroll-hint
     * classes - and a shape-based pattern would report those as offences.
     */
    const wrapperSelectors = moduleTypes.map((moduleType) => {
      return `gf-${moduleType}-module`;
    });

    /**
     * Every canvas-layer source and template, excluding `modules/**` itself, the
     * specs, and the registration table.
     */
    const canvasLayerFiles = readdirSync(dashboardDirectory, {
      recursive: true
    })
      .map(String)
      .filter((entry) => /\.(html|ts)$/.test(entry))
      .filter((entry) => !entry.endsWith('.spec.ts'))
      .filter((entry) => !entry.split(sep).includes('modules'))
      .filter((entry) => entry !== registrationsFileName)
      .sort();

    it('is discovered rather than listed, so a new file cannot escape the scan', () => {
      // A silently empty scan would pass every assertion below while checking
      // nothing, so the walk is asserted to have found the layer's own parts.
      expect(canvasLayerFiles).toContain(
        join('dashboard-canvas', 'dashboard-canvas.component.ts')
      );
      expect(canvasLayerFiles).toContain(
        join('dashboard-canvas', 'dashboard-canvas.html')
      );
      expect(canvasLayerFiles).toContain(
        join(
          'dashboard-canvas',
          'dashboard-module-host',
          'dashboard-module-host.component.ts'
        )
      );
      expect(canvasLayerFiles).toContain(
        join('module-catalog', 'module-catalog.component.ts')
      );
      expect(canvasLayerFiles).toContain('module-registry.service.ts');
      expect(canvasLayerFiles.length).toBeGreaterThanOrEqual(20);
    });

    it('imports nothing from the module tree outside the registration table', () => {
      const offenders = canvasLayerFiles.flatMap((entry) => {
        return specifiersOf(
          readFileSync(join(dashboardDirectory, entry), 'utf8')
        )
          .filter((specifier) => specifier.includes('modules/'))
          .map((specifier) => `${entry}: ${specifier}`);
      });

      expect(offenders).toEqual([]);
    });

    it('names no wrapper class and mounts no wrapper selector directly', () => {
      const offenders = canvasLayerFiles.flatMap((entry) => {
        const source = readFileSync(join(dashboardDirectory, entry), 'utf8');

        return [...wrapperClassNames, ...wrapperSelectors]
          .filter((reference) => source.includes(reference))
          .map((reference) => `${entry}: ${reference}`);
      });

      // Every module is reached through `NgComponentOutlet` with a type the
      // registry resolved, so neither form may appear here.
      expect(offenders).toEqual([]);
    });

    it('detects a bypass when one is present', () => {
      // The three assertions above are absence assertions, and an absence
      // assertion over a matcher that matches nothing is indistinguishable from a
      // passing one. This is the positive control that keeps them meaningful.
      const bypass = [
        "import { GfHoldingsModuleComponent } from '../modules/holdings/holdings.module.component';",
        '<gf-holdings-module />'
      ].join('\n');

      expect(
        specifiersOf(bypass).filter((specifier) =>
          specifier.includes('modules/')
        )
      ).toHaveLength(1);
      expect(
        [...wrapperClassNames, ...wrapperSelectors].filter((reference) =>
          bypass.includes(reference)
        )
      ).toEqual(['GfHoldingsModuleComponent', 'gf-holdings-module']);
    });
  });

  /**
   * Where a module's position and size live, asserted as an absence.
   *
   * Rule 2 makes grid state the single source of truth for placement. A wrapper
   * that declared `x`, `y`, `cols` or `rows` - as an input, a field or a default
   * - would be a second authority for the same value, and the two would disagree
   * the moment a viewer dragged the module: the grid would move it, the wrapper
   * would keep reporting where it used to be, and whichever one the persisted
   * projection happened to read would win. The wrappers are reached through
   * `NgComponentOutlet`, which passes no inputs at all, so such a declaration
   * could never even be populated - it would simply be a lie that compiles.
   */
  describe('layout state ownership', () => {
    /**
     * Placement vocabulary, taken from the grid item contract.
     *
     * `x`, `y`, `cols` and `rows` are the persisted five minus the discriminator;
     * the rest are the per-item grid options the canvas sets alongside them.
     */
    const placementMembers = [
      'cols',
      'compactEnabled',
      'dragEnabled',
      'layerIndex',
      'maxItemArea',
      'maxItemCols',
      'maxItemRows',
      'minItemArea',
      'minItemCols',
      'minItemRows',
      'resizableHandles',
      'resizeEnabled',
      'rows',
      'x',
      'y'
    ];

    /** Types that carry placement even when the member names do not. */
    const placementTypes = [
      'DashboardLayoutItem',
      'GridsterConfig',
      'GridsterItem',
      'GridsterItemConfig'
    ];

    /**
     * The source with its comments removed.
     *
     * These wrappers are heavily commented and the commentary discusses layout
     * in prose, so scanning the raw text reports the explanation as the offence.
     * Filtering by line matches how this workspace writes comments - block
     * comments occupy whole lines, and a trailing `//` is only stripped when the
     * code before it contains no quote, so an apostrophe inside a comment or a
     * `//` inside a string literal cannot mislead it.
     */
    const codeOf = (source: string) => {
      let isInsideBlockComment = false;

      return source
        .split('\n')
        .filter((line) => {
          const trimmed = line.trim();

          if (isInsideBlockComment) {
            isInsideBlockComment = !trimmed.includes('*/');

            return false;
          }

          if (trimmed.startsWith('/*')) {
            isInsideBlockComment = !trimmed.includes('*/');

            return false;
          }

          return !trimmed.startsWith('//') && !trimmed.startsWith('*');
        })
        .map((line) => {
          const commentStart = line.indexOf('//');

          return commentStart > -1 && !/['"`]/.test(line.slice(0, commentStart))
            ? line.slice(0, commentStart)
            : line;
        })
        .join('\n');
    };

    /**
     * Placement declarations in a wrapper's own code.
     *
     * Declaration-shaped rather than name-shaped: the member has to be followed
     * by a type annotation, an initialiser, an optional marker or a terminator,
     * which is what separates `protected cols = 4` from an unrelated local use
     * of the same letter.
     */
    const placementDeclarationsIn = (source: string) => {
      const code = codeOf(source);

      return [
        ...placementMembers.filter((member) => {
          return new RegExp(
            `(?:^|[\\s;{(,])(?:(?:public|protected|private|readonly|static|declare)\\s+)*${member}\\s*(?:[:=;?]|$)`,
            'm'
          ).test(code);
        }),
        ...placementTypes.filter((type) => {
          return new RegExp(`\\b${type}\\b`).test(code);
        })
      ];
    };

    it.each(wrappers.map(({ directory }) => directory))(
      '%s declares no position or size of its own',
      (directory) => {
        const { source } = wrappers.find(
          (wrapper) => wrapper.directory === directory
        );

        expect(placementDeclarationsIn(source)).toEqual([]);
      }
    );

    it('detects placement state when it is present', () => {
      // The positive control for the absence assertions above, and it covers both
      // halves: a member declaration and a placement type reference.
      expect(
        placementDeclarationsIn(
          [
            'export class GfExampleModuleComponent {',
            '  protected cols = 4;',
            '  public readonly x: number = 0;',
            '  private item: GridsterItemConfig;',
            '}'
          ].join('\n')
        ).sort()
      ).toEqual(['GridsterItemConfig', 'cols', 'x']);

      // And it must not be tripped by prose about layout, which is what every
      // wrapper's own commentary is made of.
      expect(
        placementDeclarationsIn(
          [
            '/**',
            ' * Reserves the eventual prompt area so loading completes without a',
            ' * layout shift: cols = 4, rows = 4, x = 0, y = 0.',
            ' */',
            'export class GfExampleModuleComponent {}'
          ].join('\n')
        )
      ).toEqual([]);
    });
  });
});
