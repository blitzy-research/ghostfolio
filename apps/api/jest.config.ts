/* eslint-disable */
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
  // Coverage gate for the dashboard layout endpoints.
  //
  // Enabled here rather than on the command line because the `@nx/jest:jest`
  // target for this project passes no `--coverage` flag. Without it Jest never
  // builds a coverage map, `coverageThreshold` is never evaluated, and the gate
  // below would silently pass.
  collectCoverage: true,
  // Matched against paths relative to `rootDir` (`apps/api`). Naming both units
  // explicitly guarantees they are instrumented, so they appear in the coverage
  // map and are actually measured instead of being skipped. Kept deliberately
  // narrow: a wider pattern would instrument the whole project to no purpose,
  // because there is no aggregate threshold group to satisfy.
  collectCoverageFrom: [
    'src/app/user/user-dashboard-layout.controller.ts',
    'src/app/user/user-dashboard-layout.service.ts'
  ],
  // Keyed per path, and intentionally with no aggregate group. Jest sorts every
  // file matched by a path or glob key out of the aggregate group, so adding
  // one would apply this threshold to every pre-existing spec in this project,
  // none of which has a coverage baseline.
  //
  // These keys are resolved with `path.resolve()` against the process working
  // directory, which is the workspace root under Nx, and are not subject to
  // `<rootDir>` substitution. That is why they are workspace-relative while
  // `collectCoverageFrom` above is `rootDir`-relative.
  //
  // Only `lines` is asserted, matching the stated requirement of at least 80 %
  // line coverage for these two units.
  coverageThreshold: {
    'apps/api/src/app/user/user-dashboard-layout.controller.ts': {
      lines: 80
    },
    'apps/api/src/app/user/user-dashboard-layout.service.ts': {
      lines: 80
    }
  },
  coverageDirectory: '../../coverage/apps/api',
  testEnvironment: 'node',
  preset: '../../jest.preset.js'
};
