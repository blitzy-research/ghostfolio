/* eslint-disable */
export default {
  displayName: 'client',

  setupFilesAfterEnv: ['<rootDir>/src/test-setup.ts'],
  globals: {},
  coverageDirectory: '../../coverage/apps/client',
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
