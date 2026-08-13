import { TokenStorageService } from '@ghostfolio/client/services/token-storage.service';
import { UserService } from '@ghostfolio/client/services/user/user.service';
import type { User } from '@ghostfolio/common/interfaces';
import { permissions } from '@ghostfolio/common/permissions';
import { NotificationService } from '@ghostfolio/ui/notifications';
import { AdminService } from '@ghostfolio/ui/services';

import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { Observable, of, throwError } from 'rxjs';

import { GfAdminJobsComponent } from './admin-jobs.component';

/**
 * The queue module.
 *
 * The read carried no failure handler, and the skeleton beneath the table is drawn
 * from the loading flag that read raises - so a rejection left the flag up and the
 * screen animated a row that was never going to arrive, for as long as the module
 * stayed on the canvas. The only trace was whatever global notice the response
 * happened to earn, six seconds of it, and nothing on the screen to press afterwards.
 *
 * The three controls on each row had the same shape of problem in reverse: a refused
 * delete or execute left the row exactly as it was, which is indistinguishable from
 * one that worked and a table that has not caught up.
 */
describe('GfAdminJobsComponent', () => {
  let component: GfAdminJobsComponent;
  let fixture: ComponentFixture<GfAdminJobsComponent>;
  let deleteJob: jest.Mock;
  let deleteJobs: jest.Mock;
  let executeJob: jest.Mock;
  let fetchJobs: jest.Mock;
  let jobsResponses: Observable<unknown>[];
  let reports: unknown[][];

  const createJobs = () => {
    return {
      jobs: [
        {
          attemptsMade: 1,
          data: { dataSource: 'YAHOO', symbol: 'AAPL' },
          finishedOn: null,
          id: '42',
          name: 'GATHER_ASSET_PROFILE',
          opts: { priority: 10 },
          stacktrace: [],
          state: 'active',
          timestamp: 1700000000000
        }
      ]
    };
  };

  const createComponent = async () => {
    reports = [];

    deleteJob = jest.fn(() => of(undefined));
    deleteJobs = jest.fn(() => of(undefined));
    executeJob = jest.fn(() => of(undefined));

    // Answered from a queue so a first read and a retry can differ, which is the
    // whole point of offering a retry.
    fetchJobs = jest.fn(() => {
      return jobsResponses.shift() ?? of(createJobs());
    });

    jest.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      reports.push(args);
    });

    TestBed.resetTestingModule();

    await TestBed.configureTestingModule({
      imports: [GfAdminJobsComponent],
      providers: [
        provideNoopAnimations(),
        {
          provide: AdminService,
          useValue: { deleteJob, deleteJobs, executeJob, fetchJobs }
        },
        { provide: NotificationService, useValue: { alert: jest.fn() } },
        { provide: TokenStorageService, useValue: { getToken: () => 'token' } },
        {
          provide: UserService,
          useValue: {
            stateChanged: of({
              user: {
                permissions: [permissions.accessAdminControl],
                settings: { locale: 'en' }
              } as unknown as User
            })
          }
        }
      ]
    }).compileComponents();

    fixture = TestBed.createComponent(GfAdminJobsComponent);
    component = fixture.componentInstance;

    fixture.detectChanges();

    return component;
  };

  const flags = () => {
    return component as unknown as { hasError: boolean; isLoading: boolean };
  };

  const alert = () => {
    return fixture.nativeElement.querySelector('[role="alert"]');
  };

  const retryButton = (): HTMLButtonElement => {
    return alert()?.querySelector('button');
  };

  const act = (method: 'onDeleteJob' | 'onDeleteJobs' | 'onExecuteJob') => {
    (component as unknown as Record<string, (id?: string) => void>)[method](
      '42'
    );

    fixture.detectChanges();
  };

  beforeEach(() => {
    jobsResponses = [];
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('a read that succeeds', () => {
    it('shows the queue and says nothing', async () => {
      await createComponent();

      expect(flags().hasError).toBe(false);
      expect(flags().isLoading).toBe(false);
      expect(alert()).toBeNull();
    });
  });

  describe('a read that fails', () => {
    it('stops looking busy', async () => {
      jobsResponses = [throwError(() => ({ status: 500 }))];

      await createComponent();

      // The flag is what draws the skeleton, so leaving it raised is precisely what
      // turned a failed read into a screen that looked busy forever.
      expect(flags().isLoading).toBe(false);
      expect(flags().hasError).toBe(true);
    });

    it('says so, and offers something to press', async () => {
      jobsResponses = [throwError(() => ({ status: 500 }))];

      await createComponent();

      expect(alert()).toBeTruthy();
      expect(alert().textContent).toContain('The queue could not be loaded.');
      expect(retryButton().textContent.trim()).toBe('Try again');
    });

    it('keeps the filter beside the failure', async () => {
      jobsResponses = [throwError(() => ({ status: 500 }))];

      await createComponent();

      // Unlike the single-purpose modules, the notice sits BELOW the table rather
      // than replacing it: the status filter above is the context that explains
      // which read failed.
      expect(fixture.nativeElement.querySelector('mat-select')).toBeTruthy();
    });

    it('recovers in place when the retry succeeds', async () => {
      jobsResponses = [throwError(() => ({ status: 500 }))];

      await createComponent();

      retryButton().click();
      fixture.detectChanges();

      expect(fetchJobs).toHaveBeenCalledTimes(2);
      expect(flags().hasError).toBe(false);
      expect(alert()).toBeNull();
    });

    it('asks again for whichever status is being filtered on', async () => {
      await createComponent();

      (
        component as unknown as {
          filterForm: {
            controls: { status: { setValue: (value: string) => void } };
          };
        }
      ).filterForm.controls.status.setValue('failed');

      fetchJobs.mockClear();

      (component as unknown as { onRetry: () => void }).onRetry();

      // The filter is re-read rather than remembered, so a retry answers the
      // question the viewer is currently asking.
      expect(fetchJobs).toHaveBeenCalledWith({ status: ['failed'] });
    });

    it('reports the failure without disclosing the payload', async () => {
      jobsResponses = [
        throwError(() => ({ status: 500, url: '/api/v1/admin/queue/jobs' }))
      ];

      await createComponent();

      expect(reports).toEqual([['GF-ADMIN-JOBS-FETCH-FAILED (status 500)']]);
      expect(JSON.stringify(reports)).not.toContain('/api/v1/admin');
    });
  });

  describe('a control that is refused', () => {
    it.each([
      ['onDeleteJob', 'deleteJob'],
      ['onDeleteJobs', 'deleteJobs'],
      ['onExecuteJob', 'executeJob']
    ])('re-reads the queue after %s fails', async (method, dependency) => {
      await createComponent();

      const doubles: Record<string, jest.Mock> = {
        deleteJob,
        deleteJobs,
        executeJob
      };

      doubles[dependency].mockReturnValue(throwError(() => ({ status: 500 })));

      fetchJobs.mockClear();

      act(method as 'onDeleteJob');

      // Refreshed from the server rather than left to imply an outcome it does not
      // know: the row is otherwise identical whether the action worked or not.
      expect(fetchJobs).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['onDeleteJob', 'deleteJob'],
      ['onDeleteJobs', 'deleteJobs'],
      ['onExecuteJob', 'executeJob']
    ])('still re-reads the queue after %s succeeds', async (method) => {
      await createComponent();

      fetchJobs.mockClear();

      act(method as 'onDeleteJob');

      expect(fetchJobs).toHaveBeenCalledTimes(1);
    });
  });
});
