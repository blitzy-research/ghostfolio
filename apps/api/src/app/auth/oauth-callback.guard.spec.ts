import { Logger } from '@nestjs/common';

import { GoogleCallbackGuard, OidcCallbackGuard } from './oauth-callback.guard';

/**
 * What a browser-facing federated callback does when the provider does not hand
 * back an identity.
 *
 * The default is to rethrow whatever the strategy reported, which answered the
 * visitor's browser with `{"statusCode":500,"message":"Internal server error"}` at
 * an `/api/auth/...` address and printed a framework stack trace beside it - for an
 * event that is not a fault in this application at all. A provider declining, or
 * returning an identity token without a subject, is an ordinary outcome of asking
 * somebody else to vouch for a visitor.
 *
 * Two things are asserted, and neither is expressible in a signature. That the
 * failure is expressed as *no identity* rather than as an exception, because that
 * is the state the callback handlers already have a branch for - so the redirect
 * is not restated in a second place and cannot drift from it. And that what reaches
 * the log is a fixed identifier and a provider name, with nothing the provider said
 * and nothing about the visitor: the whole reason this is a warning rather than a
 * rethrow is that the rethrow shipped a stack trace.
 *
 * The strategy's own error line, which carries the diagnostic detail, is
 * deliberately out of scope here - it is logged by the strategy and is unchanged.
 */
describe('OAuthCallbackGuard', () => {
  let loggerWarn: jest.SpyInstance;

  beforeEach(() => {
    loggerWarn = jest.spyOn(Logger, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe.each([
    { Guard: OidcCallbackGuard, provider: 'oidc' },
    { Guard: GoogleCallbackGuard, provider: 'google' }
  ])('the $provider callback guard', ({ Guard, provider }) => {
    it('hands over the authenticated principal untouched', () => {
      const user = { jwt: 'a-signed-token' };

      // The success path is the one thing this must not change: whatever passport
      // produced is what the handler reads.
      expect(new Guard().handleRequest(null, user)).toBe(user);
    });

    it('reports no identity instead of throwing when the provider declined', () => {
      const guard = new Guard();

      expect(() => {
        guard.handleRequest(new Error('invalid_grant'), undefined);
      }).not.toThrow();

      expect(
        guard.handleRequest(new Error('invalid_grant'), undefined)
      ).toBeNull();
    });

    it('reports no identity when the answer arrived but carried no principal', () => {
      // Passport's other failure shape: no error, no user - what a strategy
      // reports through `fail()`, for instance when the state could not be
      // verified.
      expect(new Guard().handleRequest(null, false)).toBeNull();
    });

    it('records the failure under a fixed identifier naming the provider', () => {
      new Guard().handleRequest(new Error('invalid_grant'), undefined);

      expect(loggerWarn).toHaveBeenCalledTimes(1);
      expect(loggerWarn).toHaveBeenCalledWith(
        `GF-OAUTH-CALLBACK-FAILED (provider ${provider})`,
        'OAuthCallbackGuard'
      );
    });

    it('says nothing the provider said', () => {
      // The point of the change: the rethrow it replaces put the provider's own
      // message and this application's stack in front of whoever reads the log,
      // and in front of the visitor. The provider's error is taken and dropped.
      new Guard().handleRequest(
        new Error('invalid_grant: client qa-client-id at https://idp.example'),
        undefined
      );

      const logged = JSON.stringify(loggerWarn.mock.calls);

      for (const disclosure of [
        'invalid_grant',
        'qa-client-id',
        'idp.example',
        'Error'
      ]) {
        expect(logged).not.toContain(disclosure);
      }
    });

    it('says nothing when the principal is present', () => {
      new Guard().handleRequest(null, { jwt: 'a-signed-token' });

      expect(loggerWarn).not.toHaveBeenCalled();
    });
  });
});
