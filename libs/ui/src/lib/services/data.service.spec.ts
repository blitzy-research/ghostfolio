import {
  KEY_STORAGE_AUTHORIZATION_TOKEN,
  KEY_STORAGE_IMPERSONATION_ID
} from '@ghostfolio/common/config';
import { UpdateUserDashboardLayoutDto } from '@ghostfolio/common/dtos';
import {
  PortfolioDetails,
  UserDashboardLayout
} from '@ghostfolio/common/interfaces';

import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';

import { DataService, encodeApiPath } from './data.service';

/**
 * The HTTP contract of the dashboard layout endpoints, asserted at the transport
 * layer.
 *
 * This is the one seam that no other suite reaches. Every client spec supplies
 * `fetchUserDashboardLayout` and `patchUserDashboardLayout` as mocks, and the API's
 * own integration suite begins at the controller, so between the two there is a gap
 * exactly one facade wide: a wrong verb, a wrong path, a body wrapped one level
 * too deep or a response generic that quietly reshapes what the canvas hydrates
 * from would leave *both* sides green while the round trip failed in the browser.
 *
 * `patchUserDashboardLayout` is additionally the first and only `http.patch` in a
 * facade of nine hundred lines, so its verb has no sibling to be checked against
 * and every other method in the file would be an unreliable guide to it.
 *
 * The path is spelled out as a literal rather than composed, because the literal is
 * the contract: the API derives `/api/v1/user/layout` from a global prefix and URI
 * versioning it applies at bootstrap, and the controller spec asserts the same
 * string from the other side. Two independent literals agreeing is the assertion;
 * a shared constant would only prove that one value equals itself.
 */
