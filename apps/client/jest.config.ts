import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * The workspace root, resolved without reference to where the command was typed,
 * so the coverage gate below means the same thing from every working directory.
 *
 * Identical to the resolver in `apps/api/jest.config.ts`, and kept identical on
 * purpose: a gate that binds in one project and not in the other is a trap.
 *
 * Two independent anchors, in order. Nx sets `NX_WORKSPACE_ROOT` on every task it
 * runs, derived from the repository rather than from the caller's directory, so
 * `npm test`, `nx test client`, `nx run-many` and CI all arrive here with it set.
 * Failing that - a bare `jest --config` invocation, which nothing in this
 * repository does - the directory holding `nx.json` is found by walking up, which
 * answers identically from anywhere inside the checkout. Only a run started
 * outside the checkout falls through to the working directory, and there the keys
 * match nothing and Jest fails the run with `Coverage data for … was not found`,
 * which is the safe direction to fail in.
 *
 * `__dirname` would be the obvious anchor and cannot be used - measured, not
 * assumed. Node's native TypeScript support loads this file as an ES module,
 * because `export default` is ESM syntax and the nearest `package.json` declares
 * no type, so `__dirname` is not defined and merely referencing it fails the whole
 * run with `Jest: Failed to parse the TypeScript config file`.
 * `import.meta.dirname` is the ESM counterpart and is equally unavailable, because
 * `tsconfig.spec.json` compiles this file for `npm run typecheck:tests`, where
 * `import.meta` is an error.
 */
const resolveWorkspaceRoot = () => {
  if (process.env.NX_WORKSPACE_ROOT) {
    return process.env.NX_WORKSPACE_ROOT;
  }

  let candidate = process.cwd();

  while (!existsSync(join(candidate, 'nx.json'))) {
    const parent = dirname(candidate);

    if (parent === candidate) {
      return process.cwd();
    }

    candidate = parent;
  }

  return candidate;
};

const workspaceRoot = resolveWorkspaceRoot();

export default {
  displayName: 'client',

  setupFilesAfterEnv: ['<rootDir>/src/test-setup.ts'],
  globals: {},
  // The gate for the module registry, the client-side layout persistence service
  // and the grid canvas component. Coverage itself is armed by
  // `codeCoverage: true` on the test target in `apps/client/project.json`, not
  // here: Nx validates this file against Jest's *project* option schema, in which
  // `collectCoverage` is a global-only key. Without coverage collected,
  // `coverageThreshold` below is never evaluated and the run still exits 0.
  //
  // Relative to `rootDir` (`apps/client`), and naming the dashboard tree rather
  // than the gated files so they are instrumented even along paths no spec
  // reaches. A project-wide pattern would instrument every pre-existing component
  // with no threshold group to satisfy.
  collectCoverageFrom: [
    'src/app/dashboard/**/*.ts',
    '!src/app/dashboard/**/*.spec.ts'
  ],
  coverageDirectory: '../../coverage/apps/client',
  // Keyed per path with no aggregate `global` group: Jest sorts every file matched
  // by a path key out of that group, so adding one would impose this threshold on
  // every pre-existing component.
  //
  // Each key is ABSOLUTE, and that is load-bearing rather than tidy. Jest resolves
  // a threshold key with `path.resolve()` against the process working directory:
  // `coverageThreshold` is one of the few options in which `<rootDir>` is *not*
  // expanded, so a repository-relative key silently means a different file
  // depending on where the command was started. Written relative, these keys
  // matched the three units when the target ran from the workspace root, as
  // `npm test` and CI do, and matched nothing when it ran from `apps/client`, where
  // Jest then failed the run with `Coverage data for … was not found`. That is two
  // genuinely different outcomes with no difference Nx can see - the cache key for
  // `@nx/jest:jest` carries no working directory - so a run that failed the gate
  // from that directory could afterwards be replayed from the root as a success.
  // Anchoring the keys to the workspace root makes the gate answer the same way
  // from anywhere, which is what makes that cache key sound again.
  coverageThreshold: {
    [join(
      workspaceRoot,
      'apps/client/src/app/dashboard/dashboard-canvas/dashboard-canvas.component.ts'
    )]: {
      lines: 80
    },
    [join(
      workspaceRoot,
      'apps/client/src/app/dashboard/module-registry.service.ts'
    )]: {
      lines: 80
    },
    [join(
      workspaceRoot,
      'apps/client/src/app/dashboard/services/dashboard-layout.service.ts'
    )]: {
      lines: 80
    }
  },
  snapshotSerializers: [
    'jest-preset-angular/build/serializers/no-ng-attributes',
    'jest-preset-angular/build/serializers/ng-snapshot',
    'jest-preset-angular/build/serializers/html-comment'
  ],
  transform: {
    '^.+.(ts|mjs|js|html)$': [
      'jest-preset-angular',
      {
        tsconfig: '<rootDir>/tsconfig.spec.json',
        stringifyContentPathRegex: '\\.(html|svg)$'
      }
    ]
  },
  // Dependencies that ship ES modules under a plain `.js` extension rather than
  // `.mjs` have to be transformed as well, or every spec that transitively imports
  // one fails to parse with `Cannot use import statement outside a module` before a
  // single assertion runs. Two families qualify, and both are load-bearing here:
  //
  //  - `@ionic/angular/standalone` re-exports `@ionic/core`, which is built by
  //    `@stencil` and reached by every component that registers an Ionicon;
  //  - `color` (and its `color-convert` / `color-name` / `color-string`
  //    dependencies) is `"type": "module"` from v5 onwards, and is reached through
  //    `@ghostfolio/ui`'s chart components - which puts it in the import graph of
  //    the public portfolio, the account and holding detail dialogs, the activities
  //    module, the application shell and the route table.
  //
  // The alternatives are matched immediately after `node_modules/`, so the `color`
  // entry is written out in full rather than as a bare prefix: `color` alone would
  // also exempt unrelated packages whose name merely starts with it.
  transformIgnorePatterns: [
    'node_modules/(?!(.*\\.mjs$|@ionic|@stencil|color(-convert|-name|-string)?/|ionicons))'
  ],
  preset: '../../jest.preset.js'
};
