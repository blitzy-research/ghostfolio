import { NotificationService } from '@ghostfolio/ui/notifications';
import { DataService } from '@ghostfolio/ui/services';

import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { Account } from '@prisma/client';
import { Observable, Subject, of, throwError } from 'rxjs';

import { GfTransferBalanceDialogComponent } from './transfer-balance-dialog.component';

/**
 * The cash transfer dialog.
 *
 * Two defects met here, and both came from the transfer being issued somewhere else. The
 * accounts module used to submit it from `afterClosed` - so a refusal arrived after this
 * dialog had gone, with the two accounts and the amount gone with it, and the module had
 * already cleared its own list to show a loading state that the failure branch never
 * lifted. A rejected transfer therefore removed the rows and left the module animating a
 * skeleton for good, over a transfer that had not happened.
 *
 * And the amount was only checked for being present. `0` and `-50` both passed to a
 * server that refuses both, which turned a rule the form could have stated into a round
 * trip whose answer arrived too late to act on.
 */
describe('GfTransferBalanceDialogComponent', () => {
  let component: GfTransferBalanceDialogComponent;
  let fixture: ComponentFixture<GfTransferBalanceDialogComponent>;
  let close: jest.Mock;
  let reports: unknown[][];
  let transferAccountBalance: jest.Mock;

  let backdropClicks: Subject<MouseEvent>;
  let confirm: jest.Mock;
  let dialogRef: {
    backdropClick: () => Observable<MouseEvent>;
    close: jest.Mock;
    disableClose: boolean;
    keydownEvents: () => Observable<KeyboardEvent>;
  };
  let keydownEvents: Subject<KeyboardEvent>;

  const accounts = [
    { currency: 'USD', id: 'account-a', name: 'Account A' },
    { currency: 'CHF', id: 'account-b', name: 'Account B' }
  ] as unknown as Account[];

  const createComponent = async ({
    transferResponse = of({})
  }: { transferResponse?: Observable<unknown> } = {}) => {
    close = jest.fn();
    confirm = jest.fn();
    reports = [];
    transferAccountBalance = jest.fn(() => transferResponse);

    // The two routes out of a Material dialog that are not a button. The component takes
    // `disableClose` over so it can ask before discarding a part-filled form, and answers
    // both of these itself - so a stub carrying only `close` is no longer enough to stand
    // the component up, and these Subjects are what let the guard be driven from a test.
    backdropClicks = new Subject<MouseEvent>();
    keydownEvents = new Subject<KeyboardEvent>();
    dialogRef = {
      backdropClick: () => backdropClicks.asObservable(),
      close,
      disableClose: false,
      keydownEvents: () => keydownEvents.asObservable()
    };

    jest.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      reports.push(args);
    });

    TestBed.resetTestingModule();

    await TestBed.configureTestingModule({
      imports: [GfTransferBalanceDialogComponent],
      providers: [
        provideNoopAnimations(),
        { provide: DataService, useValue: { transferAccountBalance } },
        { provide: MAT_DIALOG_DATA, useValue: { accounts } },
        { provide: MatDialogRef, useValue: dialogRef },
        { provide: NotificationService, useValue: { confirm } }
      ]
    }).compileComponents();

    fixture = TestBed.createComponent(GfTransferBalanceDialogComponent);
    component = fixture.componentInstance;

    fixture.detectChanges();

    return component;
  };

  const fill = ({
    balance = 100,
    fromAccount = 'account-a',
    toAccount = 'account-b'
  }: {
    balance?: number | string;
    fromAccount?: string;
    toAccount?: string;
  } = {}) => {
    component.transferBalanceForm.patchValue({
      balance,
      fromAccount,
      toAccount
    });

    fixture.detectChanges();
  };

  const submit = () => {
    component.onSubmit();

    fixture.detectChanges();
  };

  const errorMessage = () => {
    return (component as unknown as { errorMessage: string }).errorMessage;
  };

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('the amount', () => {
    it.each([
      ['zero', 0],
      ['a negative amount', -50]
    ])('refuses %s before the server has to', async (_label, balance) => {
      await createComponent();

      fill({ balance });

      expect(
        component.transferBalanceForm.get('balance').hasError('notPositive')
      ).toBe(true);
      expect(component.transferBalanceForm.valid).toBe(false);
    });

    it('says so where the amount was entered', async () => {
      await createComponent();

      fill({ balance: -50 });

      // Material shows a subscript error only once the control has been interacted
      // with, which is what leaving the field does.
      component.transferBalanceForm.get('balance').markAsTouched();

      fixture.detectChanges();

      const error = fixture.nativeElement.querySelector('mat-error');

      expect(error.textContent.trim()).toBe(
        'Please enter an amount greater than zero.'
      );
    });

    it('accepts a positive amount', async () => {
      await createComponent();

      fill({ balance: 0.01 });

      expect(component.transferBalanceForm.valid).toBe(true);
    });

    it('leaves an empty amount to the required rule, rather than reporting twice', async () => {
      await createComponent();

      fill({ balance: '' });

      const balanceControl = component.transferBalanceForm.get('balance');

      expect(balanceControl.hasError('required')).toBe(true);
      expect(balanceControl.hasError('notPositive')).toBe(false);
    });

    it('sends nothing while the form is invalid', async () => {
      await createComponent();

      fill({ balance: -50 });
      submit();

      expect(transferAccountBalance).not.toHaveBeenCalled();
      expect(close).not.toHaveBeenCalled();
    });
  });

  describe('the two accounts', () => {
    it('refuses a transfer to the same account', async () => {
      await createComponent();

      fill({ fromAccount: 'account-a', toAccount: 'account-a' });

      expect(component.transferBalanceForm.hasError('invalid')).toBe(true);
    });

    it('shows the source account currency beside the amount', async () => {
      await createComponent();

      fill({ fromAccount: 'account-b' });

      expect(component.currency).toBe('CHF');
    });

    it('survives an identifier that matches no account', async () => {
      await createComponent();

      // The previous form threw outright here, which an empty list or a stale
      // identifier from a deleted account both produced.
      fill({ fromAccount: 'account-gone' });

      expect(component.currency).toBeUndefined();
    });
  });

  describe('a transfer that succeeds', () => {
    it('issues the request itself and closes', async () => {
      await createComponent();

      fill();
      submit();

      expect(transferAccountBalance).toHaveBeenCalledWith({
        accountIdFrom: 'account-a',
        accountIdTo: 'account-b',
        balance: 100
      });
      expect(close).toHaveBeenCalledWith(true);
    });
  });

  describe('a transfer that is refused', () => {
    it('keeps the dialog, and both accounts and the amount with it', async () => {
      await createComponent({
        transferResponse: throwError(() => ({ status: 500 }))
      });

      fill();
      submit();

      expect(close).not.toHaveBeenCalled();
      expect(component.transferBalanceForm.value).toEqual({
        balance: 100,
        fromAccount: 'account-a',
        toAccount: 'account-b'
      });
    });

    it('says that nothing was moved', async () => {
      await createComponent({
        transferResponse: throwError(() => ({ status: 500 }))
      });

      fill();
      submit();

      // The one fact that matters most after a failed transfer of money.
      expect(errorMessage()).toBe(
        'The cash balance could not be transferred. Nothing has been moved. Please try again.'
      );
    });

    it('names a rejected amount precisely, because that can be corrected', async () => {
      await createComponent({
        transferResponse: throwError(() => ({ status: 400 }))
      });

      fill();
      submit();

      expect(errorMessage()).toBe(
        'This transfer was not accepted. Please check the accounts and the amount.'
      );
    });

    it('announces the failure beside the fields', async () => {
      await createComponent({
        transferResponse: throwError(() => ({ status: 500 }))
      });

      fill();
      submit();

      const alert = fixture.nativeElement.querySelector('[role="alert"]');

      expect(alert).toBeTruthy();
      expect(alert.textContent).toContain('Nothing has been moved.');
    });

    it('lets the viewer submit the same transfer again', async () => {
      await createComponent({
        transferResponse: throwError(() => ({ status: 500 }))
      });

      fill();
      submit();
      submit();

      expect(transferAccountBalance).toHaveBeenCalledTimes(2);
    });

    it('reports the failure without naming the accounts or the amount', async () => {
      await createComponent({
        transferResponse: throwError(() => ({
          status: 500,
          url: '/api/v1/account/transfer-balance'
        }))
      });

      fill();
      submit();

      expect(reports).toEqual([['GF-TRANSFER-BALANCE-FAILED (status 500)']]);
      expect(JSON.stringify(reports)).not.toContain('account-a');
    });
  });

  describe('what it refuses to do twice', () => {
    it('sends one request for two presses', async () => {
      await createComponent({ transferResponse: new Observable() });

      fill();
      submit();

      expect(
        (component as unknown as { isTransferring: boolean }).isTransferring
      ).toBe(true);

      submit();

      // Money. One press, one movement.
      expect(transferAccountBalance).toHaveBeenCalledTimes(1);
    });
  });

  /**
   * A Material dialog closes on a backdrop click and on Escape, silently and
   * irreversibly. These dialogs are wide, so the backdrop is a narrow margin around a
   * large target, and Escape is a key people press to dismiss an autocomplete panel
   * rather than the dialog behind it - so both routes discarded a part-filled form on a
   * gesture that was not a decision.
   *
   * The point of the guard is that it asks rather than refuses: a viewer who wants to
   * abandon the form still can, and a pristine dialog still closes without a question,
   * because there is nothing to confirm.
   */
  describe('being dismissed with something typed', () => {
    /**
     * Marks the form dirty the way a viewer typing into it would.
     *
     * `patchValue` deliberately does NOT set `dirty` - Angular reserves it for user
     * interaction - so filling the form in a test leaves it pristine, and the guard would
     * correctly see nothing to lose. This is the distinction the guard turns on, so it is
     * stated rather than implied.
     */
    const type = () => {
      fill();

      component.transferBalanceForm.markAsDirty();
    };

    /**
     * An Escape keydown carrying a real element as its target, with the attributes given.
     *
     * The guard decides from the target's own `aria-expanded`, so the target has to be an
     * element rather than the `null` a bare `KeyboardEvent` carries. `target` is read-only
     * on a synthetic event, hence the redefine.
     */
    const escapeOn = (aAttributes: Record<string, string>) => {
      const target = document.createElement('input');

      for (const [name, value] of Object.entries(aAttributes)) {
        target.setAttribute(name, value);
      }

      const event = new KeyboardEvent('keydown', {
        cancelable: true,
        keyCode: 27
      } as KeyboardEventInit);

      Object.defineProperty(event, 'target', { value: target });

      return event;
    };

    it('takes disableClose over, so it can ask', async () => {
      await createComponent();

      expect(dialogRef.disableClose).toBe(true);
    });

    it('closes a pristine dialog on a backdrop click without asking', async () => {
      await createComponent();

      backdropClicks.next(new MouseEvent('click'));

      expect(confirm).not.toHaveBeenCalled();
      expect(close).toHaveBeenCalledTimes(1);
    });

    it('asks before discarding a dirty dialog, and does not close yet', async () => {
      await createComponent();

      type();

      backdropClicks.next(new MouseEvent('click'));

      expect(confirm).toHaveBeenCalledTimes(1);
      expect(confirm.mock.calls[0][0].title).toBe(
        'Do you really want to discard your changes?'
      );
      expect(close).not.toHaveBeenCalled();
    });

    it('closes once the discard is confirmed', async () => {
      await createComponent();

      type();

      backdropClicks.next(new MouseEvent('click'));

      confirm.mock.calls[0][0].confirmFn();

      expect(close).toHaveBeenCalledTimes(1);
    });

    it('asks on Escape too', async () => {
      await createComponent();

      type();

      keydownEvents.next(
        new KeyboardEvent('keydown', { keyCode: 27 } as KeyboardEventInit)
      );

      expect(confirm).toHaveBeenCalledTimes(1);
    });

    it('leaves Escape alone while the control it was pressed on has a popup open', async () => {
      await createComponent();

      type();

      // A viewer pressing Escape over an open autocomplete or select panel is dismissing
      // THAT panel, and closing the dialog underneath it is not what they asked for. The
      // control states the panel is open through `aria-expanded`, which is what makes this
      // answerable from the event alone.
      keydownEvents.next(escapeOn({ 'aria-expanded': 'true' }));

      expect(confirm).not.toHaveBeenCalled();
      expect(close).not.toHaveBeenCalled();
    });

    it('asks on Escape once that popup has closed, even though the key still arrives handled', async () => {
      await createComponent();

      type();

      // The regression this pins: Angular Material's autocomplete trigger calls
      // `preventDefault()` for Escape UNCONDITIONALLY, before it considers whether its
      // panel is open. Deferring on `defaultPrevented` therefore made Escape appear dead
      // for every press after the one that closed the panel, for as long as focus stayed
      // in the field. The panel being closed is what decides it, not the flag.
      const event = escapeOn({ 'aria-expanded': 'false' });

      event.preventDefault();

      keydownEvents.next(event);

      expect(confirm).toHaveBeenCalledTimes(1);
    });

    it('asks on Escape pressed on a control that has no popup at all', async () => {
      await createComponent();

      type();

      keydownEvents.next(escapeOn({}));

      expect(confirm).toHaveBeenCalledTimes(1);
    });

    it('ignores any other key', async () => {
      await createComponent();

      type();

      keydownEvents.next(
        new KeyboardEvent('keydown', { keyCode: 13 } as KeyboardEventInit)
      );

      expect(confirm).not.toHaveBeenCalled();
      expect(close).not.toHaveBeenCalled();
    });
  });
});
