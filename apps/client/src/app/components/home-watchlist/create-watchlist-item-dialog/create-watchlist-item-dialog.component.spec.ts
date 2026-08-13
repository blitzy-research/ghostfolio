import { DataService } from '@ghostfolio/ui/services';

import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { Observable, of, throwError } from 'rxjs';

import { GfCreateWatchlistItemDialogComponent } from './create-watchlist-item-dialog.component';
import { CreateWatchlistItemDialogParams } from './interfaces/interfaces';

/**
 * The dialog that adds an asset to the watchlist.
 *
 * It owns the request, and that ownership is the fix. The module used to issue the
 * create AFTER this dialog had closed, which made every failure unrecoverable in two
 * ways at once: there was no dialog left to report it in, and the symbol the viewer
 * had searched for was discarded along with it - so a rejected create presented as a
 * watchlist that simply ignored them.
 *
 * A repeat is answered without a request at all. The endpoint stores an entry
 * idempotently, so asking it to add something already watched succeeds and changes
 * nothing, which read exactly like the failure case: dialog closed, list unchanged.
 */
describe('GfCreateWatchlistItemDialogComponent', () => {
  let component: GfCreateWatchlistItemDialogComponent;
  let fixture: ComponentFixture<GfCreateWatchlistItemDialogComponent>;
  let close: jest.Mock;
  let postWatchlistItem: jest.Mock;

  /**
   * Everything the component wrote to the error console.
   *
   * Collected rather than let through for two reasons: a deliberate report is not a
   * test failure and should not read like one, and what a report CONTAINS is itself
   * a subject here - a watchlist create carries the symbol a viewer chose, and the
   * console is readable by every script on the page.
   */
  let reports: unknown[][];

  beforeEach(() => {
    reports = [];

    jest.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      reports.push(args);
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const createComponent = async ({
    existingItems = [],
    postResponse = of({})
  }: {
    existingItems?: CreateWatchlistItemDialogParams['existingItems'];
    postResponse?: Observable<unknown>;
  } = {}) => {
    close = jest.fn();
    postWatchlistItem = jest.fn(() => postResponse);

    TestBed.resetTestingModule();

    await TestBed.configureTestingModule({
      imports: [GfCreateWatchlistItemDialogComponent],
      providers: [
        provideNoopAnimations(),
        {
          provide: DataService,
          // The symbol search shares this facade, and reaches it only once the
          // viewer types. This spec is about what happens AFTER a symbol is chosen,
          // so it never does - but the method is answered anyway rather than left to
          // fail obscurely if that ever changes.
          useValue: { fetchSymbols: () => of([]), postWatchlistItem }
        },
        {
          provide: MAT_DIALOG_DATA,
          useValue: { deviceType: 'desktop', existingItems, locale: 'en' }
        },
        { provide: MatDialogRef, useValue: { close } }
      ]
    }).compileComponents();

    fixture = TestBed.createComponent(GfCreateWatchlistItemDialogComponent);
    component = fixture.componentInstance;

    fixture.detectChanges();

    return component;
  };

  /** Chooses a symbol, the way the autocomplete does when the viewer picks one. */
  const selectSymbol = (symbol = 'AAPL') => {
    const form = (
      component as unknown as {
        createWatchlistItemForm: {
          controls: { searchSymbol: { setValue: (value: unknown) => void } };
        };
      }
    ).createWatchlistItemForm;

    form.controls.searchSymbol.setValue({ dataSource: 'YAHOO', symbol });

    fixture.detectChanges();
  };

  const submit = () => {
    (component as unknown as { onSubmit: () => void }).onSubmit();

    fixture.detectChanges();
  };

  const errorMessage = () => {
    return (component as unknown as { errorMessage: string }).errorMessage;
  };

  const isCreating = () => {
    return (component as unknown as { isCreating: boolean }).isCreating;
  };

  describe('a create that succeeds', () => {
    it('issues the request itself and closes with what it added', async () => {
      await createComponent();

      selectSymbol();
      submit();

      expect(postWatchlistItem).toHaveBeenCalledTimes(1);
      expect(postWatchlistItem).toHaveBeenCalledWith({
        dataSource: 'YAHOO',
        symbol: 'AAPL'
      });
      expect(close).toHaveBeenCalledWith({
        dataSource: 'YAHOO',
        symbol: 'AAPL'
      });
      expect(errorMessage()).toBeUndefined();
    });
  });

  describe('a create that fails', () => {
    /**
     * The whole point of moving the request in here: the dialog survives the
     * failure, so there is somewhere to say what happened and the selection is
     * still there to resubmit.
     */
    it('keeps the dialog open and says what happened', async () => {
      await createComponent({
        postResponse: throwError(() => ({ status: 500 }))
      });

      selectSymbol();
      submit();

      expect(close).not.toHaveBeenCalled();
      expect(errorMessage()).toBe(
        'AAPL could not be added to your watchlist. Please try again.'
      );
      expect(isCreating()).toBe(false);
    });

    it('keeps the symbol the viewer chose', async () => {
      await createComponent({
        postResponse: throwError(() => ({ status: 500 }))
      });

      selectSymbol();
      submit();

      const value = (
        component as unknown as {
          createWatchlistItemForm: {
            controls: { searchSymbol: { value: { symbol: string } } };
          };
        }
      ).createWatchlistItemForm.controls.searchSymbol.value;

      // The selection cost a search to produce, so discarding it in order to report
      // the failure would make the report cost more than the failure did.
      expect(value).toEqual({ dataSource: 'YAHOO', symbol: 'AAPL' });
    });

    it('reports the failure without naming what was being watched', async () => {
      await createComponent({
        postResponse: throwError(() => ({
          message: 'Internal Server Error',
          status: 500,
          url: '/api/v1/watchlist'
        }))
      });

      selectSymbol();
      submit();

      expect(reports).toEqual([
        ['GF-WATCHLIST-ITEM-CREATE-FAILED (status 500)']
      ]);

      // The symbol belongs to the viewer, and the console does not.
      expect(JSON.stringify(reports)).not.toContain('AAPL');
      expect(JSON.stringify(reports)).not.toContain('/api/v1/watchlist');
    });

    it('lets the viewer try the same symbol again', async () => {
      await createComponent({
        postResponse: throwError(() => ({ status: 500 }))
      });

      selectSymbol();
      submit();
      submit();

      expect(postWatchlistItem).toHaveBeenCalledTimes(2);
      expect(close).not.toHaveBeenCalled();
    });
  });

  describe('a symbol that is already watched', () => {
    it('is explained rather than sent', async () => {
      await createComponent({
        existingItems: [{ dataSource: 'YAHOO', symbol: 'AAPL' }]
      });

      selectSymbol();
      submit();

      // Not sent at all. The endpoint would have accepted it and changed nothing,
      // which is what made a duplicate indistinguishable from success.
      expect(postWatchlistItem).not.toHaveBeenCalled();
      expect(close).not.toHaveBeenCalled();
      expect(errorMessage()).toBe('AAPL is already on your watchlist.');
    });

    it('still admits a different symbol', async () => {
      await createComponent({
        existingItems: [{ dataSource: 'YAHOO', symbol: 'AAPL' }]
      });

      selectSymbol('MSFT');
      submit();

      expect(postWatchlistItem).toHaveBeenCalledWith({
        dataSource: 'YAHOO',
        symbol: 'MSFT'
      });
      expect(close).toHaveBeenCalledWith({
        dataSource: 'YAHOO',
        symbol: 'MSFT'
      });
    });

    it('is not reported as a fault', async () => {
      await createComponent({
        existingItems: [{ dataSource: 'YAHOO', symbol: 'AAPL' }]
      });

      selectSymbol();
      submit();

      // Nothing failed. The viewer asked for something they already have, and was
      // told so - an ordinary answer, not an incident.
      expect(reports).toEqual([]);
    });

    it('matches on the data source as well as the symbol', async () => {
      await createComponent({
        existingItems: [{ dataSource: 'MANUAL', symbol: 'AAPL' }]
      });

      selectSymbol();
      submit();

      // Same symbol, different provider: a genuinely different asset profile, so it
      // is not the one already being watched.
      expect(postWatchlistItem).toHaveBeenCalledTimes(1);
    });
  });

  describe('how the failure reaches the viewer', () => {
    it('is announced beside the control that produced it', async () => {
      await createComponent({
        postResponse: throwError(() => ({ status: 500 }))
      });

      selectSymbol();
      submit();

      const alert = fixture.nativeElement.querySelector('[role="alert"]');

      // An alert rather than a status: the viewer asked for something and did not
      // get it, so it is worth interrupting them for.
      expect(alert).toBeTruthy();
      expect(alert.textContent.trim()).toBe(
        'AAPL could not be added to your watchlist. Please try again.'
      );
    });

    it('says nothing at all until something has gone wrong', async () => {
      await createComponent();

      expect(fixture.nativeElement.querySelector('[role="alert"]')).toBeNull();
    });

    it('marks the submit control busy while the create is in flight', async () => {
      await createComponent({ postResponse: new Observable() });

      selectSymbol();
      submit();

      const submitButton = fixture.nativeElement.querySelector(
        'button[type="submit"]'
      );

      expect(submitButton.getAttribute('aria-busy')).toBe('true');
      expect(submitButton.disabled).toBe(true);
    });
  });

  describe('what it refuses to do', () => {
    it('sends nothing when no symbol has been chosen', async () => {
      await createComponent();

      submit();

      expect(postWatchlistItem).not.toHaveBeenCalled();
      expect(close).not.toHaveBeenCalled();
    });

    it('sends one request for two presses of the same submit', async () => {
      // A request that never settles, which is the window a second press lands in.
      await createComponent({ postResponse: new Observable() });

      selectSymbol();
      submit();

      expect(isCreating()).toBe(true);

      submit();

      expect(postWatchlistItem).toHaveBeenCalledTimes(1);
    });

    it('closes with nothing when cancelled', async () => {
      await createComponent();

      selectSymbol();

      (component as unknown as { onCancel: () => void }).onCancel();

      expect(close).toHaveBeenCalledWith();
      expect(postWatchlistItem).not.toHaveBeenCalled();
    });
  });
});
