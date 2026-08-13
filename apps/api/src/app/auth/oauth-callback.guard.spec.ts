import { ConfigurationService } from '@ghostfolio/api/services/configuration/configuration.service';

import { ExecutionContext, HttpException, Logger } from '@nestjs/common';
import { StatusCodes } from 'http-status-codes';

import {
  GoogleCallbackGuard,
  OidcCallbackGuard,
  OidcLoginGuard
} from './oauth-callback.guard';

/**
 * A configuration service that answers only the question these guards ask.
 *
 * Deliberately not the real one: `ConfigurationService` validates the whole
 * environment in its constructor and aborts the process when
 * `ACCESS_TOKEN_SALT` or `JWT_SECRET_KEY` is absent, which has nothing to do
 * with what is under test here. The shape follows the convention the sibling
 * controller spec already established for this dependency.
 */
function createConfigurationService(isOidcEnabled: boolean) {
  return {
    get: (key: string) =>
      key === 'ENABLE_FEATURE_AUTH_OIDC' ? isOidcEnabled : undefined
  } as unknown as ConfigurationService;
}

/**
 * The minimum of an execution context these guards touch: the request object
 * they write the (absent) identity onto.
 *
 * The request is handed back so a test can assert what the guard left on it,
 * which is the whole mechanism by which "no identity" reaches the handler.
 */
function createExecutionContext(request: Record<string, unknown>) {
  return {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => ({})
    })
  } as unknown as ExecutionContext;
}

/**
 * Stands in for the passport activation these guards inherit.
 *
 * Spied on the *parent* prototype rather than replaced, so the assertion is
 * whether the guard delegated at all - which is the only thing the tests below
 * care about, and the thing that distinguishes "the provider was consulted"
 * from "the provider was never registered so it must not be".
 */
function spyOnPassportActivation(Guard: { prototype: object }) {
  return jest
    .spyOn(
      Object.getPrototypeOf(Guard.prototype) as {
        canActivate: (context: ExecutionContext) => Promise<boolean>;
      },
      'canActivate'
    )
    .mockResolvedValue(true);
}

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
    /**
     * Every case in this block is about what happens *after* the provider was
     * consulted, so the provider is enabled throughout. Whether it may be
     * consulted at all is the subject of the two blocks that follow.
     */
    const createGuard = () => new Guard(createConfigurationService(true));

    it('hands over the authenticated principal untouched', () => {
      const user = { jwt: 'a-signed-token' };

      // The success path is the one thing this must not change: whatever passport
      // produced is what the handler reads.
      expect(createGuard().handleRequest(null, user)).toBe(user);
    });

    it('reports no identity instead of throwing when the provider declined', () => {
      const guard = createGuard();

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
      expect(createGuard().handleRequest(null, false)).toBeNull();
    });

    it('records the failure under a fixed identifier naming the provider', () => {
      createGuard().handleRequest(new Error('invalid_grant'), undefined);

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
      createGuard().handleRequest(
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
      createGuard().handleRequest(null, { jwt: 'a-signed-token' });

      expect(loggerWarn).not.toHaveBeenCalled();
    });

    it('consults the provider when this deployment offers it', async () => {
      const passportActivation = spyOnPassportActivation(Guard);
      const request: Record<string, unknown> = {};

      // `await` rather than `.resolves`, because activation is only a promise
      // when it reaches passport - the short-circuit below answers synchronously.
      expect(
        await createGuard().canActivate(createExecutionContext(request))
      ).toBe(true);

      // Delegation, not interception: with the provider available the guard adds
      // nothing to the activation and leaves the identity to passport.
      expect(passportActivation).toHaveBeenCalledTimes(1);
      expect(request).not.toHaveProperty('user');
      expect(loggerWarn).not.toHaveBeenCalled();
    });
  });

  /**
   * A callback for a provider this deployment never registered.
   *
   * `handleRequest` cannot reach this case: passport raises `Unknown
   * authentication strategy` from inside `authenticate`, before any callback of
   * ours runs, so the visitor received a sanitized 500 at an `/api/auth/...`
   * address for a deployment that had simply not switched the provider on. The
   * flag is therefore asked first, and a disabled provider is expressed exactly
   * the way a refusing one is - no identity - so both failure modes converge on
   * the one recovery the handlers already implement.
   */
  describe('the oidc callback guard when the provider is not enabled', () => {
    it('proceeds with no identity rather than consulting a strategy that was never registered', async () => {
      const passportActivation = spyOnPassportActivation(OidcCallbackGuard);
      const guard = new OidcCallbackGuard(createConfigurationService(false));
      const request: Record<string, unknown> = {};

      expect(await guard.canActivate(createExecutionContext(request))).toBe(
        true
      );

      // Activation proceeds, so the handler is entered and can redirect; and
      // passport is not consulted, so the error that stranded the browser cannot
      // be raised.
      expect(request.user).toBeNull();
      expect(passportActivation).not.toHaveBeenCalled();
    });

    it('records the outcome under the same fixed identifier, naming the provider', async () => {
      spyOnPassportActivation(OidcCallbackGuard);

      await new OidcCallbackGuard(
        createConfigurationService(false)
      ).canActivate(createExecutionContext({}));

      expect(loggerWarn).toHaveBeenCalledTimes(1);
      expect(loggerWarn).toHaveBeenCalledWith(
        'GF-OAUTH-CALLBACK-FAILED (provider oidc is not enabled)',
        'OAuthCallbackGuard'
      );
    });
  });

  /**
   * Google's strategy is registered unconditionally, so its callback is always
   * able to consult passport. Asserted because the flag the OIDC guard reads is
   * OIDC's alone, and a guard that short-circuited on it would silently disable
   * a working provider.
   */
  describe('the google callback guard when oidc is not enabled', () => {
    it('still consults the provider', async () => {
      const passportActivation = spyOnPassportActivation(GoogleCallbackGuard);
      const request: Record<string, unknown> = {};

      expect(
        await new GoogleCallbackGuard(
          createConfigurationService(false)
        ).canActivate(createExecutionContext(request))
      ).toBe(true);

      expect(passportActivation).toHaveBeenCalledTimes(1);
      expect(request).not.toHaveProperty('user');
      expect(loggerWarn).not.toHaveBeenCalled();
    });
  });
});

