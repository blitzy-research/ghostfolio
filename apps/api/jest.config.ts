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
  // every pre-existing spec. The keys resolve against the process working
  // directory rather than `<rootDir>`, so the target must run from the workspace
  // root, as `npm test` and CI do; from `apps/api` they match nothing and Jest
  // fails with `Coverage data for … was not found`.
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
