import { reportSanitizedError } from '@ghostfolio/common/helper';
import { GfEntityLogoComponent } from '@ghostfolio/ui/entity-logo';
import { NotificationService } from '@ghostfolio/ui/notifications';
import { DataService } from '@ghostfolio/ui/services';
import { confirmDismissWhenDirty } from '@ghostfolio/ui/shared/confirm-dismiss-when-dirty';

import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  DestroyRef,
  inject
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  AbstractControl,
  FormBuilder,
  FormGroup,
  FormGroupDirective,
  NgForm,
  ReactiveFormsModule,
  ValidationErrors,
  Validators
} from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { ErrorStateMatcher } from '@angular/material/core';
import {
  MAT_DIALOG_DATA,
  MatDialogModule,
  MatDialogRef
} from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { Account } from '@prisma/client';

import type { TransferBalanceDialogParams } from './interfaces/interfaces';

/**
 * The stable event identifier a failed cash transfer is reported under.
 *
 * Fixed so it stays searchable, and carrying the reason only - never the response -
 * because a transfer names two of the viewer's accounts and an amount.
 */
const TRANSFER_BALANCE_FAILED_EVENT = 'GF-TRANSFER-BALANCE-FAILED';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'h-100' },
  imports: [
    GfEntityLogoComponent,
    MatButtonModule,
    MatDialogModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    ReactiveFormsModule
  ],
  selector: 'gf-transfer-balance-dialog',
  styleUrls: ['./transfer-balance-dialog.scss'],
  templateUrl: 'transfer-balance-dialog.html'
})
export class GfTransferBalanceDialogComponent {
  public accounts: Account[] = [];
  public currency: string;

  /**
   * Puts the destination field into an error state when the FORM GROUP is what is
   * invalid, so the cross-field rule can be seen.
   *
   * This is the difference between writing the message and the message appearing.
   * Angular Material decides whether to render a field's `mat-error` children from that
   * field's own error state, and the default matcher asks only about the control:
   * `control.invalid && (control.touched || form.submitted)`. `compareAccounts` is a
   * validator on the group, so its error sits on the group and BOTH accounts stay
   * individually valid - which measured at runtime as a dialog containing zero
   * `mat-error` elements, three empty live regions and a disabled Transfer button, with
   * the reason stated nowhere at all. The rule was enforced and silent.
   *
   * The group is reached through `control.parent` rather than through a closure over the
   * component, so the matcher has no lifecycle of its own and cannot outlive the form it
   * describes. `touched` is still required, so simply opening the dialog does not paint
   * a field red before anything has been chosen.
   */
  protected readonly accountErrorStateMatcher: ErrorStateMatcher = {
    isErrorState: (
      control: AbstractControl | null,
      form: FormGroupDirective | NgForm | null
    ) => {
      if (!control) {
        return false;
      }

      const hasBeenInteractedWith = control.touched || !!form?.submitted;

      return (
        hasBeenInteractedWith &&
        (control.invalid || !!control.parent?.hasError('invalid'))
      );
    }
  };

  /**
   * Why the last transfer did not go through, stated inside the dialog.
   *
   * The transfer used to be issued by the accounts module, from `afterClosed` - so a
   * refusal arrived after this dialog had gone, with the two accounts and the amount
   * gone with it. All the viewer got was an alert saying the transfer had failed, over a
   * module that had cleared its own list to show a loading state it would never leave.
   */
  protected errorMessage: string;

  /** Whether a transfer is in flight, so the control cannot be pressed twice. */
  protected isTransferring = false;

  public transferBalanceForm: FormGroup;

  /**
   * What this dialog was opened with.
   *
   * Taken through `inject` rather than as a constructor parameter: the parameter form
   * makes Angular's runtime reflection depend on `TransferBalanceDialogParams` being a
   * real value, and it is an interface imported with `import type`, so it is erased at
   * emit.
   */
  public readonly data = inject<TransferBalanceDialogParams>(MAT_DIALOG_DATA);

  public readonly dialogRef =
    inject<MatDialogRef<GfTransferBalanceDialogComponent>>(MatDialogRef);

