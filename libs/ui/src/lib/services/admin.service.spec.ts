import { AdminData } from '@ghostfolio/common/interfaces';
import { GF_ENVIRONMENT } from '@ghostfolio/ui/environment';

import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';

import { AdminService } from './admin.service';
import { DataService } from './data.service';

/**
 * The administration overview read, and specifically how many times one canvas
 * load asks for it.
 *
 * The question only exists because of the single-canvas arrangement. On separate
 * routes the administration overview and the administration settings screens could
 * never be mounted together, so each reading `/api/v1/admin` on init cost one
 * request. Both are now modules that a viewer can place at once, and a measured
 * administrator canvas issued that read twice per load.
 *
 * The read is shared through the sibling facade's register rather than a second one
 * here, so these tests also pin the two properties that make sharing safe: it lasts
 * only as long as the request, and it never spans an identity change. The second is
 * covered in full by the facade's own suite; what is asserted here is that this
 * method genuinely participates.
 */
describe('AdminService', () => {
  const adminPath = '/api/v1/admin';

  let adminService: AdminService;
  let httpTestingController: HttpTestingController;

  const adminResponse = () => {
    return { dataProviders: [], settings: {}, transactionCount: 0 };
  };

  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();

    TestBed.configureTestingModule({
      providers: [
        AdminService,
        DataService,
        {
          provide: GF_ENVIRONMENT,
          useValue: { production: false, version: '0' }
        },
        provideHttpClient(),
        provideHttpClientTesting()
      ]
    });

    adminService = TestBed.inject(AdminService);
    httpTestingController = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    // What makes every count below exact rather than a lower bound.
    httpTestingController.verify();
  });

  describe('fetchAdminData', () => {
    it('serves two overlapping reads from one request', () => {
      const received: unknown[] = [];

      adminService.fetchAdminData().subscribe((response) => {
        received.push(response);
      });
      adminService.fetchAdminData().subscribe((response) => {
        received.push(response);
      });

      const requests = httpTestingController.match(adminPath);

      expect(requests.length).toBe(1);

      requests[0].flush(adminResponse());

      // Sharing is only correct if it still answers everyone who asked.
      expect(received.length).toBe(2);
    });

    it('goes back to the server for a read that follows a write', () => {
      adminService.fetchAdminData().subscribe();

      httpTestingController.expectOne(adminPath).flush(adminResponse());

      adminService.fetchAdminData().subscribe();

      // The administration settings component re-reads this immediately after
      // writing a setting. Answering from the previous response would show the
      // write as not having happened, which is why the entry is dropped as soon as
      // the request settles rather than cached for any interval at all.
      httpTestingController.expectOne(adminPath).flush(adminResponse());
    });

    it('goes back to the server after a failed read', () => {
      let failures = 0;

      adminService.fetchAdminData().subscribe({
        error: () => {
          failures += 1;
        }
      });

      httpTestingController
        .expectOne(adminPath)
        .flush(null, { status: 500, statusText: 'Internal Server Error' });

      expect(failures).toBe(1);

      adminService.fetchAdminData().subscribe();

      // Retaining a rejected request would turn one server error into a permanent
      // one for every caller that followed.
      httpTestingController.expectOne(adminPath).flush(adminResponse());
    });

    it('keeps the request alive while another caller is still waiting', () => {
      let received = 0;

      const abandoned = adminService.fetchAdminData().subscribe();

      adminService.fetchAdminData().subscribe(() => {
        received += 1;
      });

      const request = httpTestingController.expectOne(adminPath);

      abandoned.unsubscribe();

      // One of the two modules being destroyed - which happens as soon as a viewer
      // removes it from the canvas - must not abort the read the other one is
      // waiting on.
      expect(request.cancelled).toBe(false);

      request.flush(adminResponse());

      expect(received).toBe(1);
    });
  });
});

/**
 * The administration document read, asserted at the transport layer.
 *
 * Only this one method is covered, and only for the property that cannot be seen
 * from a single call. The rest of this facade is a thin pass-through to
 * `HttpClient` whose behaviour is its URL, and those URLs are already asserted
 * where it matters - `encodeApiPath` has its own suite in the sibling facade's
 * spec. What has no other home is the question this read newly answers: how many
 * requests two simultaneous callers produce.
 *
 * That question is asked here as well as of the entry point it goes through,
 * because the two assertions fail for different reasons. A test of
 * `DataService.coalesceGet` proves the register works; a test of
 * `fetchAdminData` proves this method is wired to it. A future edit that restored
 * a direct `http.get` here would leave the first one green.
 *
 * The measured duplication that prompted this: the admin overview and the admin
 * settings each read this document as they initialise, and on a canvas that mounts
 * whatever the viewer has arranged the two are routinely on screen together, so
 * the pairing produced two overlapping requests for one 630-byte document on
 * every load - cold and warm alike.
 */
