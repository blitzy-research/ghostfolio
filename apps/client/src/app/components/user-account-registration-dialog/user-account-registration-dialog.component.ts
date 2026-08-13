import { reportSanitizedError } from '@ghostfolio/common/helper';
import { publicRoutes } from '@ghostfolio/common/routes/routes';
import { DataService } from '@ghostfolio/ui/services';

import { ClipboardModule } from '@angular/cdk/clipboard';
import { TextFieldModule } from '@angular/cdk/text-field';
import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  CUSTOM_ELEMENTS_SCHEMA,
  DestroyRef,
  ElementRef,
  Inject,
  ViewChild
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule, ReactiveFormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MAT_DIALOG_DATA, MatDialogModule } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatStepper, MatStepperModule } from '@angular/material/stepper';
import { IonIcon } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import {
  arrowForwardOutline,
  checkmarkOutline,
  copyOutline
} from 'ionicons/icons';

// A value import rather than `import type`, matching every other dialog in this
// folder that has a suite. Angular's constructor-parameter downlevelling emits the
// annotated type by name, so a type-only import leaves that reference unresolvable
// and instantiating the component throws a `ReferenceError` before any assertion
// runs. The declaration is still an interface and still erased from the output; only
// the module reference survives.
import { UserAccountRegistrationDialogParams } from './interfaces/interfaces';

/**
 * The stable event identifier a failed account creation is reported under.
 *
 * Fixed, because it is what makes the event searchable in a log that outlives the
 * attempt, and because the alternative - repeating what the server said - would put
 * a response body into the console of the one screen a brand-new visitor is looking
 * at.
 */
const USER_ACCOUNT_CREATION_FAILED_EVENT = 'GF-USER-ACCOUNT-CREATION-FAILED';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    ClipboardModule,
    FormsModule,
    IonIcon,
    MatButtonModule,
    MatCheckboxModule,
    MatDialogModule,
    MatFormFieldModule,
    MatInputModule,
    MatStepperModule,
    ReactiveFormsModule,
    TextFieldModule
  ],
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
  selector: 'gf-user-account-registration-dialog',
  styleUrls: ['./user-account-registration-dialog.scss'],
  templateUrl: 'user-account-registration-dialog.html'
})
export class GfUserAccountRegistrationDialogComponent {
  @ViewChild(MatStepper) stepper!: MatStepper;

  /**
   * The field holding the security token.
   *
   * Read so the token can be given focus the moment it appears, and so the visitor
   * lands on the one thing this step exists to hand over. Optional in practice: the
   * field belongs to a step that does not exist until the account does.
   */
  @ViewChild('accessTokenField')
  accessTokenField?: ElementRef<HTMLTextAreaElement>;

  public accessToken: string;

  /**
   * What was last announced about the security token, for assistive technology.
   *
   * Copying used to report nothing at all. The token is disclosed exactly once and
   * copying it is the only realistic way to keep it, so a visitor who could not see
   * the button change had no way to tell a copy that worked from one that silently
   * did not - and the consequence of getting that wrong is an account that cannot
   * be recovered.
   */
  public accessTokenAnnouncement = '';

  public authToken: string;

  /**
   * Whether the attempt to create the account failed.
   *
   * Needed because the control is disabled while a request is in flight: without a
   * reported failure the visitor would be left looking at a dialog whose only
   * action had gone permanently quiet, which is a worse outcome than the double
   * submission the guard exists to prevent.
   */
  public hasCreationError = false;

  public isCreateAccountButtonDisabled = true;

  /**
   * Whether the account is being created right now.
   *
   * The step that creates the account cannot advance until the response arrives -
   * it needs the security token the response carries - so without this the control
   * stays live for the whole round trip. A second press then creates a *second*
   * account, and because only the last response is rendered, the first one becomes
   * an account nobody can reach: its security token was minted, shown to nobody
   * and is unrecoverable by design.
   */
  public isCreatingAccount = false;

  public isDisclaimerChecked = false;
  public role: string;
  public termsOfServiceUrl = `https://ghostfol.io/${document.documentElement.lang}/${publicRoutes.about.path}/${publicRoutes.about.subRoutes.termsOfService.path}`;

