import { ImpersonationStorageService } from '@ghostfolio/client/services/impersonation-storage.service';
import { UserService } from '@ghostfolio/client/services/user/user.service';
import { DashboardModuleType } from '@ghostfolio/common/dashboard';
import type { User } from '@ghostfolio/common/interfaces';
import { NotificationService } from '@ghostfolio/ui/notifications';
import { DataService } from '@ghostfolio/ui/services';

import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MatDialog } from '@angular/material/dialog';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { ActivatedRoute, Router } from '@angular/router';
import { BehaviorSubject, Observable, of, throwError } from 'rxjs';

import { GfHomeWatchlistComponent } from './home-watchlist.component';

/**
 * The watchlist module.
 *
 * Two defects met in this component. Its read had no failure handler at all, and the
 * table beneath it draws skeleton rows from an undefined list - so a rejected read
 * was rendered as work still in progress, for as long as the module stayed on the
 * canvas, with nothing said and nothing to press. And it used to issue the CREATE
 * itself, from inside `afterClosed`, after the dialog it belonged to had gone.
 *
 * The create now belongs to the dialog. What is left here is handing over the list a
 * repeat is recognised against, and re-reading once the dialog reports it added
 * something.
 */
describe('GfHomeWatchlistComponent', () => {
  let component: GfHomeWatchlistComponent;
  let fixture: ComponentFixture<GfHomeWatchlistComponent>;
  let dialogOpen: jest.Mock;
  let dialogAfterClosed: Observable<unknown>;
  let fetchWatchlist: jest.Mock;
  let navigate: jest.Mock;
  let queryParams: BehaviorSubject<Record<string, unknown>>;
  let reports: unknown[][];
  let watchlistResponses: Observable<unknown>[];

  const user = {
    permissions: ['createWatchlistItem', 'deleteWatchlistItem'],
    settings: { locale: 'en' },
    subscription: { type: 'Premium' }
  } as unknown as User;

  const createComponent = async () => {
    dialogAfterClosed = of(undefined);
    navigate = jest.fn(() => Promise.resolve(true));
    queryParams = new BehaviorSubject<Record<string, unknown>>({});
    reports = [];

    dialogOpen = jest.fn(() => ({
      afterClosed: () => dialogAfterClosed
    }));

    // Answered from a queue so a first read and a retry can differ, which is the
    // whole point of offering a retry.
    fetchWatchlist = jest.fn(() => {
      return watchlistResponses.shift() ?? of({ watchlist: [] });
    });

    jest.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      reports.push(args);
    });

    TestBed.resetTestingModule();

    await TestBed.configureTestingModule({
      imports: [GfHomeWatchlistComponent],
      providers: [
        provideNoopAnimations(),
        {
          provide: ActivatedRoute,
          useValue: { queryParams: queryParams.asObservable() }
        },
        {
          provide: DataService,
          useValue: {
            deleteWatchlistItem: () => of({}),
            fetchWatchlist
          }
        },
        {
          provide: ImpersonationStorageService,
          useValue: { onChangeHasImpersonation: () => of(null) }
        },
        { provide: MatDialog, useValue: { open: dialogOpen } },
        // Reached by the benchmark table this component mounts, and only when a row
        // is acted on - which nothing here does.
        { provide: NotificationService, useValue: {} },
        { provide: Router, useValue: { navigate } },
        {
          provide: UserService,
          useValue: { get: () => of(user), stateChanged: of({ user }) }
        }
      ]
    }).compileComponents();

    fixture = TestBed.createComponent(GfHomeWatchlistComponent);
    component = fixture.componentInstance;

    fixture.detectChanges();

    return component;
  };

  const hasError = () => {
    return (component as unknown as { hasError: boolean }).hasError;
  };

  const alert = () => {
    return fixture.nativeElement.querySelector('[role="alert"]');
  };

  const retryButton = (): HTMLButtonElement => {
    return alert()?.querySelector('button');
  };

  beforeEach(() => {
    watchlistResponses = [];
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('a read that succeeds', () => {
    it('shows the table and says nothing', async () => {
      watchlistResponses = [
        of({ watchlist: [{ dataSource: 'YAHOO', symbol: 'AAPL' }] })
      ];

      await createComponent();

      expect(hasError()).toBe(false);
      expect(alert()).toBeNull();
      expect(fixture.nativeElement.querySelector('gf-benchmark')).toBeTruthy();
    });
  });

  describe('a read that fails', () => {
    it('ends in a finite state instead of loading forever', async () => {
      watchlistResponses = [throwError(() => ({ status: 500 }))];

      await createComponent();

      expect(hasError()).toBe(true);
      expect(alert()).toBeTruthy();
      expect(alert().textContent).toContain(
        'Your watchlist could not be loaded.'
      );
    });

    /**
     * The table is what made the original defect invisible: it renders skeleton rows
     * from an undefined list, so leaving it mounted beside a message would still read
     * as work in progress.
     */
    it('replaces the table rather than sitting above it', async () => {
      watchlistResponses = [throwError(() => ({ status: 500 }))];

      await createComponent();

      expect(fixture.nativeElement.querySelector('gf-benchmark')).toBeNull();
    });

    it('offers something to press', async () => {
      watchlistResponses = [throwError(() => ({ status: 500 }))];

      await createComponent();

      expect(retryButton()).toBeTruthy();
      expect(retryButton().textContent.trim()).toBe('Try again');
    });

    it('recovers in place when the retry succeeds', async () => {
      watchlistResponses = [
        throwError(() => ({ status: 500 })),
        of({ watchlist: [{ dataSource: 'YAHOO', symbol: 'AAPL' }] })
      ];

      await createComponent();

      retryButton().click();
      fixture.detectChanges();

      expect(fetchWatchlist).toHaveBeenCalledTimes(2);
      expect(hasError()).toBe(false);
      expect(alert()).toBeNull();
      expect(fixture.nativeElement.querySelector('gf-benchmark')).toBeTruthy();
    });

    it('stays in the failed state when the retry fails too', async () => {
      watchlistResponses = [
        throwError(() => ({ status: 500 })),
        throwError(() => ({ status: 503 }))
      ];

      await createComponent();

      retryButton().click();
      fixture.detectChanges();

      expect(hasError()).toBe(true);
      expect(retryButton()).toBeTruthy();
    });

    it('reports the failure without disclosing the watchlist', async () => {
      watchlistResponses = [
        throwError(() => ({
          status: 500,
          url: '/api/v1/watchlist'
        }))
      ];

      await createComponent();

      expect(reports).toEqual([['GF-WATCHLIST-FETCH-FAILED (status 500)']]);
      expect(JSON.stringify(reports)).not.toContain('/api/v1/watchlist');
    });
  });

  describe('opening the create form', () => {
    it('hands over what is already watched', async () => {
      watchlistResponses = [
        of({
          watchlist: [
            {
              dataSource: 'YAHOO',
              marketCondition: 'ALL_TIME_HIGH',
              symbol: 'AAPL'
            },
            { dataSource: 'MANUAL', symbol: 'MSFT' }
          ]
        })
      ];

      await createComponent();

      queryParams.next({ createWatchlistItemDialog: true });

      // Only the identity of each entry: it is a repeat check, not a copy of the
      // table.
      expect(dialogOpen.mock.calls[0][1].data.existingItems).toEqual([
        { dataSource: 'YAHOO', symbol: 'AAPL' },
        { dataSource: 'MANUAL', symbol: 'MSFT' }
      ]);
    });

    it('hands over an empty list when the watchlist could not be read', async () => {
      watchlistResponses = [throwError(() => ({ status: 500 }))];

      await createComponent();

      queryParams.next({ createWatchlistItemDialog: true });

      // Nothing is known to be watched, so nothing is claimed to be. The dialog then
      // sends the create and lets the server be the authority.
      expect(dialogOpen.mock.calls[0][1].data.existingItems).toEqual([]);
    });

    it('opens once for a request that is re-observed', async () => {
      await createComponent();

      queryParams.next({ createWatchlistItemDialog: true });
      // What another module writing to the URL looks like from here: the same
      // request arriving again because parameters are merged, not replaced.
      queryParams.next({
        createWatchlistItemDialog: true,
        holdingDetailDialog: true
      });

      expect(dialogOpen).toHaveBeenCalledTimes(1);
    });
  });

  describe('closing the create form', () => {
    it('re-reads the list when the dialog added something', async () => {
      await createComponent();

      dialogAfterClosed = of({ dataSource: 'YAHOO', symbol: 'AAPL' });

      queryParams.next({ createWatchlistItemDialog: true });

      expect(fetchWatchlist).toHaveBeenCalledTimes(2);
    });

    it('reads nothing again when the dialog was dismissed', async () => {
      await createComponent();

      dialogAfterClosed = of(undefined);

      queryParams.next({ createWatchlistItemDialog: true });

      // The dialog closes with a result only once the create succeeded, so an empty
      // close means the list cannot have changed.
      expect(fetchWatchlist).toHaveBeenCalledTimes(1);
    });

    it('clears only the parameter the dialog travelled on', async () => {
      await createComponent();

      queryParams.next({ createWatchlistItemDialog: true });

      expect(navigate).toHaveBeenCalledWith([], {
        queryParams: { createWatchlistItemDialog: null },
        queryParamsHandling: 'merge',
        relativeTo: expect.anything()
      });
    });
  });

  describe('naming itself to the benchmark table', () => {
    it('declares which module a detail request belongs to', async () => {
      await createComponent();

      // Three modules mount this table and all three can be on the canvas at once,
      // all three observe the same parameters, and the request used to say nothing
      // about which of them it was for.
      expect(component.benchmarkDialogModule).toBe(
        DashboardModuleType.WATCHLIST
      );
    });
  });
});
