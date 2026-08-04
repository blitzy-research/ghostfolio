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
  // ⚠ `collectCoverage` is what arms everything below, and Jest reports it as
  // `Validation Warning: Unknown option "collectCoverage"` on every run. That
  // warning is expected and harmless. Nx invokes Jest as
  // `runCLI(argv, [configPath])`, so Jest validates this file against its
  // *project* option schema, in which `collectCoverage` is a global-only key —
  // yet it is still lifted into the global config and still honoured, which the
  // emitted report under `coverage/apps/api` confirms. Do NOT silence the
  // warning by removing the key: without it Jest builds no coverage map,
  // `coverageThreshold` below is never evaluated, and the run still exits 0, so
  // the gate would be disarmed with no outward sign.
  //
  // The flag deliberately lives here rather than as
  // `targets.test.options.codeCoverage` in `apps/api/project.json`. That file
  // carries no post-baseline change, so the whole gate is expressed in the one
  // file the transformation plan declares for it — which is also what keeps the
  // gate armed for every route into this project (`nx test api`, `nx run-many
  // --target=test`, and therefore `npm test`) including the default
  // configuration, which unlike the `ci` configuration in `nx.json` sets no
  // coverage flag of its own. The sibling `apps/client/jest.config.ts` arms its
  // own gate exactly the same way, for the same reason.
  //
  // Everything below is a valid project option — `collectCoverageFrom` and
  // `coverageDirectory` are declared per project, and `coverageThreshold` is
  // exempt from that validation.
  //
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
  // Keyed per path with no aggregate group on purpose: Jest sorts every file
  // matched by a path key out of the `global` group, so adding one would impose
  // this threshold on every pre-existing spec in the project.
  //
  // These keys are resolved against the process working directory and are not
  // subject to `<rootDir>` substitution, which is why they are workspace-relative
  // while `collectCoverageFrom` above is `rootDir`-relative. The target must
  // therefore run from the workspace root, as `npm test`, `npm run test:api` and
  // CI do; run from `apps/api` the keys match nothing and Jest fails with
  // `Coverage data for … was not found`.
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
