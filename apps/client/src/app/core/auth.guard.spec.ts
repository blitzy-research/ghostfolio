import {
  KEY_STAY_SIGNED_IN,
  SettingsStorageService
} from '@ghostfolio/client/services/settings-storage.service';
import { TokenStorageService } from '@ghostfolio/client/services/token-storage.service';
import { UserService } from '@ghostfolio/client/services/user/user.service';
import { DataService } from '@ghostfolio/ui/services';

import { TestBed } from '@angular/core/testing';
import { ActivatedRouteSnapshot } from '@angular/router';
import { Observable, of, throwError } from 'rxjs';

import { AuthGuard } from './auth.guard';

/**
 * The guard on the one route the application has left.
 *
 * It stopped being a gate - it resolves `true` unconditionally, because every
 * target it used to divert to was deleted with the navigation surface, and because
 * the root host is what decides between the shared portfolio, the signed-out
 * prompt, the empty canvas and a hydrated one. What it kept are three side
 * effects, none of which is a routing concern and each of which fails silently
 * when it breaks:
 *
 * 1. **Adopting a handed-off token, before the viewer is requested.** The API's
 *    Google and OpenID Connect callbacks land on `/<locale>/?jwt=<token>` and the
 *    outgoing request interceptor reads the token from storage. Capturing it any
 *    later lets that first viewer request fire unauthenticated, fail with 401 and
 *    strand a validly authenticated visitor on the signed-out prompt - with no
 *    exception, no console error and nothing for a compiler to notice. The
 *    *ordering* is therefore asserted here, not merely the two calls.
 * 2. **Capturing `utm_source`,** which the bootstrap reads back to filter global
 *    permissions.
 * 3. **Reconciling a stale persisted language with the locale actually served,**
 *    which is a write, a store reset and a reload in that order.
 *
 * Every collaborator is a stub, so nothing here touches storage or the network.
 *
 * **The reload is observed rather than intercepted.** jsdom implements
 * `window.location` and its members as `[LegacyUnforgeable]`, so
 * `Object.defineProperty(window, 'location', …)` throws `Cannot redefine
 * property: location` and `jest.spyOn(window.location, 'reload')` throws `Cannot
 * assign to read only property 'reload'` - measured here, not assumed. What jsdom
 * does emit is a report on its virtual console, which arrives as a
 * `console.error`; {@link reloadAttempts} collects those and everything else is
 * forwarded to the real `console.error`, so a genuine framework error is never
 * swallowed. This is the same instrument the dashboard toolbar's own spec uses for
 * the two navigations it cannot intercept either.
 */
