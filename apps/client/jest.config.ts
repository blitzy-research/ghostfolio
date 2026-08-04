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
  // outward sign. The sibling `apps/api/jest.config.ts` arms its own gate the
  // same way and carries the same warning, deliberately: both `project.json`
  // files stay unmodified, so each gate is expressed entirely in the one Jest
  // config the transformation plan declares for it.
  collectCoverage: true,
  // Paths are relative to `rootDir` (`apps/client`). Naming the dashboard tree
  // instruments the gated units even along code paths no spec reaches, so they are
  // measured rather than skipped; a project-wide pattern would instrument every
  // pre-existing component with no threshold group to satisfy.
  collectCoverageFrom: [
    'src/app/dashboard/**/*.ts',
    '!src/app/dashboard/**/*.spec.ts'
  ],
  coverageDirectory: '../../coverage/apps/client',
  // Keyed per path with no aggregate `global` group on purpose: Jest sorts every
  // file matched by a path key out of the `global` group, so adding one would
  // impose this threshold on every pre-existing component in the project.
  //
  // These keys are resolved against the process working directory and are not
  // subject to `<rootDir>` substitution, which is why they are workspace-relative
  // while `collectCoverageFrom` above is `rootDir`-relative. The target must
  // therefore run from the workspace root, as `npm test` and CI do; run from
  // `apps/client` the keys match nothing and Jest fails with `Coverage data for …
  // was not found`.
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
  // Dependencies that ship ES modules under a plain `.js` extension rather than
  // `.mjs` have to be transformed as well, or every spec that transitively
  // imports one fails to parse with `Cannot use import statement outside a
  // module` before a single assertion runs. Two families qualify:
  //
  //  - `@ionic/angular/standalone` re-exports `@ionic/core`, which is built by
  //    `@stencil` and reached by every component that registers an Ionicon;
  //  - `color` (and its `color-convert` / `color-name` / `color-string`
  //    dependencies) is `"type": "module"` from v5 onwards. It is reached
  //    through `@ghostfolio/ui`'s chart components, which puts it in the import
  //    graph of the shared public portfolio, the account and holding detail
  //    dialogs, the activities screen, the application shell and the route
  //    table. Naming it here is what lets those specs exercise the real
  //    components instead of standing in for them.
  //
  // The alternatives are matched immediately after `node_modules/`, so the
  // `color` entry is written out in full rather than as a bare prefix: `color`
  // alone would also exempt unrelated packages whose name merely starts with it.
  //
  // Every alternative here is load-bearing, measured rather than assumed: with the
  // baseline `node_modules/(?!.*.mjs$)` alone, 15 of the 22 client suites fail to
  // parse on `@ionic/core/components/index.js`; adding the Ionic and Stencil
  // families but not `color` leaves 4 of them failing on `color/index.js`.
  transformIgnorePatterns: [
    'node_modules/(?!(.*\\.mjs$|@ionic|@stencil|color(-convert|-name|-string)?/|ionicons))'
  ],
  preset: '../../jest.preset.js'
};
