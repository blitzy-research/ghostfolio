import { TokenStorageService } from '@ghostfolio/client/services/token-storage.service';
import { UserService } from '@ghostfolio/client/services/user/user.service';
import { InfoItem } from '@ghostfolio/common/interfaces';
import { DataService } from '@ghostfolio/ui/services';

import {
  HttpClient,
  HttpErrorResponse,
  HttpHandler,
  HttpRequest,
  provideHttpClient,
  withInterceptorsFromDi
} from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { MatSnackBar } from '@angular/material/snack-bar';
import { StatusCodes } from 'http-status-codes';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Subject, throwError } from 'rxjs';

import {
  HttpResponseInterceptor,
  httpResponseInterceptorProviders
} from './http-response.interceptor';

/**
 * How the application answers a failed request, on every request it makes.
 *
 * This is the one handler in the client that sees every response, and the canvas
 * refactor changed what it does with two of them. The 401 branch used to send a
 * viewer to the WebAuthn screen when their session had expired and that screen
 * existed; with a single root route there is nowhere to send them, so it now
 * discards the session unconditionally and lets the root host render the signed-out
 * prompt. The 403 branch's snackbar action used to route to the in-application
 * pricing page, which no longer exists, so it leaves for the externally hosted one.
 *
 * Both changes are the kind that fail silently. A 401 that no longer signs out
 * leaves a viewer looking at a hydrated canvas whose every request is refused; a
 * 401 that signs out when it should not - the data-provider status probe answers
 * 401 for a deployment without a Ghostfolio Premium key, and that has nothing to do
 * with the viewer's own session - throws them out of a working session. Nothing
 * verified either direction, so both are asserted here, and the exemption is
 * asserted by driving the real probe URL rather than by inspecting a condition.
 *
 * The interceptor is exercised through the real `HttpClient` pipeline, registered
 * through the very provider array the bootstrap uses, so what these tests measure
 * includes the registration itself - a `multi` provider omitted from that array
 * would be invisible to a spec that constructed the class directly.
 *
 * **Where the 403 action leaves to is read from the source, not observed.** jsdom
 * implements `window.location` and its members as `[LegacyUnforgeable]`: it can be
 * neither redefined nor spied, and the report jsdom emits for a refused navigation
 * carries no URL. That the departure happens is observed through that report; the
 * destination is asserted against the source text, which is the same division this
 * repository's account-settings suite makes for the same reason.
 */