describe('AuthGuard', () => {
  const documentLanguage = 'en';

  /** How jsdom reports an attempt to leave the page. */
  const JSDOM_NAVIGATION_REPORT = 'Not implemented: navigation';

  let dataServiceMock: { putUserSetting: jest.Mock };
  let originalDocumentLanguage: string;
  let putUserSettingResponse: Observable<unknown>;

  /** Every reload jsdom refused to perform, in order. */
  let reloadAttempts: string[];

  let settings: Record<string, string>;
  let settingsStorageServiceMock: {
    getSetting: jest.Mock;
    setSetting: jest.Mock;
  };
  let tokenStorageServiceMock: { getToken: jest.Mock; saveToken: jest.Mock };
  let userServiceMock: { get: jest.Mock; reset: jest.Mock };

  /**
   * Every observable the guard consumes, recorded in the order the guard
   * subscribed to them, so "the token was saved before the viewer was requested"
   * can be asserted as a sequence rather than as two independent facts.
   */
  let callOrder: string[];

  /**
   * A syntactically valid compact JWS: three dot-separated base64url segments.
   *
   * Shaped rather than arbitrary because the guard refuses to write anything else
   * into token storage, and it refuses silently - a placeholder string would make
   * every assertion below pass for the wrong reason, by never reaching the code
   * that saves at all.
   */
  const HANDED_OFF_TOKEN =
    'eyJhbGciOiJIUzI1NiJ9.eyJpZCI6InZpZXdlci0xIn0.c2lnbmF0dXJlLXNlZ21lbnQ';

  /** The route snapshot as the router hands it over: query parameters and nothing else. */
  const createSnapshot = (queryParams?: Record<string, string>) => {
    return { queryParams } as unknown as ActivatedRouteSnapshot;
  };

  const createGuard = ({
    viewer = of(undefined)
  }: { viewer?: Observable<unknown> } = {}) => {
    callOrder = [];
    settings = {};

    dataServiceMock = {
      putUserSetting: jest.fn(() => {
        callOrder.push('putUserSetting');

        return putUserSettingResponse;
      })
    };

    settingsStorageServiceMock = {
      getSetting: jest.fn((key: string) => settings[key]),
      setSetting: jest.fn((key: string, value: string) => {
        settings[key] = value;
      })
    };

    tokenStorageServiceMock = {
      // Signed out, which is the state every hand-off below is offered in. The
      // guard reads this to refuse a token aimed at a viewer who already holds a
      // session, so returning a value here is what exercises the refusal path.
      getToken: jest.fn(() => null as string | null),
      saveToken: jest.fn(() => {
        callOrder.push('saveToken');
      })
    };

    userServiceMock = {
      get: jest.fn(() => {
        callOrder.push('get');

        return viewer;
      }),
      reset: jest.fn(() => {
        callOrder.push('reset');
      })
    };

    TestBed.configureTestingModule({
      providers: [
        AuthGuard,
        { provide: DataService, useValue: dataServiceMock },
        {
          provide: SettingsStorageService,
          useValue: settingsStorageServiceMock
        },
        { provide: TokenStorageService, useValue: tokenStorageServiceMock },
        { provide: UserService, useValue: userServiceMock }
      ]
    });

    return TestBed.inject(AuthGuard);
  };

  beforeEach(() => {
    putUserSettingResponse = of({});
    reloadAttempts = [];

    originalDocumentLanguage = document.documentElement.lang;
    document.documentElement.lang = documentLanguage;

    // Typed on the way in, so the forwarding call at the end of the stub below is
    // checked rather than an `any` invocation.
    const reportError: (...args: unknown[]) => void =
      console.error.bind(console);

    jest.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      const [detail] = args;

      // Recognised by shape rather than with `instanceof`: jsdom raises this
      // from its own realm, so `detail instanceof Error` is false for the very
      // object that arrives.
      const report =
        Object.prototype.toString.call(detail) === '[object Error]'
          ? (detail as Error).message
          : typeof detail === 'string'
            ? detail
            : '';

      if (report.includes(JSDOM_NAVIGATION_REPORT)) {
        callOrder.push('reload');
        reloadAttempts.push(report);

        return;
      }

      reportError(...args);
    });
  });

  afterEach(() => {
    document.documentElement.lang = originalDocumentLanguage;

    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  describe('activation', () => {
    it.each([
      { description: 'no query parameters at all', queryParams: undefined },
      { description: 'an empty query', queryParams: {} },
      {
        description: 'a handed-off token',
        queryParams: { jwt: HANDED_OFF_TOKEN }
      },
      {
        description: 'an acquisition source',
        queryParams: { utm_source: 'ios' }
      }
    ])('activates the route for $description', async ({ queryParams }) => {
      // Unconditional by design: there is no public route left to divert to, and
      // resolving anything but `true` is what would keep the root host from ever
      // reaching its empty-canvas state and auto-opening the catalog.
      await expect(
        createGuard().canActivate(createSnapshot(queryParams))
      ).resolves.toBe(true);
    });

    it('activates the route when the viewer cannot be resolved', async () => {
      const guard = createGuard({
        viewer: throwError(() => new Error('unauthorized'))
      });

      // A failed lookup simply means nobody is signed in. The host renders its
      // signed-out state; the route is still activated.
      await expect(guard.canActivate(createSnapshot({}))).resolves.toBe(true);
    });

    it('requests the viewer exactly once', async () => {
      const guard = createGuard();

      await guard.canActivate(createSnapshot({}));

      expect(userServiceMock.get).toHaveBeenCalledTimes(1);
      expect(userServiceMock.get).toHaveBeenCalledWith();
    });
  });

  describe('the handed-off token', () => {
    it('saves the token before the viewer is requested', async () => {
      const guard = createGuard();

      await guard.canActivate(createSnapshot({ jwt: HANDED_OFF_TOKEN }));

      // The ordering is the whole point of this test; see this suite's
      // documentation for the failure it prevents.
      expect(callOrder).toEqual(['saveToken', 'get']);
    });

    it('honours a stored preference to stay signed in', async () => {
      const guard = createGuard();

      settings[KEY_STAY_SIGNED_IN] = 'true';

      await guard.canActivate(createSnapshot({ jwt: HANDED_OFF_TOKEN }));

      expect(tokenStorageServiceMock.saveToken).toHaveBeenCalledWith(
        HANDED_OFF_TOKEN,
        true
      );
    });

    it.each([
      { description: 'the preference is switched off', stored: 'false' },
      { description: 'the preference was never set', stored: undefined },
      {
        description: 'the preference holds anything other than the exact flag',
        stored: 'TRUE'
      }
    ])('keeps the session temporary when $description', async ({ stored }) => {
      const guard = createGuard();

      if (stored !== undefined) {
        settings[KEY_STAY_SIGNED_IN] = stored;
      }

      await guard.canActivate(createSnapshot({ jwt: HANDED_OFF_TOKEN }));

      // Compared against the exact string rather than coerced, so a stored value
      // that merely looks affirmative does not silently extend a session.
      expect(tokenStorageServiceMock.saveToken).toHaveBeenCalledWith(
        HANDED_OFF_TOKEN,
        false
      );
    });

    it('saves nothing when no token was handed over', async () => {
      const guard = createGuard();

      await guard.canActivate(createSnapshot({ utm_source: 'ios' }));

      expect(tokenStorageServiceMock.saveToken).not.toHaveBeenCalled();
    });

    it('refuses a token aimed at a viewer who already holds a session', async () => {
      const guard = createGuard();

      tokenStorageServiceMock.getToken.mockReturnValue('an-existing-token');

      await expect(
        guard.canActivate(createSnapshot({ jwt: HANDED_OFF_TOKEN }))
      ).resolves.toBe(true);

      // `/?jwt=<attacker-token>` sent to somebody who is signed in would
      // otherwise swap their session for the sender's, and everything they
      // entered afterwards would be readable by whoever issued the link.
      expect(tokenStorageServiceMock.saveToken).not.toHaveBeenCalled();
    });

    it.each([
      { description: 'is not a token at all', jwt: 'not-a-token' },
      { description: 'carries too few segments', jwt: 'header.payload' },
      { description: 'carries too many segments', jwt: 'a.b.c.d' },
      { description: 'holds an empty segment', jwt: 'header..signature' },
      {
        description: 'holds characters outside base64url',
        jwt: 'header.pay load.signature'
      },
      { description: 'is empty', jwt: '' }
    ])('refuses a parameter that $description', async ({ jwt }) => {
      const guard = createGuard();

      await expect(guard.canActivate(createSnapshot({ jwt }))).resolves.toBe(
        true
      );

      // A query parameter is whatever somebody typed. Without the shape check any
      // string at all would be stored and then attached to every later request as
      // a bearer token.
      expect(tokenStorageServiceMock.saveToken).not.toHaveBeenCalled();
    });

    it('does not clear the parameter from the address bar', async () => {
      const guard = createGuard();

      // Deliberately left to the root host: navigating from inside `canActivate`
      // risks cancelling the very navigation being guarded, which is why no
      // `Router` is injected here at all. Its absence from the constructor is
      // asserted by this module compiling without one being provided.
      await expect(
        guard.canActivate(createSnapshot({ jwt: HANDED_OFF_TOKEN }))
      ).resolves.toBe(true);
    });
  });

  describe('the acquisition source', () => {
    it('records the source it was addressed with', async () => {
      const guard = createGuard();

      await guard.canActivate(createSnapshot({ utm_source: 'ios' }));

      // Read back by the bootstrap to filter global permissions, so the key is
      // part of the contract rather than incidental.
      expect(settingsStorageServiceMock.setSetting).toHaveBeenCalledWith(
        'utm_source',
        'ios'
      );
    });

    it('records nothing when no source was given', async () => {
      const guard = createGuard();

      await guard.canActivate(createSnapshot({ jwt: HANDED_OFF_TOKEN }));

      expect(settingsStorageServiceMock.setSetting).not.toHaveBeenCalled();
    });

    it('records the source alongside a handed-off token', async () => {
      const guard = createGuard();

      await guard.canActivate(
        createSnapshot({ jwt: HANDED_OFF_TOKEN, utm_source: 'ios' })
      );

      expect(tokenStorageServiceMock.saveToken).toHaveBeenCalledTimes(1);
      expect(settingsStorageServiceMock.setSetting).toHaveBeenCalledWith(
        'utm_source',
        'ios'
      );
    });
  });

  describe('reconciling a stale persisted language', () => {
    /** A viewer whose persisted language is not the one being served. */
    const mismatchedViewer = of({ settings: { language: 'de' } });

    it('writes the served locale, resets the store and reloads, in that order', async () => {
      jest.useFakeTimers();

      const guard = createGuard({ viewer: mismatchedViewer });

      await guard.canActivate(createSnapshot({}));

      // The order is the contract: the write has to land before the store is
      // dropped, and the store has to be dropped before the reload, or the
      // reloaded application reads the value it just replaced.
      expect(callOrder).toEqual(['get', 'putUserSetting', 'reset']);
      expect(dataServiceMock.putUserSetting).toHaveBeenCalledWith({
        language: documentLanguage
      });

      // Deferred rather than immediate, so the write has settled before the
      // document is thrown away.
      expect(reloadAttempts).toHaveLength(0);

      jest.advanceTimersByTime(299);

      expect(reloadAttempts).toHaveLength(0);

      jest.advanceTimersByTime(1);

      expect(reloadAttempts).toHaveLength(1);
      expect(callOrder).toEqual(['get', 'putUserSetting', 'reset', 'reload']);
    });

    it('activates the route without waiting for the reload', async () => {
      jest.useFakeTimers();

      const guard = createGuard({ viewer: mismatchedViewer });

      // Resolving early is what keeps the navigation from hanging for the length
      // of the round trip on a mismatch.
      await expect(guard.canActivate(createSnapshot({}))).resolves.toBe(true);
    });

    it.each([
      {
        description: 'the persisted language matches the served locale',
        viewer: of({ settings: { language: documentLanguage } })
      },
      {
        description: 'the viewer has no persisted language',
        viewer: of({ settings: {} })
      },
      {
        description: 'the viewer has no settings at all',
        viewer: of({})
      },
      {
        description: 'there is no viewer',
        viewer: of(undefined)
      }
    ])('leaves everything alone when $description', async ({ viewer }) => {
      const guard = createGuard({ viewer });

      await expect(guard.canActivate(createSnapshot({}))).resolves.toBe(true);

      expect(dataServiceMock.putUserSetting).not.toHaveBeenCalled();
      expect(userServiceMock.reset).not.toHaveBeenCalled();
      expect(reloadAttempts).toHaveLength(0);
    });

    it('resets nothing while the write is still in flight', async () => {
      jest.useFakeTimers();

      // Never settles, which is what an in-flight request looks like.
      putUserSettingResponse = new Observable(() => undefined);

      const guard = createGuard({ viewer: mismatchedViewer });

      await guard.canActivate(createSnapshot({}));

      jest.advanceTimersByTime(1000);

      // Dropping the store or reloading before the write has landed would lose the
      // reconciliation and leave the mismatch in place for the next visit too.
      expect(dataServiceMock.putUserSetting).toHaveBeenCalledTimes(1);
      expect(userServiceMock.reset).not.toHaveBeenCalled();
      expect(reloadAttempts).toHaveLength(0);
    });
  });
});