describe('DataService dashboard layout endpoints', () => {
  const layoutPath = '/api/v1/user/layout';

  let dataService: DataService;
  let httpTestingController: HttpTestingController;

  const storedLayout: UserDashboardLayout = {
    modules: [
      { cols: 6, moduleType: 'portfolio-overview', rows: 4, x: 0, y: 0 },
      { cols: 6, moduleType: 'holdings', rows: 4, x: 6, y: 0 }
    ],
    version: 1
  };

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [DataService, provideHttpClient(), provideHttpClientTesting()]
    });

    dataService = TestBed.inject(DataService);
    httpTestingController = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    // Fails the test if any request went unasserted, which is what turns "the
    // expected request was made" into "exactly the expected request was made".
    httpTestingController.verify();
  });

  describe('fetchUserDashboardLayout', () => {
    it('reads the layout with GET from the versioned path', () => {
      let received: UserDashboardLayout | null | undefined;

      dataService.fetchUserDashboardLayout().subscribe((layout) => {
        received = layout;
      });

      const request = httpTestingController.expectOne(layoutPath);

      expect(request.request.method).toBe('GET');
      expect(request.request.body).toBeNull();
      expect(request.request.params.keys()).toEqual([]);

      request.flush(storedLayout);

      expect(received).toEqual(storedLayout);
    });

    it('passes an absent layout through as null rather than normalising it', () => {
      let received: UserDashboardLayout | null | undefined = storedLayout;
      let emissions = 0;

      dataService.fetchUserDashboardLayout().subscribe((layout) => {
        emissions = emissions + 1;
        received = layout;
      });

      httpTestingController.expectOne(layoutPath).flush(null);

      // `null` is the answer for a viewer who has never saved an arrangement, and
      // the canvas reads it as "first visit" and opens the catalog. Coercing it to
      // an empty document here would be indistinguishable to the canvas but would
      // rob the layout store of the distinction between "absent" and "not fetched
      // yet".
      expect(emissions).toBe(1);
      expect(received).toBeNull();
    });

    it('issues no request before it is subscribed to', () => {
      dataService.fetchUserDashboardLayout();

      // A cold observable, like every other read on this facade. A method that
      // fired on call would read the layout of whoever happened to be signed in at
      // construction time.
      httpTestingController.expectNone(layoutPath);
    });

    it('reports a failure rather than swallowing it', () => {
      let status: number | undefined;

      dataService.fetchUserDashboardLayout().subscribe({
        error: (error: { status: number }) => {
          status = error.status;
        }
      });

      httpTestingController
        .expectOne(layoutPath)
        .flush('Internal Server Error', {
          status: 500,
          statusText: 'Internal Server Error'
        });

      // The canvas distinguishes a failed read from an empty arrangement, and it can
      // only do that if the failure reaches it.
      expect(status).toBe(500);
    });
  });

  describe('patchUserDashboardLayout', () => {
    const payload: UpdateUserDashboardLayoutDto = {
      modules: [
        { cols: 6, moduleType: 'portfolio-overview', rows: 4, x: 0, y: 0 }
      ],
      version: 1
    };

    it('writes the layout with PATCH to the very same path', () => {
      let received: UserDashboardLayout | undefined;

      dataService.patchUserDashboardLayout(payload).subscribe((layout) => {
        received = layout;
      });

      const request = httpTestingController.expectOne(layoutPath);

      // PATCH, not PUT and not POST. The endpoint is declared with `@Patch`, and a
      // mismatch here is a 404 rather than a validation error - which is to say it
      // would look like a missing endpoint rather than a wrong call.
      expect(request.request.method).toBe('PATCH');

      request.flush(payload);

      expect(received).toEqual(payload);
    });

    it('sends the document as the body, unwrapped', () => {
      dataService.patchUserDashboardLayout(payload).subscribe();

      const request = httpTestingController.expectOne(layoutPath);

      // Identity, then shape. The API validates with `forbidNonWhitelisted`, so a
      // wrapper object, a renamed member or a surplus one is a 400; and the body
      // being the argument itself is what keeps the layout service the single place
      // that decides what a persisted arrangement contains.
      expect(request.request.body).toBe(payload);
      expect(Object.keys(request.request.body as object).sort()).toEqual([
        'modules',
        'version'
      ]);

      request.flush(payload);
    });

    it('sends an empty module list, so removing the last module is persistable', () => {
      const emptied: UpdateUserDashboardLayoutDto = { modules: [] };

      dataService.patchUserDashboardLayout(emptied).subscribe();

      const request = httpTestingController.expectOne(layoutPath);

      expect(request.request.body).toEqual({ modules: [] });

      request.flush({ modules: [] });
    });

    it('issues no request before it is subscribed to', () => {
      dataService.patchUserDashboardLayout(payload);

      // Cold, like the read. The layout service debounces and then switches to the
      // newest snapshot, which relies on nothing having been sent until the
      // resulting observable is actually subscribed.
      httpTestingController.expectNone(layoutPath);
    });

    it('reports a rejected write rather than swallowing it', () => {
      let status: number | undefined;

      dataService.patchUserDashboardLayout(payload).subscribe({
        error: (error: { status: number }) => {
          status = error.status;
        }
      });

      httpTestingController.expectOne(layoutPath).flush('Bad Request', {
        status: 400,
        statusText: 'Bad Request'
      });

      // The layout service contains a failed write inside its own request so the
      // save stream survives it, and it can only do that if the failure arrives.
      expect(status).toBe(400);
    });
  });

  describe('the two endpoints together', () => {
    it('address one path with two verbs', () => {
      dataService.fetchUserDashboardLayout().subscribe();
      dataService
        .patchUserDashboardLayout({ modules: [], version: 1 })
        .subscribe();

      const requests = httpTestingController.match(layoutPath);

      // One resource, two operations. Asserted together because the round trip is
      // what the canvas depends on: hydrating from one path and writing to another
      // would only surface as a layout that never came back.
      expect(requests.map(({ request }) => request.method)).toEqual([
        'GET',
        'PATCH'
      ]);

      for (const request of requests) {
        expect(request.request.url).toBe(layoutPath);

        request.flush({ modules: [], version: 1 });
      }
    });
  });
});