describe('HttpResponseInterceptor', () => {
  /** How jsdom reports an attempt to leave the page. */
  const JSDOM_NAVIGATION_REPORT = 'Not implemented: navigation';

  /** The endpoint whose 401 is about the deployment rather than about the viewer. */
  const PROVIDER_STATUS_URL = '/api/v1/admin/data-providers/ghostfolio/status';

  const REQUEST_URL = '/api/v1/portfolio/details';

  /** The interceptor as text, resolved from this spec's own location. */
  const interceptorSource = readFileSync(
    join(__dirname, 'http-response.interceptor.ts'),
    'utf8'
  );

  let httpClient: HttpClient;
  let httpTestingController: HttpTestingController;

  let info: InfoItem;
  let signOut: jest.Mock;

  /** Every snackbar the interceptor opened, in order. */
  let snackBarRequests: { action?: string; message: string }[];
  /** The action subject of the most recent snackbar, so it can be pressed. */
  let snackBarAction: Subject<void>;
  /** The dismissal subject of the most recent snackbar. */
  let snackBarDismissal: Subject<void>;

  let consoleErrorSpy: jest.SpyInstance;
  /** Every departure jsdom refused to perform. */
  let navigationAttempts: number;
  /** Every other report that reached `console.error`. */
  let errorReports: string[];

  const createInfo = (overrides: Partial<InfoItem> = {}): InfoItem => {
    return { globalPermissions: [], ...overrides } as InfoItem;
  };

  /**
   * Issues a request and fails it with the given status.
   *
   * The subscription's error callback is supplied on purpose: the interceptor
   * re-throws, so an unhandled rejection would otherwise be reported for every
   * test here even though the re-throw is exactly the behaviour being relied on -
   * a caller has to be able to react to its own failure as well.
   */
  const failRequest = ({
    status,
    url = REQUEST_URL
  }: {
    status: number;
    url?: string;
  }) => {
    const errors: HttpErrorResponse[] = [];

    httpClient.get(url).subscribe({
      error: (error: HttpErrorResponse) => {
        errors.push(error);
      }
    });

    httpTestingController
      .expectOne(url)
      .flush(
        { message: 'refused' },
        { status, statusText: StatusCodes[status] ?? 'Error' }
      );

    return errors;
  };

  /**
   * Installs the pipeline under test.
   *
   * Extracted rather than inlined because one test has to rebuild it: the
   * deployment's capabilities are read once, during construction, which is what
   * makes them settled for the life of a session - so a test about a read-only
   * deployment cannot change them after the fact.
   */
  const configureTestingModule = () => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptorsFromDi()),
        provideHttpClientTesting(),
        ...httpResponseInterceptorProviders,
        {
          provide: DataService,
          // Read once, in the constructor, so the stub answers the same object the
          // real facade would and nothing else is offered: this handler asks the
          // deployment one question and must not be able to ask a second.
          useValue: { fetchInfo: () => info }
        },
        {
          provide: MatSnackBar,
          useValue: {
            open: (message: string, action?: string) => {
              snackBarRequests.push({ action, message });

              snackBarAction = new Subject<void>();
              snackBarDismissal = new Subject<void>();

              return {
                afterDismissed: () => snackBarDismissal.asObservable(),
                onAction: () => snackBarAction.asObservable()
              };
            }
          }
        },
        { provide: UserService, useValue: { signOut } }
      ]
    });

    httpClient = TestBed.inject(HttpClient);
    httpTestingController = TestBed.inject(HttpTestingController);
  };

  beforeEach(() => {
    errorReports = [];
    info = createInfo();
    navigationAttempts = 0;
    signOut = jest.fn();
    snackBarRequests = [];

    consoleErrorSpy = jest
      .spyOn(console, 'error')
      .mockImplementation((...args: unknown[]) => {
        const report = args
          .map((detail) => {
            return Object.prototype.toString.call(detail) === '[object Error]'
              ? `${(detail as Error).name}: ${(detail as Error).message}`
              : typeof detail === 'string'
                ? detail
                : `[${typeof detail}]`;
          })
          .join(' ');

        if (report.includes(JSDOM_NAVIGATION_REPORT)) {
          navigationAttempts += 1;

          return;
        }

        errorReports.push(report);
      });

    configureTestingModule();
  });

  afterEach(() => {
    const unexpectedReports = [...errorReports];

    consoleErrorSpy.mockRestore();

    httpTestingController.verify();

    expect(unexpectedReports).toEqual([]);
  });

  it('is registered as an interceptor rather than merely exported', () => {
    // The registration is the whole point of the provider array, and a handler that
    // is not registered is indistinguishable from one that does nothing.
    failRequest({ status: StatusCodes.TOO_MANY_REQUESTS });

    expect(snackBarRequests).toHaveLength(1);
  });

  it('lets a successful response through untouched', () => {
    const bodies: unknown[] = [];

    httpClient.get(REQUEST_URL).subscribe((body) => {
      bodies.push(body);
    });

    httpTestingController.expectOne(REQUEST_URL).flush({ value: 42 });

    expect(bodies).toEqual([{ value: 42 }]);
    expect(snackBarRequests).toEqual([]);
    expect(signOut).not.toHaveBeenCalled();
  });

  it('re-throws so the caller can react to its own failure', () => {
    const errors = failRequest({ status: StatusCodes.TOO_MANY_REQUESTS });

    // Reporting to the viewer does not absolve the handler of reporting to the
    // caller: a component that has to clear its own pending state depends on this.
    expect(errors).toHaveLength(1);
    expect(errors[0].status).toBe(StatusCodes.TOO_MANY_REQUESTS);
  });

  describe('an unauthorized response', () => {
    it('discards the session, with no route to divert to', () => {
      failRequest({ status: StatusCodes.UNAUTHORIZED });

      // Unconditional now. The screen this used to divert to no longer exists, and
      // a session whose every request is refused has to end rather than leave the
      // viewer looking at an arrangement that cannot load.
      expect(signOut).toHaveBeenCalledTimes(1);
      expect(snackBarRequests).toEqual([]);
    });

    it('keeps the session when the deployment probe is the thing refused', () => {
      failRequest({
        status: StatusCodes.UNAUTHORIZED,
        url: PROVIDER_STATUS_URL
      });

      // This endpoint answers 401 for a deployment holding no Ghostfolio Premium
      // key, which says nothing about the viewer's own credentials. Signing them
      // out for it would end a perfectly good session.
      expect(signOut).not.toHaveBeenCalled();
      expect(snackBarRequests).toEqual([]);
    });

    it('does not divert to a screen the refactor removed', () => {
      // Asserted from the source, because an absent navigation cannot be observed:
      // the handler injects no router at all, so there is nothing to record.
      expect(interceptorSource).not.toContain('webauthn');
      expect(interceptorSource).not.toContain('router.navigate');
    });
  });

  describe('a forbidden response', () => {
    it('tells the viewer the action is not allowed', () => {
      failRequest({ status: StatusCodes.FORBIDDEN });

      expect(snackBarRequests).toHaveLength(1);
      expect(snackBarRequests[0].message).toContain('not allowed');
      expect(signOut).not.toHaveBeenCalled();
    });

    it('says the feature is unavailable instead while the deployment is read-only', () => {
      info = createInfo({ isReadOnlyMode: true });

      // Rebuilt rather than reconfigured, because the deployment's capabilities are
      // read once during construction - which is what makes them settled for the
      // life of the session.
      TestBed.resetTestingModule();

      configureTestingModule();

      failRequest({ status: StatusCodes.FORBIDDEN });

      // A read-only deployment refuses everything that writes, so naming the
      // viewer's action would blame them for a decision the operator made.
      expect(snackBarRequests).toHaveLength(1);
      expect(snackBarRequests[0].message).toContain('currently unavailable');
    });

    it('reports only once until the message is dismissed', () => {
      failRequest({ status: StatusCodes.FORBIDDEN });
      failRequest({ status: StatusCodes.FORBIDDEN });

      // A screen holding several modules can refuse several requests at once, and
      // one message per refusal would bury the application.
      expect(snackBarRequests).toHaveLength(1);

      snackBarDismissal.next();

      failRequest({ status: StatusCodes.FORBIDDEN });

      expect(snackBarRequests).toHaveLength(2);
    });

    it('leaves for the externally hosted plan page when the message is acted on', () => {
      failRequest({ status: StatusCodes.FORBIDDEN });

      snackBarAction.next();

      // *That* it departs is observed through jsdom's refusal; *where* it departs
      // to cannot be, so the destination is read from the source. Both halves
      // matter: an in-application address would resolve to nothing now.
      expect(navigationAttempts).toBe(1);
      expect(interceptorSource).toContain(
        'window.location.href = `https://ghostfol.io/${document.documentElement.lang}/${publicRoutes.pricing.path}`'
      );
    });
  });

  describe('a server error', () => {
    it('tells the viewer to try again, and offers to reload', () => {
      failRequest({ status: StatusCodes.INTERNAL_SERVER_ERROR });

      expect(snackBarRequests).toHaveLength(1);
      expect(snackBarRequests[0].message).toContain('went wrong');
      expect(snackBarRequests[0].action).toBeDefined();
      expect(signOut).not.toHaveBeenCalled();
    });

    it('reloads when that offer is accepted', () => {
      failRequest({ status: StatusCodes.INTERNAL_SERVER_ERROR });

      snackBarAction.next();

      // The reload is the recovery this branch offers, and jsdom refusing to
      // perform it is the only signal available that it was attempted.
      expect(navigationAttempts).toBe(1);
    });
  });

  describe('a rate-limited response', () => {
    it('asks the viewer to slow down, with no action to take', () => {
      failRequest({ status: StatusCodes.TOO_MANY_REQUESTS });

      // No action and no automatic retry: the only useful response to a rate limit
      // is to stop asking, so the message carries nothing to press.
      expect(snackBarRequests).toHaveLength(1);
      expect(snackBarRequests[0].message).toContain('too many requests');
      expect(snackBarRequests[0].action).toBeUndefined();
      expect(signOut).not.toHaveBeenCalled();
    });
  });

  it('says nothing about a status it does not handle', () => {
    const errors = failRequest({ status: StatusCodes.NOT_FOUND });

    // A 404 is the caller's business - a layout that has never been saved answers
    // one - so a global message here would be noise on an ordinary first visit.
    expect(snackBarRequests).toEqual([]);
    expect(signOut).not.toHaveBeenCalled();
    expect(errors).toHaveLength(1);
  });
});

