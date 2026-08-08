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
  // every pre-existing component. The keys resolve against the process working
  // directory rather than `<rootDir>`, so the target must run from the workspace
  // root, as `npm test` and CI do; from `apps/client` they match nothing and Jest
  // fails with `Coverage data for … was not found`.
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