describe('AdminService, reaching the shared read register', () => {
  const adminPath = '/api/v1/admin';

  let adminService: AdminService;
  let httpTestingController: HttpTestingController;

  const adminResponse = (): AdminData => {
    return {
      activitiesCount: 120,
      dataProviders: [],
      settings: { CURRENCY: 'USD' },
      userCount: 2,
      version: '3.0.0'
    };
  };

  beforeEach(() => {
    // The token is provided because the service injects it, not because this
    // suite exercises it: the environment description is read by the data
    // provider status calls, which nothing here reaches.
    TestBed.configureTestingModule({
      providers: [
        AdminService,
        DataService,
        provideHttpClient(),
        provideHttpClientTesting(),
        {
          provide: GF_ENVIRONMENT,
          useValue: { lastPublish: null, production: false }
        }
      ]
    });

    adminService = TestBed.inject(AdminService);
    httpTestingController = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    // Doing real work in every test below: it is what turns "one request was
    // made" into "only one request was made".
    httpTestingController.verify();
  });

  describe('fetchAdminData', () => {
    it('serves two simultaneous reads from one request', () => {
      const received: AdminData[] = [];

      adminService.fetchAdminData().subscribe((response) => {
        received.push(response);
      });
      adminService.fetchAdminData().subscribe((response) => {
        received.push(response);
      });

      const requests = httpTestingController.match(adminPath);

      expect(requests.length).toBe(1);

      requests[0].flush(adminResponse());

      // Sharing a request is only correct if it still answers everyone who
      // asked. A second module left waiting forever would be a worse defect than
      // the duplicate request this replaces.
      expect(received.length).toBe(2);
    });

    it('hands every caller the same response, unchanged', () => {
      const received: AdminData[] = [];

      adminService.fetchAdminData().subscribe((response) => {
        received.push(response);
      });
      adminService.fetchAdminData().subscribe((response) => {
        received.push(response);
      });

      httpTestingController.expectOne(adminPath).flush(adminResponse());

      expect(received[0]).toEqual(adminResponse());
      expect(received[1]).toEqual(adminResponse());
    });

    it('reads with GET from the versioned path', () => {
      adminService.fetchAdminData().subscribe();

      const testRequest = httpTestingController.expectOne(adminPath);

      expect(testRequest.request.method).toBe('GET');
      expect(testRequest.request.params.keys()).toEqual([]);

      testRequest.flush(adminResponse());
    });

    it('issues no request before it is subscribed to', () => {
      adminService.fetchAdminData();

      httpTestingController.expectNone(adminPath);
    });

    it('goes back to the server for a read issued after the first answered', () => {
      adminService.fetchAdminData().subscribe();

      httpTestingController.expectOne(adminPath).flush(adminResponse());

      adminService.fetchAdminData().subscribe();

      // Sharing is for reads that overlap. A read held past its answer would
      // freeze the administration document at whatever it said the first time,
      // and the settings module rereads it deliberately after a write.
      httpTestingController.expectOne(adminPath).flush(adminResponse());
    });

    it('shares one request with a read of the same path issued through the sibling facade', () => {
      const dataService = TestBed.inject(DataService);
      const received: unknown[] = [];

      adminService.fetchAdminData().subscribe((response) => {
        received.push(response);
      });
      dataService.coalesceGet(adminPath).subscribe((response) => {
        received.push(response);
      });

      // This is the assertion behind not giving this facade a register of its
      // own: there is exactly one, so two callers that arrive by different
      // routes still recognise each other's read - and cannot disagree about
      // when an identity changed.
      const requests = httpTestingController.match(adminPath);

      expect(requests.length).toBe(1);

      requests[0].flush(adminResponse());

      expect(received.length).toBe(2);
    });

    it('reports a failure rather than swallowing it', () => {
      let failure: unknown;

      adminService.fetchAdminData().subscribe({
        error: (error) => {
          failure = error;
        }
      });

      httpTestingController
        .expectOne(adminPath)
        .flush('Forbidden', { status: 403, statusText: 'Forbidden' });

      expect(failure).toBeTruthy();
    });
  });
});