/**
 * The path encoder every request URL in this workspace is built with, tested as the
 * security boundary it is rather than as a formatting helper.
 *
 * The claim under test is narrow and load-bearing: an interpolated identifier may
 * contribute exactly one path segment, and may never re-address the request. Two
 * facts make that non-obvious and are therefore pinned here rather than left to the
 * reader. The dot is an *unreserved* character, so `encodeURIComponent` returns `.`
 * and `..` verbatim - encoding does not touch them at all. And percent-encoding is
 * no remedy, because a URL parser decodes a segment before it decides whether the
 * segment is relative, so `%2e%2e` is resolved away exactly as `..` is; a fix that
 * substituted `%2E` for the dot would read as a fix and change nothing.
 *
 * The rejection is asserted against the WHATWG dot-segment set rather than against
 * a single example, and the pass-through cases are asserted alongside it, because a
 * check that is too wide is its own defect: asset symbols legitimately contain dots
 * and refusing `BRK.B` would break a real portfolio.
 */
describe('encodeApiPath', () => {
  describe('ordinary identifiers', () => {
    it('contributes each value as exactly one segment', () => {
      expect(
        encodeApiPath`/api/v1/symbol/${'YAHOO'}/${'AAPL'}/${'2024-01-01'}`
      ).toBe('/api/v1/symbol/YAHOO/AAPL/2024-01-01');
    });

    it('encodes a reserved character instead of letting it delimit', () => {
      // A manually maintained asset may legitimately carry a slash or a hash in
      // its symbol. Encoded, it stays one segment; raw, it would silently become
      // two - or truncate the path at a fragment.
      expect(encodeApiPath`/api/v1/symbol/${'MANUAL'}/${'A/B#C'}`).toBe(
        '/api/v1/symbol/MANUAL/A%2FB%23C'
      );
    });

    it('accepts a symbol that merely contains a dot', () => {
      // The check must be exactly as wide as the parser's own and no wider. These
      // are real symbols; a broader test would break a real portfolio.
      for (const symbol of ['BRK.B', 'VWRL.AS', '.hidden', 'a..b', '...']) {
        expect(() => {
          return encodeApiPath`/api/v1/symbol/${'YAHOO'}/${symbol}`;
        }).not.toThrow();
      }
    });

    it('accepts a numeric value', () => {
      expect(encodeApiPath`/api/v1/admin/queue/job/${42}`).toBe(
        '/api/v1/admin/queue/job/42'
      );
    });
  });

  describe('a value a URL parser would resolve away', () => {
    it.each(['.', '..'])('refuses %p outright', (value) => {
      expect(() => {
        return encodeApiPath`/api/v1/symbol/${'YAHOO'}/${value}/${'2024-01-01'}`;
      }).toThrow(/relative path segment/);
    });

    it('refuses it in any position, not only the last', () => {
      expect(() => {
        return encodeApiPath`/api/v1/symbol/${'..'}/${'AAPL'}`;
      }).toThrow(/relative path segment/);
    });

    it('names the offending value, so the failure is diagnosable', () => {
      expect(() => {
        return encodeApiPath`/api/v1/account/${'..'}`;
      }).toThrow(/'\.\.'/);
    });

    // The other half of the boundary, and the half that is easy to get wrong in
    // the opposite direction. A percent-spelled dot segment arriving as raw input
    // is neutralised by the encoder rather than refused by it, because
    // `encodeURIComponent` turns the literal `%` into `%25` - so the segment that
    // reaches the parser is `%252e`, which is not a dot segment at all. Refusing
    // these as well would be a check wider than the parser's own, and the
    // assertion below is what pins the distinction rather than leaving it to be
    // rediscovered.
    it.each(['%2e', '%2E', '%2e%2e', '%2E%2E', '.%2e', '%2e.'])(
      'accepts %p, because encoding already neutralises it',
      (value) => {
        expect(() => {
          return encodeApiPath`/api/v1/symbol/${'YAHOO'}/${value}/${'2024-01-01'}`;
        }).not.toThrow();
      }
    );

    it.each(['%2e', '%2e%2e', '.%2e'])(
      'keeps %p as one segment once a parser has seen it',
      (value) => {
        // Proven through a real parser rather than asserted in prose: the claim
        // above is only sound if the encoded form genuinely survives
        // normalisation.
        const path = encodeApiPath`/api/v1/symbol/${'YAHOO'}/${value}/${'2024-01-01'}`;

        expect(new URL(`https://example.invalid${path}`).pathname).toBe(path);
      }
    );
  });

  describe('what the refusal prevents', () => {
    it.each([
      ['..', '/api/v1/symbol/2024-01-01'],
      ['%2e%2e', '/api/v1/symbol/2024-01-01'],
      ['.%2E', '/api/v1/symbol/2024-01-01']
    ])(
      'a path built with %p would have been resolved to %p',
      (value, resolvedPathname) => {
        // Asserted through a real URL parser rather than described in prose. This
        // is the outcome the throw above replaces: the identifier is gone, one
        // segment of the intended path is gone with it, and the request that
        // leaves the browser names an endpoint the caller never asked for - with
        // the signed-in viewer's credentials attached.
        expect(
          new URL(
            `https://example.invalid/api/v1/symbol/YAHOO/${value}/2024-01-01`
          ).pathname
        ).toBe(resolvedPathname);
      }
    );

    it('leaves a legitimate dot-containing symbol intact through a parser', () => {
      expect(
        new URL(
          `https://example.invalid${encodeApiPath`/api/v1/symbol/${'YAHOO'}/${'BRK.B'}`}`
        ).pathname
      ).toBe('/api/v1/symbol/YAHOO/BRK.B');
    });
  });
});

