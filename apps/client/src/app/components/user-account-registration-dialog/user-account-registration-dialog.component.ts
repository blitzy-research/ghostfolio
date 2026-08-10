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

  public accessToken: string;
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
        }
      });
  }

  public enableCreateAccountButton() {
    this.isCreateAccountButtonDisabled = false;
  }

  public onChangeDislaimerChecked() {
    this.isDisclaimerChecked = !this.isDisclaimerChecked;
  }
}
