import {
  extractNumberFromString,
  getNumberFormatGroup,
  isKnownDataSource,
  reportSanitizedError
} from '@ghostfolio/common/helper';

import { DataSource } from '@prisma/client';

describe('Helper', () => {
  describe('Extract number from string', () => {
    it('Get decimal number', () => {
      expect(extractNumberFromString({ value: '999.99' })).toEqual(999.99);
    });

    it('Get decimal number (with spaces)', () => {
      expect(extractNumberFromString({ value: ' 999.99 ' })).toEqual(999.99);
    });

    it('Get decimal number (with currency)', () => {
      expect(extractNumberFromString({ value: '999.99 CHF' })).toEqual(999.99);
    });

    it('Get decimal number (comma notation)', () => {
      expect(
        extractNumberFromString({ locale: 'de-DE', value: '999,99' })
      ).toEqual(999.99);
    });

    it('Get decimal number with group (dot notation)', () => {
      expect(
        extractNumberFromString({ locale: 'de-CH', value: `99'999.99` })
      ).toEqual(99999.99);
    });

    it('Get decimal number with group (comma notation)', () => {
      expect(
        extractNumberFromString({ locale: 'de-DE', value: '99.999,99' })
      ).toEqual(99999.99);
    });

    it('Get decimal number (comma notation) for locale where currency is not grouped by default', () => {
      expect(
        extractNumberFromString({ locale: 'es-ES', value: '999,99' })
      ).toEqual(999.99);
    });

    it('Not a number', () => {
      expect(extractNumberFromString({ value: 'X' })).toEqual(NaN);
    });
  });

  describe('Get number format group', () => {
    let languageGetter: jest.SpyInstance<string, [], any>;

    beforeEach(() => {
      languageGetter = jest.spyOn(window.navigator, 'language', 'get');
    });

    it('Get de-CH number format group', () => {
      expect(getNumberFormatGroup('de-CH')).toEqual(`'`);
    });

    it('Get de-CH number format group when it is default', () => {
      languageGetter.mockReturnValue('de-CH');
      expect(getNumberFormatGroup()).toEqual(`'`);
    });

    it('Get de-DE number format group', () => {
      expect(getNumberFormatGroup('de-DE')).toEqual('.');
    });

    it('Get de-DE number format group when it is default', () => {
      languageGetter.mockReturnValue('de-DE');
      expect(getNumberFormatGroup()).toEqual('.');
    });

    it('Get en-GB number format group', () => {
      expect(getNumberFormatGroup('en-GB')).toEqual(',');
    });

    it('Get en-GB number format group when it is default', () => {
      languageGetter.mockReturnValue('en-GB');
      expect(getNumberFormatGroup()).toEqual(',');
    });

    it('Get en-US number format group', () => {
      expect(getNumberFormatGroup('en-US')).toEqual(',');
    });

    it('Get en-US number format group when it is default', () => {
      languageGetter.mockReturnValue('en-US');
      expect(getNumberFormatGroup()).toEqual(',');
    });

    it('Get es-ES number format group', () => {
      expect(getNumberFormatGroup('es-ES')).toEqual('.');
    });

    it('Get es-ES number format group when it is default', () => {
      languageGetter.mockReturnValue('es-ES');
      expect(getNumberFormatGroup()).toEqual('.');
    });

    it('Get ru-RU number format group', () => {
      expect(getNumberFormatGroup('ru-RU')).toEqual(' ');
    });

    it('Get ru-RU number format group when it is default', () => {
      languageGetter.mockReturnValue('ru-RU');
      expect(getNumberFormatGroup()).toEqual(' ');
    });

    it('Get zh-CN number format group', () => {
      expect(getNumberFormatGroup('zh-CN')).toEqual(',');
    });

    it('Get zh-CN number format group when it is default', () => {
      languageGetter.mockReturnValue('zh-CN');
      expect(getNumberFormatGroup()).toEqual(',');
    });
  });

  describe('Is known data source', () => {
    it('Accept every member of the vocabulary', () => {
      for (const dataSource of Object.values(DataSource)) {
        expect(isKnownDataSource(dataSource)).toBe(true);
      }
    });

    it('Reject a value outside the vocabulary', () => {
      expect(isKnownDataSource('GHOSTFOLIO_')).toBe(false);
      expect(isKnownDataSource('yahoo')).toBe(false);
    });

    it('Reject a value carrying path traversal', () => {
      expect(isKnownDataSource('../../admin/demo-user/sync?')).toBe(false);
      expect(isKnownDataSource('YAHOO/../..')).toBe(false);
    });

    it('Reject an absent or non-string value', () => {
      expect(isKnownDataSource(undefined)).toBe(false);
      expect(isKnownDataSource(null)).toBe(false);
      expect(isKnownDataSource('')).toBe(false);
      expect(isKnownDataSource(1)).toBe(false);
    });
  });

  /**
   * The one place a failure is turned into something safe to write to a log.
   *
   * Everything that reports a failure through this helper - the dashboard layout
   * round-trip among them - inherits whatever it emits, so what it emits is a
   * confidentiality contract rather than a formatting choice. A failed request
   * carries the URL it was made to, the body the server answered with, a message
   * built from both and a stack; an access identifier, a bearer token or a
   * viewer's own data can sit in any of them, and a log is the one place none of
   * those may end up. The contract is therefore exact: **one** argument, a
   * string, made only of a caller-chosen event identifier and, when the failure
   * has one, a numeric status.
   *
   * Asserted on the arguments rather than on the rendered line, because the two
   * differ in exactly the way that matters: `console.error(id, error)` renders
   * the identifier first and would satisfy any assertion that merely looked for
   * it, while still printing the whole failure after it.
   */
  describe('Report sanitized error', () => {
    const eventId = 'GF-TEST-EVENT-FAILED';

    let consoleErrorSpy: jest.SpyInstance;

    beforeEach(() => {
      consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {
        return undefined;
      });
    });

    afterEach(() => {
      consoleErrorSpy.mockRestore();
    });

    it('Report a failure carrying a numeric status as the identifier and that status', () => {
      reportSanitizedError(eventId, {
        message:
          'Http failure response for https://ghostfolio.test/api/v1/user/layout?token=SECRET: 500',
        stack: 'at DashboardLayoutService (dashboard-layout.service.ts:1:1)',
        status: 500,
        url: 'https://ghostfolio.test/api/v1/user/layout?token=SECRET'
      });

      expect(consoleErrorSpy.mock.calls).toEqual([[`${eventId} (status 500)`]]);
    });

    it('Report a failure carrying no status as the bare identifier', () => {
      reportSanitizedError(eventId, new Error('viewer@example.test rejected'));

      expect(consoleErrorSpy.mock.calls).toEqual([[eventId]]);
    });

    it('Report an absent failure as the bare identifier', () => {
      reportSanitizedError(eventId);

      expect(consoleErrorSpy.mock.calls).toEqual([[eventId]]);
    });

    it('Ignore a status that is not a number, rather than rendering it', () => {
      // A non-numeric status is not a status: emitting it would put an
      // attacker-influenced value straight into the log line.
      reportSanitizedError(eventId, { status: '500 SECRET' });

      expect(consoleErrorSpy.mock.calls).toEqual([[eventId]]);
    });

    it('Never emit the failure itself, however it is shaped', () => {
      const secret = 'SECRET-BEARER-TOKEN';

      const failures: unknown[] = [
        {
          error: { detail: secret },
          message: `Http failure response for https://ghostfolio.test/api/v1/user/layout?token=${secret}: 500`,
          stack: `at layout (${secret})`,
          status: 500,
          url: `https://ghostfolio.test/api/v1/user/layout?token=${secret}`
        },
        new Error(secret),
        secret,
        { status: 401, statusText: secret }
      ];

      for (const failure of failures) {
        reportSanitizedError(eventId, failure);
      }

      const logged = consoleErrorSpy.mock.calls.flat();

      // Every argument is a string, so no object can be handed to the console for
      // it to expand - and none of those strings mentions the secret, the URL or
      // the stack.
      expect(logged).toHaveLength(failures.length);
      expect(logged.every((argument) => typeof argument === 'string')).toBe(
        true
      );
      expect(logged).toEqual([
        `${eventId} (status 500)`,
        eventId,
        eventId,
        `${eventId} (status 401)`
      ]);

      for (const argument of logged) {
        expect(argument).not.toContain(secret);
        expect(argument).not.toContain('ghostfolio.test');
        expect(argument).not.toContain('Http failure');
        expect(argument).not.toContain('at layout');
      }
    });
  });
});
