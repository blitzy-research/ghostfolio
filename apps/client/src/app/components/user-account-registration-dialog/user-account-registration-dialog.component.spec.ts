import { DataService } from '@ghostfolio/ui/services';

import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { Observable, of, throwError } from 'rxjs';

import { GfUserAccountRegistrationDialogComponent } from './user-account-registration-dialog.component';

/**
 * Which control creates the account, and how many accounts one visitor can end up
 * with.
 *
 * The flow has an ordering nothing can change: the security token shown on the
 * second step is *minted by* the account-creation response and disclosed exactly
 * once, so the account has to exist before that step can be drawn. What was wrong
 * was not the ordering but what the controls claimed - the account was created by a
 * button reading "Continue", while the button reading "Create Account" one step
 * later issued no request at all and merely closed the dialog. A visitor who
 * stopped at the token step therefore believed they had created nothing, and had in
 * fact created an account holding a token they never saved and cannot recover.
 *
 * Labels are ordinarily not worth a test. These are, because the label *is* the
 * fix: the request has not moved and cannot, so the only thing standing between the
 * visitor and a misunderstanding is which control says what. A future edit that
 * swaps them back would compile, render, and reintroduce the whole finding.
 *
 * The second half is the account nobody can reach. The creating step cannot advance
 * until the response arrives, so the control is live for the entire round trip, and
 * a second press mints a second account whose token overwrites the first unseen.
 * The guard against that necessarily brings a failure path with it: a control
 * disabled for the duration of a request that then fails silently would leave the
 * visitor holding a dialog that no longer does anything, which is worse than the
 * double submission.
 */