  private readonly changeDetectorRef = inject(ChangeDetectorRef);
  private readonly dataService = inject(DataService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly notificationService = inject(NotificationService);
  private readonly formBuilder = inject(FormBuilder);

  public ngOnInit() {
    this.accounts = this.data.accounts ?? [];

    this.transferBalanceForm = this.formBuilder.group(
      {
        balance: [
          '',
          // The amount has to be a POSITIVE number, and saying so here is the point.
          // Only `required` was checked, so `0` and `-50` passed to a server that
          // refuses both - and the refusal arrived after the dialog had closed, which
          // is the least useful moment for it. The rule is stated where it can be
          // acted on instead.
          [Validators.required, GfTransferBalanceDialogComponent.positiveAmount]
        ],
        fromAccount: ['', Validators.required],
        toAccount: ['', Validators.required]
      },
      {
        validators: this.compareAccounts
      }
    );

    this.transferBalanceForm
      .get('fromAccount')
      .valueChanges.pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((id) => {
        // Read defensively. The account is looked up by identifier and the previous
        // form threw outright when it was not found - which an empty list, or a
        // stale identifier from a deleted account, both produce.
        this.currency = this.accounts.find((account) => {
          return account.id === id;
        })?.currency;

        this.changeDetectorRef.markForCheck();
      });

    // Asked before the form is thrown away. A backdrop click or Escape used to discard
    // whatever had been typed here silently and irreversibly.
    confirmDismissWhenDirty({
      destroyRef: this.destroyRef,
      dialogRef: this.dialogRef,
      isDirty: () => this.transferBalanceForm?.dirty === true,
      notificationService: this.notificationService
    });
  }

  public onCancel() {
    this.dialogRef.close();
  }

  /**
   * Transfers the amount, and closes ONLY once that worked.
   *
   * The reason a refusal is reported in here rather than by the module: the two accounts
   * and the amount are still on the screen, so the viewer can read what went wrong and
   * correct or resubmit it without reconstructing anything. The module is left alone
   * entirely, which is what stops a failed transfer from emptying its list.
   */
  public onSubmit() {
    if (this.isTransferring || this.transferBalanceForm.invalid) {
      return;
    }

    this.errorMessage = undefined;
    this.isTransferring = true;

    this.changeDetectorRef.markForCheck();

    this.dataService
      .transferAccountBalance({
        accountIdFrom: this.transferBalanceForm.get('fromAccount').value,
        accountIdTo: this.transferBalanceForm.get('toAccount').value,
        balance: this.transferBalanceForm.get('balance').value
      })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        error: (error: unknown) => {
          this.errorMessage = this.getErrorMessage(error);
          this.isTransferring = false;

          reportSanitizedError(TRANSFER_BALANCE_FAILED_EVENT, error);

          this.changeDetectorRef.markForCheck();
        },
        next: () => {
          this.isTransferring = false;

          // Closed with a plain acknowledgement: all the module needs to know is that
          // something changed and it should read its accounts again.
          this.dialogRef.close(true);
        }
      });
  }

  /**
   * What to say about a refused transfer.
   *
   * A rejected amount is worth naming precisely, because it is something the viewer can
   * fix in the field above without guessing. Anything else is deliberately generic - a
   * server message is not written for this dialog and may name internals - and states
   * the one fact that matters most: no cash moved.
   */
  private getErrorMessage(aError: unknown) {
    const status = (aError as { status?: number })?.status;

    if (status === 400) {
      return $localize`This transfer was not accepted. Please check the accounts and the amount.`;
    }

    return $localize`The cash balance could not be transferred. Nothing has been moved. Please try again.`;
  }

  private compareAccounts(control: AbstractControl): ValidationErrors {
    const accountFrom = control.get('fromAccount');
    const accountTo = control.get('toAccount');

    if (accountFrom.value === accountTo.value) {
      return { invalid: true };
    }
  }

  /**
   * Rejects an amount that is not greater than zero.
   *
   * `Validators.min(0)` would admit `0`, and a transfer of nothing is what the server
   * refuses, so the comparison is strict. An empty control is left to `required` rather
   * than reported twice.
   */
  private static positiveAmount(control: AbstractControl): ValidationErrors {
    const value = control.value;

    if (value === '' || value === null || value === undefined) {
      return null;
    }

    return Number(value) > 0 ? null : { notPositive: true };
  }
}
