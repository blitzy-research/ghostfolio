/* eslint-disable */
export default {
  displayName: 'client',

  setupFilesAfterEnv: ['<rootDir>/src/test-setup.ts'],
  globals: {},
  // Coverage gate for the three dashboard units the testing requirement names:
  // the module registry, the client-side layout persistence service and the
  // grid canvas component.
  //
  // ⚠ `collectCoverage` is what arms everything below, and Jest reports it as
  // `Validation Warning: Unknown option "collectCoverage"` on every run. That
  // warning is expected and harmless. Nx invokes Jest as
  // `runCLI(argv, [configPath])`, so Jest validates this file against its
  // *project* option schema, in which `collectCoverage` is a global-only key —
  // yet it is still lifted into the global config and still honoured, which the
  // written report confirms. Do NOT silence the warning by removing the key:
  // without it Jest builds no coverage map, `coverageThreshold` below is never
  // evaluated, and the run still exits 0, so the gate would be disarmed with no
  // outward sign. The sibling `apps/api/jest.config.ts` sets the same flag from
  // `targets.test.options.codeCoverage` in its `project.json` and so avoids the
  // warning; that is deliberately not mirrored here, because
  // `apps/client/project.json` stays unmodified.
  collectCoverage: true,
  // Matched against paths relative to `rootDir`, which is this file's own
  // directory (`apps/client`), because `jest.preset.js` declares none. Naming
  // the dashboard tree guarantees the gated units are instrumented even along
  // code paths no spec reaches, so they enter the coverage map and are measured
  // rather than skipped. Scoped to that one tree on purpose: a project-wide
  // pattern would instrument every pre-existing client component to no purpose,
  // because there is no aggregate threshold group for them to satisfy.
  collectCoverageFrom: [
    'src/app/dashboard/**/*.ts',
    '!src/app/dashboard/**/*.spec.ts'
  ],
  coverageDirectory: '../../coverage/apps/client',
  // Keyed per path, and intentionally with NO aggregate `global` group. Jest
  // sorts every file matched by a path or glob key out of the aggregate group,
  // so adding one would apply this threshold to the whole project instead —
  // including every component that has no coverage baseline — and fail the
  // target immediately.
  //
  // These keys are resolved with `path.resolve()` against the process working
  // directory and are NOT subject to `<rootDir>` substitution. That is why they
  // are workspace-relative while `collectCoverageFrom` above is
  // `rootDir`-relative, and it means this target must be RUN FROM THE WORKSPACE
  // ROOT — which is where `npm test` and CI run it. Invoked from `apps/client`
  // instead, the keys match nothing and Jest fails the run with `Coverage data
  // for … was not found` even though the report shows the units covered. A key
  // that matches nothing failing closed is the point of writing them out: it is
  // what makes silent non-enforcement impossible.
  //
  // Only `lines` is asserted, matching the stated requirement of at least 80 %
  // line coverage for these units and nothing beyond it.
  coverageThreshold: {
    'apps/client/src/app/dashboard/dashboard-canvas/dashboard-canvas.component.ts':
      {
        lines: 80
      },
    'apps/client/src/app/dashboard/module-registry.service.ts': {
      lines: 80
    },
    'apps/client/src/app/dashboard/services/dashboard-layout.service.ts': {
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
  // `@ionic/angular/standalone` re-exports `@ionic/core`, which ships plain
  // `.js` ES modules rather than `.mjs`, so those packages have to be
  // transformed as well or every spec that transitively imports an Ionicon
  // fails to parse.
  transformIgnorePatterns: [
    'node_modules/(?!(.*\\.mjs$|@ionic|@stencil|ionicons))'
  ],
  preset: '../../jest.preset.js'
};
