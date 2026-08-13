export default {
  displayName: 'ui',

  setupFilesAfterEnv: ['<rootDir>/src/test-setup.ts'],
  globals: {},
  coverageDirectory: '../../coverage/libs/ui',
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
  // one fails to parse with `SyntaxError: Unexpected token 'export'` before a single
  // assertion runs. The baseline `node_modules/(?!.*.mjs$)` is not enough here: the
  // assistant registers Ionicons, so `@ionic/angular/standalone` re-exports
  // `@ionic/core`, which is built by `@stencil`, and its `components/index.js` is
  // the file the parse fails on.
  //
  // The list is identical to `apps/client/jest.config.ts`, which needs the same
  // alternatives for the same reason: the `@ionic` and `@stencil` families,
  // `ionicons`, and `color` (with its `color-convert` / `color-name` /
  // `color-string` dependencies), which is `"type": "module"` from v5 onwards and is
  // reached through this library's chart components. A spec that runs in one project
  // and not in the other is a trap, so the two lists are kept identical. The
  // alternatives match immediately after `node_modules/`, so `color` is written out
  // in full rather than as a bare prefix that would also exempt unrelated packages
  // whose name merely starts with it.
  transformIgnorePatterns: [
    'node_modules/(?!(.*\\.mjs$|@ionic|@stencil|color(-convert|-name|-string)?/|ionicons))'
  ],
  snapshotSerializers: [
    'jest-preset-angular/build/serializers/no-ng-attributes',
    'jest-preset-angular/build/serializers/ng-snapshot',
    'jest-preset-angular/build/serializers/html-comment'
  ],
  preset: '../../jest.preset.js'
};
