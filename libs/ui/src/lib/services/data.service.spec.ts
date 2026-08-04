import { UpdateUserDashboardLayoutDto } from '@ghostfolio/common/dtos';
import { UserDashboardLayout } from '@ghostfolio/common/interfaces';

import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';

import { DataService } from './data.service';

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