describe('GfUserAccountRegistrationDialogComponent', () => {
  let close: jest.Mock;
  let component: GfUserAccountRegistrationDialogComponent;
  let consoleError: jest.SpyInstance;
  let fixture: ComponentFixture<GfUserAccountRegistrationDialogComponent>;
  let postUser: jest.Mock;

  /** What the account-creation request answers with, per test. */
  let postUserResult: Observable<unknown>;

  const createdAccount = {
    accessToken: 'a-security-token',
    authToken: 'a-session-token',
    role: 'USER'
  };

  const host = () => fixture.nativeElement as HTMLElement;

  /** The button a visitor would press by reading it. */
  const buttonLabelled = (label: string) => {
    return Array.from(host().querySelectorAll('button')).find((button) => {
      return button.textContent?.trim() === label;
    });
  };

  /** Every control carrying a label, so "exactly one says this" is assertable. */
  const buttonsLabelled = (label: string) => {
    return Array.from(host().querySelectorAll('button')).filter((button) => {
      return button.textContent?.trim() === label;
    });
  };

  /** The reported failure, one rendered line per entry. */
  const alertLines = () => {
    const notice = host().querySelector('[role="alert"]');

    return notice
      ? Array.from(notice.children).map((line) => line.textContent.trim())
      : undefined;
  };

  /**
   * Copies the security token the way a visitor does.
   *
   * Through the control rather than by calling the handler: the component is
   * `OnPush`, so a field assigned from outside the template leaves the view
   * unpainted and the terminal control stays disabled in the DOM - a click on it
   * would then do nothing for a reason that has nothing to do with the code under
   * test.
   */
  const copySecurityToken = () => {
    buttonLabelled('Copy to clipboard').click();

    fixture.detectChanges();
  };

  /**
   * Brings the dialog to the state a visitor is in when they have read the
   * disclaimer: the creating control is enabled and nothing has been requested.
   */
  const acceptDisclaimer = () => {
    component.onChangeDislaimerChecked();

    fixture.detectChanges();
  };

  const createComponent = async () => {
    close = jest.fn();
    postUser = jest.fn(() => postUserResult);

    // Reset first, so a test that needs a different response can build a second
    // dialog: configuring an already-instantiated testing module throws.
    TestBed.resetTestingModule();

    await TestBed.configureTestingModule({
      imports: [GfUserAccountRegistrationDialogComponent],
      providers: [
        provideNoopAnimations(),
        {
          provide: MAT_DIALOG_DATA,
          useValue: { deviceType: 'desktop', needsToAcceptTermsOfService: true }
        },
        { provide: DataService, useValue: { postUser } },
        // The terminal control closes through `[mat-dialog-close]`, so the
        // reference is what records the hand-off rather than a spy on the class.
        { provide: MatDialogRef, useValue: { close } }
      ]
    }).compileComponents();

    fixture = TestBed.createComponent(GfUserAccountRegistrationDialogComponent);
    component = fixture.componentInstance;

    fixture.detectChanges();

    return component;
  };

  beforeEach(async () => {
    consoleError = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    postUserResult = of(createdAccount);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('which control creates the account', () => {
    it('is the one labelled Create Account', async () => {
      await createComponent();
      acceptDisclaimer();

      buttonLabelled('Create Account').click();

      expect(postUser).toHaveBeenCalledTimes(1);
    });

    it('is the only control that says it creates an account', async () => {
      await createComponent();

      // The stepper keeps both step bodies in the document, so this is asserted as a
      // count rather than by looking at one step: whatever the visitor is currently
      // reading, exactly one control in this dialog claims to create the account,
      // and the test above proves it is the one that does.
      expect(buttonsLabelled('Create Account')).toHaveLength(1);
    });

    it('creates nothing until the disclaimer has been read', async () => {
      await createComponent();

      expect(buttonLabelled('Create Account').disabled).toBe(true);
    });
  });

  describe('the step that shows the security token', () => {
    beforeEach(async () => {
      await createComponent();
      acceptDisclaimer();

      buttonLabelled('Create Account').click();

      fixture.detectChanges();
    });

    it('is the step the dialog has moved to', () => {
      expect(component.stepper.selectedIndex).toBe(1);
    });

    it('offers a control labelled Continue, because the account already exists', () => {
      expect(buttonsLabelled('Continue')).toHaveLength(1);
    });

    it('issues no request when that control is pressed', () => {
      copySecurityToken();

      buttonLabelled('Continue').click();

      // Still the one request, made by the previous step. This control only hands
      // the session over.
      expect(postUser).toHaveBeenCalledTimes(1);
    });

    it('hands the session token to whoever opened the dialog', () => {
      copySecurityToken();

      buttonLabelled('Continue').click();

      expect(close).toHaveBeenCalledWith(createdAccount.authToken);
    });

    it('holds the security token back until it has been copied', () => {
      // Unchanged behaviour, asserted because the control's label moved: the token
      // is disclosed once, so leaving without it is unrecoverable.
      expect(buttonLabelled('Continue').disabled).toBe(true);
    });
  });

  describe('a visitor who presses twice', () => {
    it('gets one account, not two', async () => {
      await createComponent();
      acceptDisclaimer();

      const button = buttonLabelled('Create Account');

      button.click();
      button.click();

      // The second account would be unreachable: its security token is minted,
      // overwritten by the response that arrives after it, and shown to nobody.
      expect(postUser).toHaveBeenCalledTimes(1);
    });

    it('marks the control busy while the account is being created', async () => {
      // Held open, so the in-flight state can be observed rather than inferred.
      postUserResult = new Observable(() => undefined);

      await createComponent();
      acceptDisclaimer();

      buttonLabelled('Create Account').click();
      fixture.detectChanges();

      const button = buttonLabelled('Create Account');

      expect(button.disabled).toBe(true);
      expect(button.getAttribute('aria-busy')).toBe('true');
    });
  });

  describe('an account that could not be created', () => {
    beforeEach(async () => {
      postUserResult = throwError(() => ({ status: 503 }));

      await createComponent();
      acceptDisclaimer();

      buttonLabelled('Create Account').click();
      fixture.detectChanges();
    });

    it('says so', () => {
      expect(alertLines()).toEqual([
        'Oops! Something went wrong.',
        'Please try again later.'
      ]);
    });

    it('leaves the control usable, so the visitor can try again', () => {
      // Without this the guard above would be the defect: a control disabled for
      // the duration of a request that failed would never come back.
      expect(buttonLabelled('Create Account').disabled).toBe(false);
    });

    it('accepts a second attempt', async () => {
      postUserResult = of(createdAccount);

      buttonLabelled('Create Account').click();
      fixture.detectChanges();

      expect(postUser).toHaveBeenCalledTimes(2);
      expect(buttonLabelled('Continue')).toBeTruthy();
    });

    it('clears the report when the second attempt starts', () => {
      postUserResult = of(createdAccount);

      buttonLabelled('Create Account').click();
      fixture.detectChanges();

      expect(alertLines()).toBeUndefined();
    });

    it('reports an event and nothing the response carried', () => {
      // A brand-new visitor's very first screen. The identifier is what an operator
      // searches for; the body of a failed creation is for the log the server keeps.
      expect(consoleError).toHaveBeenCalledTimes(1);
      expect(consoleError).toHaveBeenCalledWith(
        'GF-USER-ACCOUNT-CREATION-FAILED (status 503)'
      );
    });

    it('discloses no security token, because none was issued', () => {
      expect(component.accessToken).toBeUndefined();
      expect(component.authToken).toBeUndefined();
      expect(close).not.toHaveBeenCalled();
    });
  });
});