/**
 * Sharing of reads that are already on the wire.
 *
 * The canvas mounts many modules at once and several of them independently want
 * the same figures. Measured on a canvas holding Overview, Summary, Holdings,
 * FIRE, Allocations and Analysis, that produced 14 requests for 11 distinct
 * URLs - `performance?range=max` twice at 177,765 bytes each and
 * `holdings?range=max` twice at 15,788 bytes each - so 185 kB of a 449 kB API
 * payload was spent re-fetching bytes the page already had in flight.
 *
 * Every assertion here is about a property that cannot be seen from a single
 * call, which is why they live in their own suite: how many requests reach the
 * transport, whether two callers with different questions are kept apart,
 * whether the response mapping runs once or twice, and whether abandoning a read
 * still cancels it. `httpTestingController.verify()` in `afterEach` is doing
 * real work in all of them - it is what turns "one request was made" into "only
 * one request was made".
 */
describe('DataService in-flight read sharing', () => {
  const detailsPath = '/api/v1/portfolio/details';
  const holdingsPath = '/api/v1/portfolio/holdings';
  const performancePath = '/api/v2/portfolio/performance';

  let dataService: DataService;
  let httpTestingController: HttpTestingController;

  // Dates arrive as strings and are parsed by the facade's own response mapping.
  // Kept as a constant so a test can assert that the mapping ran, and ran once.
  const firstActivity = '2024-01-15T00:00:00.000Z';

  const detailsResponse = () => {
    return {
      holdings: {
        AAPL: {
          assetClass: 'EQUITY',
          assetSubClass: 'STOCK',
          dateOfFirstActivity: firstActivity,
          value: 1234
        }
      },
      summary: { dateOfFirstActivity: firstActivity }
    };
  };

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [DataService, provideHttpClient(), provideHttpClientTesting()]
    });

    dataService = TestBed.inject(DataService);
    httpTestingController = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    httpTestingController.verify();
  });

  it('serves two overlapping identical reads from one request', () => {
    const received: unknown[] = [];

    dataService.fetchPortfolioDetails().subscribe((response) => {
      received.push(response);
    });
    dataService.fetchPortfolioDetails().subscribe((response) => {
      received.push(response);
    });

    // The assertion is the count. `match` returns every request made against the
    // path, so two would fail here just as loudly as none.
    const requests = httpTestingController.match(detailsPath);

    expect(requests.length).toBe(1);

    requests[0].flush(detailsResponse());

    // Sharing a request is only correct if it still answers everyone who asked.
    expect(received.length).toBe(2);
  });

  it('keeps reads apart when their query strings differ', () => {
    dataService.fetchPortfolioDetails().subscribe();
    dataService.fetchPortfolioDetails({ withMarkets: true }).subscribe();

    const requests = httpTestingController.match(
      ({ url }) => url === detailsPath
    );

    // Two callers, two questions, two requests. This is the boundary that keeps
    // the sharing honest: on the measured canvas, Allocations asks for
    // `?withMarkets=true` and receives a materially different 21,040-byte body,
    // so answering it with Summary's 17,628-byte response would be wrong rather
    // than merely wasteful.
    expect(requests.length).toBe(2);

    expect(
      requests
        .map(({ request }) => request.params.get('withMarkets'))
        .sort((a, b) => {
          return String(a).localeCompare(String(b));
        })
    ).toEqual(
      ['true', null].sort((a, b) => String(a).localeCompare(String(b)))
    );

    for (const request of requests) {
      request.flush(detailsResponse());
    }
  });

  it('runs the response mapping exactly once for a shared read', () => {
    // Typed from what the method actually emits rather than left as `any`. That is
    // not decoration here: the assertions below reach into `summary` and `holdings`
    // and call a method on a parsed date, and every one of those reads was an
    // unchecked hop off an `any` - so a renamed or removed member would have gone
    // unnoticed by the compiler while the test still described it.
    const received: PortfolioDetails[] = [];

    dataService.fetchPortfolioDetails().subscribe((response) => {
      received.push(response);
    });
    dataService.fetchPortfolioDetails().subscribe((response) => {
      received.push(response);
    });

    const requests = httpTestingController.match(detailsPath);

    expect(requests.length).toBe(1);

    // A second pass over the same object would throw rather than merely produce
    // something wrong: the mapping rewrites `dateOfFirstActivity` in place, so
    // the second `parseISO` would be handed the `Date` the first one produced
    // and `parseISO` has no string to split. Reaching this line at all is part
    // of the assertion.
    expect(() => {
      requests[0].flush(detailsResponse());
    }).not.toThrow();

    expect(received.length).toBe(2);

    // Parsed once, so both callers hold a real date rather than an invalid one.
    for (const response of received) {
      const { holdings, summary } = response;

      // Narrowed with a throw rather than with a matcher, because a Jest matcher
      // does not narrow a type and the wire contract marks `summary` optional. The
      // reads below have to be reachable only when it is genuinely there, and a
      // response that carried none should fail here saying so rather than further
      // down as a property access on `undefined`.
      if (!summary) {
        throw new Error('The shared response carried no summary to check.');
      }

      expect(summary.dateOfFirstActivity instanceof Date).toBe(true);
      expect(Number.isNaN(summary.dateOfFirstActivity.getTime())).toBe(false);
      expect(holdings.AAPL.dateOfFirstActivity instanceof Date).toBe(true);
    }
  });

  it('shares the reads the canvas actually duplicated', () => {
    // Holdings is asked for by the Holdings module and by Analysis; performance
    // by Overview and by Analysis. Each pair resolves to a byte-identical URL, and
    // both are asserted here so a future change to either method's parameter
    // assembly cannot silently un-share it.
    dataService.fetchPortfolioHoldings({ range: 'max' }).subscribe();
    dataService.fetchPortfolioHoldings({ range: 'max' }).subscribe();

    dataService.fetchPortfolioPerformance({ range: 'max' }).subscribe();
    dataService.fetchPortfolioPerformance({ range: 'max' }).subscribe();

    const holdingsRequests = httpTestingController.match(
      ({ url }) => url === holdingsPath
    );
    const performanceRequests = httpTestingController.match(
      ({ url }) => url === performancePath
    );

    expect(holdingsRequests.length).toBe(1);
    expect(performanceRequests.length).toBe(1);

    expect(holdingsRequests[0].request.params.get('range')).toBe('max');
    expect(performanceRequests[0].request.params.get('range')).toBe('max');

    holdingsRequests[0].flush({ holdings: [], markets: {} });
    performanceRequests[0].flush({ chart: [], firstOrderDate: firstActivity });
  });

  it('does not answer a later read from an earlier response', () => {
    dataService.fetchPortfolioDetails().subscribe();

    const first = httpTestingController.expectOne(detailsPath);

    first.flush(detailsResponse());

    dataService.fetchPortfolioDetails().subscribe();

    // Nothing is retained once a read has answered, so a caller that arrives
    // afterwards goes to the server. That is the property that makes this safe
    // to apply to a facade whose callers write and then re-read: a cache with
    // any lifetime at all could answer this second read from before the write.
    // A failing assertion here means the sharing has become a cache.
    httpTestingController.expectOne(detailsPath).flush(detailsResponse());
  });

  it('cancels the request when the last caller walks away', () => {
    const subscription = dataService.fetchPortfolioDetails().subscribe();

    const request = httpTestingController.expectOne(detailsPath);

    expect(request.cancelled).toBe(false);

    subscription.unsubscribe();

    // A module destroyed while its read is outstanding must still abort it,
    // otherwise sharing would have quietly cost the app its cancellation.
    expect(request.cancelled).toBe(true);
  });

  it('keeps the request alive while another caller is still waiting', () => {
    let received = 0;

    const abandoned = dataService.fetchPortfolioDetails().subscribe();

    dataService.fetchPortfolioDetails().subscribe(() => {
      received += 1;
    });

    const request = httpTestingController.expectOne(detailsPath);

    abandoned.unsubscribe();

    // The one case where a read must survive its originator: the caller that
    // joined it is still waiting on the answer.
    expect(request.cancelled).toBe(false);

    request.flush(detailsResponse());

    expect(received).toBe(1);
  });

  it('goes back to the server after a failed read', () => {
    let failures = 0;

    dataService.fetchPortfolioDetails().subscribe({
      error: () => {
        failures += 1;
      }
    });

    httpTestingController
      .expectOne(detailsPath)
      .flush(null, { status: 500, statusText: 'Internal Server Error' });

    expect(failures).toBe(1);

    dataService.fetchPortfolioDetails().subscribe();

    // A failure has to release the read as thoroughly as a success does. Holding
    // a rejected request would turn one server error into a permanent one for
    // every caller that followed.
    httpTestingController.expectOne(detailsPath).flush(detailsResponse());
  });
});

