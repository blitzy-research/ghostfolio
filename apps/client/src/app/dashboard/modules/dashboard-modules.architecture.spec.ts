import { dashboardModules } from '@ghostfolio/common/dashboard';

import { readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';

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

    // A display name is not decoration. The catalog builds each row's accessible
    // name from it, so two modules sharing one name give a screen reader two rows
    // it announces identically - and because a row shows nothing but the name,
    // they are indistinguishable by eye as well. Two collisions existed and both
    // were reachable by one viewer at once: `Settings` for the account and admin
    // modules, and `Markets` for the plain and the extended market modules.
    //
    // What used to keep them apart was the URL each sat behind. On a single
    // canvas there is no URL, so the name has to carry the distinction itself.
    // Asserted over the real shared map rather than a stub, since that map is
    // where a future collision would be introduced.
    it('gives every registered module a distinct display name', () => {
      const names = Object.values(dashboardModules).map(({ name }) => {
        return name;
      });
      const duplicated = [
        ...new Set(
          names.filter((name, index) => {
            return names.indexOf(name) !== index;
          })
        )
      ];

      // Reported as the offending names rather than as a bare count, so a
      // failure says which modules collided instead of only that some did.
      expect(duplicated).toEqual([]);
      expect(new Set(names).size).toBe(Object.keys(DashboardModuleType).length);
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
});
