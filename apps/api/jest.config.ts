import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * The workspace root, resolved without reference to where the command was typed,
 * so the coverage gate below means the same thing from every working directory.
 *
 * Two independent anchors, in order. Nx sets `NX_WORKSPACE_ROOT` on every task it
 * runs, derived from the repository rather than from the caller's directory, so
 * `npm test`, `nx test api`, `nx run-many` and CI all arrive here with it set.
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
 * `tsconfig.spec.json` compiles this file as CommonJS for
 * `npm run typecheck:tests`, where `import.meta` is an error.
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
  displayName: 'api',

  globals: {},
  transform: {
    '^.+\\.[tj]s$': [
      'ts-jest',
      {
        tsconfig: '<rootDir>/tsconfig.spec.json'
      }
    ]
  },
  moduleFileExtensions: ['ts', 'js', 'html'],
  // The gate for the two layout endpoints. Coverage itself is armed by
  // `codeCoverage: true` on the test target in `apps/api/project.json`, not here:
  // Nx validates this file against Jest's *project* option schema, in which
  // `collectCoverage` is a global-only key. Without coverage collected,
  // `coverageThreshold` below is never evaluated and the run still exits 0.
  //
  // Relative to `rootDir` (`apps/api`), and naming both units explicitly so they
  // are instrumented even along paths no spec reaches.
  collectCoverageFrom: [
    'src/app/user/user-dashboard-layout.controller.ts',
    'src/app/user/user-dashboard-layout.service.ts'
  ],
  // Keyed per path with no aggregate `global` group: Jest sorts every file matched
  // by a path key out of that group, so adding one would impose this threshold on
  // every pre-existing spec.
  //
  // Each key is ABSOLUTE, and that is load-bearing rather than tidy. Jest resolves
  // a threshold key with `path.resolve()` against the process working directory:
  // `coverageThreshold` is one of the few options in which `<rootDir>` is *not*
  // expanded, so a repository-relative key silently means a different file
  // depending on where the command was started. Written relative, these keys
  // matched the two units when the target ran from the workspace root, as
  // `npm test` and CI do, and matched nothing when it ran from `apps/api`, where
  // Jest then failed the run with `Coverage data for … was not found`. That is two
  // genuinely different outcomes with no difference Nx can see - the cache key for
  // `@nx/jest:jest` carries no working directory - so a run that failed the gate
  // from this directory could afterwards be replayed from the root as a success,
  // and Nx labelled `api:test` a flaky task for exactly that reason. Anchoring the
  // keys to the workspace root makes the gate answer the same way from anywhere,
  // which is what makes that cache key sound again.
  coverageThreshold: {
    [join(
      workspaceRoot,
      'apps/api/src/app/user/user-dashboard-layout.controller.ts'
    )]: {
      lines: 80
    },
    [join(
      workspaceRoot,
      'apps/api/src/app/user/user-dashboard-layout.service.ts'
    )]: {
      lines: 80
    }
  },
  coverageDirectory: '../../coverage/apps/api',
  testEnvironment: 'node',
  preset: '../../jest.preset.js'
};