  public constructor(
    private changeDetectorRef: ChangeDetectorRef,
    @Inject(MAT_DIALOG_DATA) public data: UserAccountRegistrationDialogParams,
    private dataService: DataService,
    private destroyRef: DestroyRef
  ) {
    addIcons({ arrowForwardOutline, checkmarkOutline, copyOutline });
  }

  /**
   * Creates the account.
   *
   * This is the request, and the control that calls it is labelled accordingly.
   * That labelling is the whole of the fix it carries: the account used to be
   * created by a button reading "Continue" while a later one reading "Create
   * Account" issued nothing at all - it only closed the dialog - so a visitor who
   * stopped at the token step believed they had created nothing and had in fact
   * created everything.
   *
   * Moving the request to that later control is not available: the security token
   * shown on the next step is *minted by* this response and is disclosed exactly
   * once, so there is nothing to show until the account exists. Ordering the two
   * steps the other way would need a server that reserves a token before the
   * account, which is a change to the account-creation API rather than to this
   * dialog.
   *
   * Guarded against a second entry while the first is in flight. Not defensive
   * decoration: this step cannot advance until the response arrives, so the control
   * is live for the whole round trip, and a second press mints a second account
   * whose token is then overwritten unseen.
   */
  public createAccount() {
    if (this.isCreatingAccount) {
      return;
    }

    this.hasCreationError = false;
    this.isCreatingAccount = true;

    this.dataService
      .postUser()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        error: (error: unknown) => {
          // Released, so the visitor can try again rather than being left with a
          // dialog that no longer does anything. The event identifier is fixed and
          // the response is not repeated into it: this failure happens before any
          // account exists, and what the server said about the attempt is for the
          // log the server keeps.
          this.hasCreationError = true;
          this.isCreatingAccount = false;

          reportSanitizedError(USER_ACCOUNT_CREATION_FAILED_EVENT, error);

          this.changeDetectorRef.markForCheck();
        },
        next: ({ accessToken, authToken, role }) => {
          this.accessToken = accessToken;
          this.authToken = authToken;
          this.role = role;

          // Deliberately left raised. The step is not editable and the account now
          // exists, so there is no second creation to make from here; releasing the
          // flag would only re-arm a control the visitor has already left behind.
          this.stepper.next();

          this.changeDetectorRef.markForCheck();

          this.focusAccessToken();
        }
      });
  }

  public enableCreateAccountButton() {
    this.isCreateAccountButtonDisabled = false;
  }

  /**
   * Reports the outcome of copying the security token.
   *
   * Both outcomes are reported, because the failure is the one that matters: the
   * copy can be refused by the platform - a document without focus, or a browser
   * withholding clipboard access - and it fails silently when it does. A visitor
   * who believes they have saved this token and has not cannot recover the account
   * it belongs to, so an unreported failure here is unrecoverable rather than
   * merely unhelpful.
   *
   * Announced through a live region rather than a notification, because the token
   * is on screen and being told about it must not move the visitor away from it.
   */
  public onAccessTokenCopied(aIsCopied: boolean) {
    this.accessTokenAnnouncement = aIsCopied
      ? $localize`The security token was copied to the clipboard.`
      : $localize`The security token could not be copied. Please select it and copy it manually.`;

    this.changeDetectorRef.markForCheck();
  }

  public onChangeDislaimerChecked() {
    this.isDisclaimerChecked = !this.isDisclaimerChecked;
  }

  /**
   * Moves focus to the security token once the step showing it is rendered.
   *
   * Deferred by a frame rather than called directly: the step is created by the
   * advance immediately above, so the field does not exist yet at the point the
   * response is handled. Wrapped defensively because focus is a courtesy - a
   * platform that refuses it must not turn a created account into a thrown error on
   * the one screen showing an unrecoverable token.
   */
  private focusAccessToken() {
    requestAnimationFrame(() => {
      try {
        this.accessTokenField?.nativeElement?.focus();
      } catch {
        // Intentionally ignored. The token is rendered and selectable either way,
        // and reporting a refused focus call would say nothing anybody can act on.
      }
    });
  }
}