/**
 * Who a shared read was issued as.
 *
 * The request line is only part of what distinguishes these requests. The bearer
 * token, the impersonated account and the timezone are attached afterwards, by the
 * application's outgoing request interceptor, and are invisible to the sharing
 * decision - so on the request line alone two reads of `/portfolio/details` made
 * as two different accounts are indistinguishable, and the second would be handed
 * the first one's response.
 *
 * That is reachable in one document without any race being contrived. A sign-out
 * followed by a sign-in, an access-token sign-in, a 401 from any request, and every
 * impersonation change all swap the identity while reads are outstanding, because
 * the canvas keeps several of them in flight at once. The disclosed values are
 * holdings, performance, positions and summary figures - the whole of the portfolio.
 *
 * Each test below therefore reproduces the same shape: start a read, change the
 * identity **without flushing**, start the same read again, and require that the
 * second one reaches the network on its own. `httpTestingController.verify()` in
 * `afterEach` is what makes the request counts exact.
 */
describe('DataService in-flight read sharing across identities', () => {
  const detailsPath = '/api/v1/portfolio/details';

  /**
   * The storage keys the outgoing request interceptor reads to decide which
   * account a request is made as. Imported rather than spelled out, because the
   * partitioning is only correct while the facade and the interceptor read the
   * same keys - and a copy here would keep passing after a rename that had already
   * un-partitioned production.
   */
  const authorizationTokenKey = KEY_STORAGE_AUTHORIZATION_TOKEN;
  const impersonationIdKey = KEY_STORAGE_IMPERSONATION_ID;

  const responseFor = (holding: string) => {
    return { holdings: { [holding]: { value: 1 } } };
  };

  let dataService: DataService;
  let httpTestingController: HttpTestingController;

  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();

    TestBed.configureTestingModule({
      providers: [DataService, provideHttpClient(), provideHttpClientTesting()]
    });

    dataService = TestBed.inject(DataService);
    httpTestingController = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    httpTestingController.verify();

    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  it('does not let a read issued as one account join a request created as another', () => {
    window.sessionStorage.setItem(authorizationTokenKey, 'token-of-account-a');

    let receivedByB: unknown;

    dataService.fetchPortfolioDetails().subscribe();

    const requestAsAccountA = httpTestingController.expectOne(detailsPath);

    // The identity changes while account A's read is still outstanding, which is
    // exactly what a sign-out and sign-in, an access-token sign-in, or a 401 does.
    window.sessionStorage.setItem(authorizationTokenKey, 'token-of-account-b');

    dataService.fetchPortfolioDetails().subscribe((response) => {
      receivedByB = response;
    });

    const requestsAsAccountB = httpTestingController.match(
      ({ url }) => url === detailsPath && url !== undefined
    );

    // One request for A, one for B. Without partitioning by argument there would
    // be one request in total and B would be subscribed to it.
    expect(requestsAsAccountB.length).toBe(1);

    requestAsAccountA.flush(responseFor('ACCOUNT_A_HOLDING'));

    // A's response landed and B is still waiting, which is the assertion that
    // matters: B was never subscribed to A's request and therefore cannot have
    // been handed A's portfolio.
    expect(receivedByB).toBeUndefined();

    requestsAsAccountB[0].flush(responseFor('ACCOUNT_B_HOLDING'));

    expect(receivedByB).toEqual(responseFor('ACCOUNT_B_HOLDING'));
  });

  it('does not let a read join a request created under a different impersonation', () => {
    window.sessionStorage.setItem(authorizationTokenKey, 'token-of-an-admin');
    window.localStorage.setItem(impersonationIdKey, 'impersonated-user-1');

    dataService.fetchPortfolioDetails().subscribe();

    const requestAsFirstSubject = httpTestingController.expectOne(detailsPath);

    // The token is unchanged; only who it is being used on behalf of has changed.
    // The server scopes the whole response by this header, so it varies the answer
    // just as completely as the token does.
    window.localStorage.setItem(impersonationIdKey, 'impersonated-user-2');

    dataService.fetchPortfolioDetails().subscribe();

    const requestAsSecondSubject = httpTestingController.match(
      ({ url }) => url === detailsPath
    );

    expect(requestAsSecondSubject.length).toBe(1);

    requestAsFirstSubject.flush(responseFor('SUBJECT_1_HOLDING'));
    requestAsSecondSubject[0].flush(responseFor('SUBJECT_2_HOLDING'));
  });

  it('does not let a read join a request created before impersonation was cleared', () => {
    window.sessionStorage.setItem(authorizationTokenKey, 'token-of-an-admin');
    window.localStorage.setItem(impersonationIdKey, 'impersonated-user-1');

    dataService.fetchPortfolioDetails().subscribe();

    const requestWhileImpersonating =
      httpTestingController.expectOne(detailsPath);

    // Leaving impersonation is the same transition in the opposite direction, and
    // the one where joining would disclose the *admin's* own portfolio to a view
    // that was showing somebody else's.
    window.localStorage.removeItem(impersonationIdKey);

    dataService.fetchPortfolioDetails().subscribe();

    const requestAfterLeaving = httpTestingController.match(
      ({ url }) => url === detailsPath
    );

    expect(requestAfterLeaving.length).toBe(1);

    requestWhileImpersonating.flush(responseFor('SUBJECT_HOLDING'));
    requestAfterLeaving[0].flush(responseFor('ADMIN_HOLDING'));
  });

  it('does not let a signed-out read join one issued while signed in', () => {
    window.sessionStorage.setItem(authorizationTokenKey, 'token-of-account-a');

    dataService.fetchPortfolioDetails().subscribe();

    const requestWhileSignedIn = httpTestingController.expectOne(detailsPath);

    // Sign-out clears the token, and the response interceptor does exactly this on
    // any 401. An anonymous read must not be answered from a request that carried
    // somebody's credentials.
    window.sessionStorage.removeItem(authorizationTokenKey);

    dataService.fetchPortfolioDetails().subscribe();

    const requestWhileSignedOut = httpTestingController.match(
      ({ url }) => url === detailsPath
    );

    expect(requestWhileSignedOut.length).toBe(1);

    requestWhileSignedIn.flush(responseFor('ACCOUNT_A_HOLDING'));
    requestWhileSignedOut[0].flush(responseFor('NOTHING'));
  });

  it('reads the token from local storage when the session holds none', () => {
    // "Stay signed in" writes to local storage, and the interceptor falls back to
    // it. A facade that only looked at session storage would treat every one of
    // those visitors as anonymous and share their reads with each other.
    window.localStorage.setItem(authorizationTokenKey, 'token-of-account-a');

    dataService.fetchPortfolioDetails().subscribe();

    const requestAsAccountA = httpTestingController.expectOne(detailsPath);

    window.localStorage.setItem(authorizationTokenKey, 'token-of-account-b');

    dataService.fetchPortfolioDetails().subscribe();

    const requestAsAccountB = httpTestingController.match(
      ({ url }) => url === detailsPath
    );

    expect(requestAsAccountB.length).toBe(1);

    requestAsAccountA.flush(responseFor('ACCOUNT_A_HOLDING'));
    requestAsAccountB[0].flush(responseFor('ACCOUNT_B_HOLDING'));
  });

  it('still shares two overlapping reads issued as the same account', () => {
    window.sessionStorage.setItem(authorizationTokenKey, 'token-of-account-a');
    window.localStorage.setItem(impersonationIdKey, 'impersonated-user-1');

    const received: unknown[] = [];

    dataService.fetchPortfolioDetails().subscribe((response) => {
      received.push(response);
    });
    dataService.fetchPortfolioDetails().subscribe((response) => {
      received.push(response);
    });

    // The partitioning must not have been achieved by abandoning the sharing. Two
    // modules on one canvas asking the same question as the same account is the
    // case the sharing exists for, and it still collapses to one request.
    const requests = httpTestingController.match(detailsPath);

    expect(requests.length).toBe(1);

    requests[0].flush(responseFor('ACCOUNT_A_HOLDING'));

    expect(received.length).toBe(2);
  });

  it('ignores an impersonation identifier left behind with no token', () => {
    // Impersonation is only sent alongside a bearer token, so a stale identifier
    // in storage does not change an anonymous request and must not split reads that
    // are in fact identical.
    window.localStorage.setItem(impersonationIdKey, 'stale-impersonation');

    dataService.fetchPortfolioDetails().subscribe();
    dataService.fetchPortfolioDetails().subscribe();

    const requests = httpTestingController.match(detailsPath);

    expect(requests.length).toBe(1);

    requests[0].flush(responseFor('ANONYMOUS'));
  });

  it('keeps no bearer token in the key it partitions by', () => {
    const token = 'token-that-must-not-be-retained';

    window.sessionStorage.setItem(authorizationTokenKey, token);

    dataService.fetchPortfolioDetails().subscribe();

    const request = httpTestingController.expectOne(detailsPath);

    // The register is keyed by a generation counter, not by the context itself. A
    // credential has no business being a map key in a service that lives as long
    // as the document, reachable from anything holding a reference to it.
    const registerKeys = [
      ...(
        dataService as unknown as {
          inFlightGetRequests: Map<string, unknown>;
        }
      ).inFlightGetRequests.keys()
    ];

    expect(registerKeys.length).toBe(1);

    for (const key of registerKeys) {
      expect(key).not.toContain(token);
    }

    request.flush(responseFor('ACCOUNT_A_HOLDING'));
  });
});
