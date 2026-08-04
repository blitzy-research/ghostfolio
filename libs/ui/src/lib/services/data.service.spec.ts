import { UpdateUserDashboardLayoutDto } from '@ghostfolio/common/dtos';
import { UserDashboardLayout } from '@ghostfolio/common/interfaces';

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