/**
 * What the viewer is told when a request fails, and in particular when the failure
 * is the end of their session.
 *
 * The unauthorized branch is the one that changed and the one worth pinning. It
 * signs the viewer out, and on a single canvas that replaces the entire screen -
 * every module, the control bar and the arrangement itself - with the sign-in card,
 * without a reload and without the address changing. Said nothing, the result is
 * byte-identical to a first visit: a viewer who had just moved a module watched it
 * revert for no stated reason, and the only trace was a console line. Every sibling
 * branch in this interceptor already raises a notice; this one did not.
 *
 * The assertions below are therefore about four things the type system cannot
 * express: that a message is raised at all, that one ended session raises exactly
 * one message however many requests failed with it, that the one 401 which is *not*
 * about the session still neither notifies nor signs anybody out, and that a
 * visitor who never held a credential is told nothing.
 *
 * That last one is not hypothetical. The root route asks for the viewer
 * unconditionally, so a first visit issues its own `GET /api/v1/user` and is
 * answered 401 before anybody has signed in; without the storage test, the first
 * thing a brand-new visitor saw was the claim that a session they never had had
 * expired.
 */
describe('HttpResponseInterceptor, telling the viewer a session ended', () => {
  const layoutUrl = 'http://localhost/api/v1/user/layout';

  /** The one 401 that is a data-provider verdict rather than a session verdict. */
  const providerStatusUrl =
    'http://localhost/api/v1/data-providers/ghostfolio/status';

  let afterDismissed: Subject<void>;
  let interceptor: HttpResponseInterceptor;
  let open: jest.Mock;
  let signOut: jest.Mock;

  /**
   * What storage holds when the failure arrives. A string stands for a session in
   * hand; `null` stands for a visitor who never had one.
   */
  let token: string;

  /** Every message `MatSnackBar.open` was asked to show, in order. */
  let messages: string[];

  const failWith = ({ status, url }: { status: number; url: string }) => {
    const next = {
      handle: () =>
        throwError(
          () =>
            new HttpErrorResponse({
              status,
              statusText: 'error',
              url
            })
        )
    } as unknown as HttpHandler;

    let caught: unknown;

    interceptor
      .intercept({} as HttpRequest<unknown>, next)
      .subscribe({ error: (error: unknown) => (caught = error) });

    return caught;
  };

  beforeEach(() => {
    afterDismissed = new Subject<void>();
    messages = [];

    open = jest.fn((message: string) => {
      messages.push(message);

      return {
        afterDismissed: () => afterDismissed.asObservable(),
        onAction: () => new Subject<void>().asObservable()
      };
    });

    signOut = jest.fn();
    token = 'a-session-in-hand';

    TestBed.configureTestingModule({
      providers: [
        HttpResponseInterceptor,
        // Read in the constructor to decide whether the deployment is read-only,
        // which only the forbidden branch consults.
        { provide: DataService, useValue: { fetchInfo: () => ({}) } },
        { provide: MatSnackBar, useValue: { open } },
        // Read through a getter rather than captured once, so a test can change
        // what storage holds between failures.
        {
          provide: TokenStorageService,
          useValue: {
            getToken: () => token
          }
        },
        { provide: UserService, useValue: { signOut } }
      ]
    });

    interceptor = TestBed.inject(HttpResponseInterceptor);
  });

  describe('an unauthorized response', () => {
    it('tells the viewer their session ended', () => {
      failWith({ status: StatusCodes.UNAUTHORIZED, url: layoutUrl });

      expect(messages).toEqual([
        'Your session has expired. Please sign in again.'
      ]);
    });

    it('still signs the viewer out', () => {
      failWith({ status: StatusCodes.UNAUTHORIZED, url: layoutUrl });

      // The notice is additive. Nothing about the existing behaviour may change:
      // a credential that no longer works must not be left in storage.
      expect(signOut).toHaveBeenCalledTimes(1);
    });

    it('raises one message however many requests failed together', () => {
      // What actually happens when a session ends mid-session: the arrangement and
      // every mounted module's own read fail within milliseconds of each other.
      failWith({ status: StatusCodes.UNAUTHORIZED, url: layoutUrl });
      failWith({
        status: StatusCodes.UNAUTHORIZED,
        url: 'http://localhost/api/v1/portfolio/holdings'
      });
      failWith({
        status: StatusCodes.UNAUTHORIZED,
        url: 'http://localhost/api/v1/account'
      });

      expect(messages).toHaveLength(1);
    });

    it('can say it again once the first message has been dismissed', () => {
      failWith({ status: StatusCodes.UNAUTHORIZED, url: layoutUrl });

      afterDismissed.next();

      failWith({ status: StatusCodes.UNAUTHORIZED, url: layoutUrl });

      // Suppression lasts as long as the notice is on screen and no longer, so a
      // later session ending in the same document is still reported.
      expect(messages).toHaveLength(2);
    });

    it('re-throws so the caller still sees the failure', () => {
      const caught = failWith({
        status: StatusCodes.UNAUTHORIZED,
        url: layoutUrl
      });

      expect((caught as HttpErrorResponse).status).toBe(
        StatusCodes.UNAUTHORIZED
      );
    });
  });

  describe('an unauthorized response to somebody who was never signed in', () => {
    beforeEach(() => {
      token = null;
    });

    it('says nothing about an expired session', () => {
      // The reachable case, not a contrived one: the root route asks for the
      // viewer before it knows whether there is one, so a first visit fails with
      // 401 of its own accord. Nothing expired, so nothing is claimed to have.
      failWith({
        status: StatusCodes.UNAUTHORIZED,
        url: 'http://localhost/api/v1/user'
      });

      expect(messages).toEqual([]);
    });

    it('still signs out, so nothing about the existing behaviour changes', () => {
      failWith({
        status: StatusCodes.UNAUTHORIZED,
        url: 'http://localhost/api/v1/user'
      });

      expect(signOut).toHaveBeenCalledTimes(1);
    });

    it('says nothing when the session was ended deliberately', () => {
      // Signing out clears the token first, so a request already in flight fails
      // behind it with nothing in storage. The viewer knows why they are signed
      // out and does not need to be told a session expired.
      failWith({ status: StatusCodes.UNAUTHORIZED, url: layoutUrl });

      expect(messages).toEqual([]);
    });
  });

  describe('an unauthorized data-provider verdict', () => {
    it('neither notifies nor signs the viewer out', () => {
      failWith({
        status: StatusCodes.UNAUTHORIZED,
        url: providerStatusUrl
      });

      // This 401 is the provider's answer about an API key, not a statement about
      // the viewer's session. Announcing an expired session here would be a lie,
      // and it is the one 401 in the application that must stay silent.
      expect(messages).toEqual([]);
      expect(signOut).not.toHaveBeenCalled();
    });
  });
});