/**
 * The route that STARTS the OIDC flow, as opposed to the one that receives its
 * callback.
 *
 * The same unregistered strategy produced the same 500 here, and the handler's
 * own flag check never ran because a guard decides before a handler is entered.
 * The answer is deliberately different from the callback's: the visitor has not
 * left for a provider yet, so there is nothing mid-flight and nothing to return
 * them to, and an honest refusal is the right answer rather than a redirect.
 */
describe('OidcLoginGuard', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('refuses with 403 when this deployment does not offer oidc', () => {
    const guard = new OidcLoginGuard(createConfigurationService(false));

    let thrown: HttpException;

    try {
      guard.canActivate(createExecutionContext({}));
    } catch (error) {
      thrown = error as HttpException;
    }

    expect(thrown).toBeInstanceOf(HttpException);
    expect(thrown.getStatus()).toBe(StatusCodes.FORBIDDEN);

    // Not a 500, and not the framework's `Unknown authentication strategy`: a
    // stated refusal, whose message names nothing about the deployment.
    expect(thrown.getResponse()).toBe('Forbidden');
  });

  it('does not consult a strategy that was never registered', () => {
    const passportActivation = spyOnPassportActivation(OidcLoginGuard);

    expect(() =>
      new OidcLoginGuard(createConfigurationService(false)).canActivate(
        createExecutionContext({})
      )
    ).toThrow(HttpException);

    expect(passportActivation).not.toHaveBeenCalled();
  });

  it('starts the flow when this deployment offers oidc', async () => {
    const passportActivation = spyOnPassportActivation(OidcLoginGuard);

    expect(
      await new OidcLoginGuard(createConfigurationService(true)).canActivate(
        createExecutionContext({})
      )
    ).toBe(true);

    expect(passportActivation).toHaveBeenCalledTimes(1);
  });
});
