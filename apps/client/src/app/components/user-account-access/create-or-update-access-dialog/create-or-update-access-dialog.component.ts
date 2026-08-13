import { CreateAccessDto, UpdateAccessDto } from '@ghostfolio/common/dtos';
import { validateObjectForForm } from '@ghostfolio/common/utils';
import { NotificationService } from '@ghostfolio/ui/notifications';
import { DataService } from '@ghostfolio/ui/services';
import { confirmDismissWhenDirty } from '@ghostfolio/ui/shared/confirm-dismiss-when-dirty';

import type { HttpErrorResponse } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  DestroyRef,
  inject,
  OnInit
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  FormBuilder,
  FormGroup,
  FormsModule,
  ReactiveFormsModule,
  Validators
} from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import {
  MAT_DIALOG_DATA,
  MatDialogModule,
  MatDialogRef
} from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { StatusCodes } from 'http-status-codes';
import { EMPTY, catchError } from 'rxjs';

import { CreateOrUpdateAccessDialogParams } from './interfaces/interfaces';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'h-100' },
  imports: [
    FormsModule,
    MatButtonModule,
    MatDialogModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    ReactiveFormsModule
  ],
  selector: 'gf-create-or-update-access-dialog',
  styleUrls: ['./create-or-update-access-dialog.scss'],
  templateUrl: 'create-or-update-access-dialog.html'
})
export class GfCreateOrUpdateAccessDialogComponent implements OnInit {
  /**
   * Whether a submission is already under way.
   *
   * Explicit here rather than incidental, and this is the dialog where the difference is
   * not academic: it issues the write ITSELF, so two presses send two requests and grant
   * or update access twice. Elsewhere in this codebase the same double press was absorbed
   * by `MatDialogRef.close` ignoring its second call - a detail of a library this code
   * does not own, which happens to protect the dialogs that only close and protects
   * nothing at all here.
   */
  protected isSubmitting = false;

  protected accessForm: FormGroup;
  protected mode: 'create' | 'update';

  private readonly changeDetectorRef = inject(ChangeDetectorRef);

  private readonly data =
    inject<CreateOrUpdateAccessDialogParams>(MAT_DIALOG_DATA);

  private readonly dataService = inject(DataService);
  private readonly destroyRef = inject(DestroyRef);

  private readonly dialogRef =
    inject<MatDialogRef<GfCreateOrUpdateAccessDialogComponent>>(MatDialogRef);

  private readonly formBuilder = inject(FormBuilder);
  private readonly notificationService = inject(NotificationService);

  public constructor() {
    this.mode = this.data.access?.id ? 'update' : 'create';
  }

  public ngOnInit() {
    const isPublic = this.data.access.type === 'PUBLIC';

    this.accessForm = this.formBuilder.group({
      alias: [this.data.access.alias],
      granteeUserId: [
        this.data.access.grantee,
        isPublic ? null : Validators.required
      ],
      permissions: [this.data.access.permissions[0], Validators.required],
      type: [
        { disabled: this.mode === 'update', value: this.data.access.type },
        Validators.required
      ]
    });

    this.accessForm
      .get('type')
      ?.valueChanges.pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((accessType) => {
        const granteeUserIdControl = this.accessForm.get('granteeUserId');
        const permissionsControl = this.accessForm.get('permissions');

        if (accessType === 'PRIVATE') {
          granteeUserIdControl?.setValidators(Validators.required);
        } else {
          granteeUserIdControl?.clearValidators();
          granteeUserIdControl?.setValue(null);
          permissionsControl?.setValue(this.data.access.permissions[0]);
        }

        granteeUserIdControl?.updateValueAndValidity();

        this.changeDetectorRef.markForCheck();
      });

    // Asked before the form is thrown away. A backdrop click or Escape used to discard
    // whatever had been typed here silently and irreversibly.
    confirmDismissWhenDirty({
      destroyRef: this.destroyRef,
      dialogRef: this.dialogRef,
      isDirty: () => this.accessForm?.dirty === true,
      notificationService: this.notificationService
    });
  }

  public onCancel() {
    this.dialogRef.close();
  }

  public async onSubmit() {
    if (this.isSubmitting) {
      return;
    }

    this.isSubmitting = true;

    if (this.mode === 'create') {
      await this.createAccess();
    } else {
      await this.updateAccess();
    }
  }

  private async createAccess() {
    const access: CreateAccessDto = {
      alias: this.accessForm.get('alias')?.value,
      granteeUserId: this.accessForm.get('granteeUserId')?.value,
      permissions: [this.accessForm.get('permissions')?.value]
    };

    try {
      await validateObjectForForm({
        classDto: CreateAccessDto,
        form: this.accessForm,
        object: access
      });

      this.dataService
        .postAccess(access)
        .pipe(
          catchError((error: HttpErrorResponse) => {
            // Released, because this dialog stays open on a refusal: the viewer keeps
            // the form they filled in and has to be able to submit it again.
            this.isSubmitting = false;

            this.changeDetectorRef.markForCheck();

            if (error.status === StatusCodes.BAD_REQUEST) {
              this.notificationService.alert({
                title: $localize`Oops! Could not grant access.`
              });
            }

            return EMPTY;
          }),
          takeUntilDestroyed(this.destroyRef)
        )
        .subscribe(() => {
          this.dialogRef.close(access);
        });
    } catch (error) {
      // Released, because the form is still on screen with a validation failure
      // reported into it.
      this.isSubmitting = false;

      this.changeDetectorRef.markForCheck();

      console.error(error);
    }
  }

  private async updateAccess() {
    const access: UpdateAccessDto = {
      alias: this.accessForm.get('alias')?.value,
      granteeUserId: this.accessForm.get('granteeUserId')?.value,
      id: this.data.access.id,
      permissions: [this.accessForm.get('permissions')?.value]
    };

    try {
      await validateObjectForForm({
        classDto: UpdateAccessDto,
        form: this.accessForm,
        object: access
      });

      this.dataService
        .putAccess(access)
        .pipe(
          catchError(({ status }: HttpErrorResponse) => {
            // See `createAccess`: released so a refused update can be resubmitted.
            this.isSubmitting = false;

            this.changeDetectorRef.markForCheck();

            if (status === StatusCodes.BAD_REQUEST) {
              this.notificationService.alert({
                title: $localize`Oops! Could not update access.`
              });
            }

            return EMPTY;
          }),
          takeUntilDestroyed(this.destroyRef)
        )
        .subscribe(() => {
          this.dialogRef.close(access);
        });
    } catch (error) {
      // Released, because the form is still on screen with a validation failure
      // reported into it.
      this.isSubmitting = false;

      this.changeDetectorRef.markForCheck();

      console.error(error);
    }
  }
}
