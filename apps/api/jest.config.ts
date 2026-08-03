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
  // Collection itself is switched on OUTSIDE this file, by
  // `targets.test.options.codeCoverage` in `apps/api/project.json`, which the
  // `@nx/jest:jest` executor maps to Jest's `--coverage`. That keeps the gate
  // armed for every route into this project — `nx test api`, `nx run-many
  // --target=test` and therefore `npm test` — including the default
  // configuration, which unlike the `ci` configuration in `nx.json` sets no
  // coverage flag of its own.
  //
  // ⚠ Removing that option disables everything below silently: Jest builds no
  // coverage map, `coverageThreshold` is never evaluated, and the run still
  // exits 0. The flag deliberately does NOT live here as `collectCoverage`,
  // because Nx invokes Jest as `runCLI(argv, [configPath])`, which makes Jest
  // validate this file as a *project* config, and `collectCoverage` is a
  // global-only option there — Jest still honours it but reports it as an
  // unknown option on every run, and a warning inviting the removal of a
  // load-bearing key is worse than no warning at all. The executor option sets
  // the same flag through `argv` instead, so the gate below is evaluated
  // without the warning. Everything else stays here, because
  // `collectCoverageFrom` and `coverageDirectory` are valid project options and
  // `coverageThreshold` is exempt from that validation.
  //
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
  // directory, and are not subject to `<rootDir>` substitution. That is why
  // they are workspace-relative while `collectCoverageFrom` above is
  // `rootDir`-relative, and it means the test target must be RUN FROM THE
  // WORKSPACE ROOT — which is where `npm test`, `npm run test:api` and CI all
  // run it. Invoked from `apps/api` instead, the keys resolve to nothing and
  // Jest fails the run with `Coverage data for … was not found`, even though
  // the coverage table shows both units fully covered.
  //
  // A `**/…`-prefixed glob would be the way to make the keys tolerate any
  // working directory, and it would fail just as closed — Jest reports
  // `Coverage data for … was not found` for an unmatched glob exactly as it
  // does for an unmatched path. It is not used because Jest resolves a glob key
  // against the working directory too and then walks it with `glob.sync`, so
  // from the workspace root every coverage run would traverse the whole tree,
  // `node_modules` included, to find two files that `collectCoverageFrom`
  // already names outright.
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
