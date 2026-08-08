import { WebAuthService } from '@ghostfolio/api/app/auth/web-auth.service';
import { ConfigurationService } from '@ghostfolio/api/services/configuration/configuration.service';
import { DEFAULT_LANGUAGE_CODE } from '@ghostfolio/common/config';

import { Test, TestingModule } from '@nestjs/testing';
import { Request, Response } from 'express';

import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';

/**
 * The two federated sign-in callbacks, and specifically where they send the
 * browser afterwards.
 *
 * Both land on the locale root and hand the token over as a query parameter,
 * which the root route's guard adopts before it resolves the viewer. There is no
 * dedicated authentication route to receive it.
 *
 * Nothing about that arrangement is expressible in the type system: both targets
 * are template strings, and a drift in either - an internal path appearing, the
 * `jwt` parameter being dropped, the locale segment disappearing - would compile,
 * pass every layout test, and strand a validly authenticated visitor on the
 * signed-out prompt with no error anywhere. The exact strings are therefore
 * asserted here, assembled from the same configured root URL and default locale
 * the controller reads rather than from a literal, so this suite pins the shape
 * of the URL rather than restating one copy of it.
 *
 * Only the callbacks are covered. The rest of this controller - anonymous
 * sign-in, WebAuthn registration and assertion - belongs to whatever suite covers
 * it.
 */
describe('AuthController', () => {
  const rootUrl = 'https://ghostfolio.example';

  let authController: AuthController;
  let redirect: jest.Mock;
  let setHeader: jest.Mock;

  /**
   * The response object as far as these handlers use it: they set headers on the
   * redirect they are about to write and then write it, so recorders for those two
   * methods are the whole collaborator.
   */
  const createResponse = () => {
    redirect = jest.fn();
    setHeader = jest.fn();

    return { redirect, setHeader } as unknown as Response;
  };

  /** The headers the handler set, as a plain object. */
  const headers = (): Record<string, string> => {
    return Object.fromEntries(setHeader.mock.calls as [string, string][]);
  };

  /**
   * The request as passport leaves it. The strategy writes the authenticated
   * principal onto `user`, and these handlers read exactly one member of it.
   */
  const createRequest = (jwt?: string) => {
    return { user: { jwt } } as unknown as Request;
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        { provide: AuthService, useValue: {} },
        {
          provide: ConfigurationService,
          useValue: {
            get: (key: string) => (key === 'ROOT_URL' ? rootUrl : undefined)
          }
        },
        { provide: WebAuthService, useValue: {} }
      ]
    }).compile();

    authController = module.get(AuthController);
  });

  describe.each([
    {
      handler: 'googleLoginCallback' as const,
      provider: 'Google'
    },
    {
      handler: 'oidcLoginCallback' as const,
      provider: 'OpenID Connect'
    }
  ])('the $provider callback', ({ handler }) => {
    it('hands a minted token to the locale root as a query parameter', () => {
      const response = createResponse();

      authController[handler](createRequest('a-signed-token'), response);

      // The trailing slash before the query string is load-bearing: the client is
      // deployed under a per-locale base href, so `/en?jwt=…` would not resolve to
      // the application at all.
      expect(redirect).toHaveBeenCalledTimes(1);
      expect(redirect).toHaveBeenCalledWith(
        `${rootUrl}/${DEFAULT_LANGUAGE_CODE}/?jwt=a-signed-token`
      );
    });

    it('sends a caller without a token to the locale root and nothing else', () => {
      const response = createResponse();

      authController[handler](createRequest(), response);

      // No token means the federated sign-in did not produce one, and the root
      // route will render its signed-out state. Appending an empty `jwt` would make
      // the route guard save an empty token and the interceptor send it.
      expect(redirect).toHaveBeenCalledTimes(1);
      expect(redirect).toHaveBeenCalledWith(
        `${rootUrl}/${DEFAULT_LANGUAGE_CODE}/`
      );
    });

    it('keeps the credential-bearing redirect out of caches and referrers', () => {
      const response = createResponse();

      authController[handler](createRequest('a-signed-token'), response);

      // The token reaches the client as a query parameter of this redirect, so the
      // response carrying it must not be retained or disclosed. Set on the handler
      // rather than centrally because the security-header middleware is only
      // installed when the subscription feature is switched on - an installation
      // without it would otherwise send this redirect with default headers. None of
      // that is observable in the redirect target, which is why it is asserted here.
      expect(headers()).toEqual({
        'Cache-Control': 'no-store',
        Pragma: 'no-cache',
        'Referrer-Policy': 'no-referrer'
      });
    });

    it('protects the redirect before writing it', () => {
      const response = createResponse();
      const order: string[] = [];

      setHeader.mockImplementation(() => order.push('setHeader'));
      redirect.mockImplementation(() => order.push('redirect'));

      authController[handler](createRequest('a-signed-token'), response);

      // Express commits the headers with the response, so a header set afterwards
      // would never leave the process.
      expect(order).toEqual([
        'setHeader',
        'setHeader',
        'setHeader',
        'redirect'
      ]);
    });

    it('addresses no route that the single-canvas shell removed', () => {
      const response = createResponse();

      authController[handler](createRequest('a-signed-token'), response);

      const [target] = redirect.mock.calls[0] as [string];

      // The mechanical form of the rule, kept separate from the exact-string
      // assertions above: the shell serves one route, and it is the root.
      for (const retired of ['/auth', '/home', '/register', '/start', '/zen']) {
        expect(target).not.toContain(retired);
      }
    });
  });
});
