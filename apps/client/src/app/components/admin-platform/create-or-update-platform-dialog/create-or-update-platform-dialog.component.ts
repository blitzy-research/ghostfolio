import { CreatePlatformDto, UpdatePlatformDto } from '@ghostfolio/common/dtos';
import { validateObjectForForm } from '@ghostfolio/common/utils';
import { GfEntityLogoComponent } from '@ghostfolio/ui/entity-logo';
import { NotificationService } from '@ghostfolio/ui/notifications';
import { confirmDismissWhenDirty } from '@ghostfolio/ui/shared/confirm-dismiss-when-dirty';

import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  DestroyRef,
  Inject
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
import { debounceTime } from 'rxjs/operators';

import type { CreateOrUpdatePlatformDialogParams } from './interfaces/interfaces';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'h-100' },
  imports: [
    FormsModule,
    GfEntityLogoComponent,
    MatButtonModule,
    MatDialogModule,
    MatFormFieldModule,
    MatInputModule,
    ReactiveFormsModule
  ],
  selector: 'gf-create-or-update-platform-dialog',
  styleUrls: ['./create-or-update-platform-dialog.scss'],
  templateUrl: 'create-or-update-platform-dialog.html'
})
export class GfCreateOrUpdatePlatformDialogComponent {
  /**
   * Whether a submission is already under way.
   *
   * Explicit, because the safety that stood in for it was accidental. Every one of these
   * dialogs validates asynchronously before closing, so a second press lands in that gap
   * and runs the whole submission again - and the only thing that stopped two of them
   * taking effect was `MatDialogRef.close` ignoring its second call. That is a detail of
   * a library this code does not own, it is invisible where the risk is, and it protects
   * nothing on the paths that do their own writing.
   */
  protected isSubmitting = false;

  /**
   * The URL the logo preview is fetched for, which is deliberately NOT the live control.
   *
   * The preview used to bind straight to the control's value, so every keystroke in the
   * URL field produced a new `<gf-entity-logo>` URL and therefore a new request: typing
   * `https://www.example.com` issued more than twenty, all but the last of them for a
   * prefix that was never a real address. This settles for a moment first, so one URL is
   * fetched once - the same 300 ms a viewer's own pause between words already takes.
   */
  protected settledLogoUrl: string;

  public platformForm: FormGroup;

  public constructor(
    @Inject(MAT_DIALOG_DATA) public data: CreateOrUpdatePlatformDialogParams,
    public dialogRef: MatDialogRef<GfCreateOrUpdatePlatformDialogComponent>,
    private changeDetectorRef: ChangeDetectorRef,
    private destroyRef: DestroyRef,
    private notificationService: NotificationService,
    private formBuilder: FormBuilder
  ) {
    this.platformForm = this.formBuilder.group({
      name: [this.data.platform.name, Validators.required],
      url: [this.data.platform.url ?? 'https://', Validators.required]
    });

    // Seeded from the value the dialog opened with, so an existing platform shows its
    // logo immediately rather than only after the first edit.
    this.settledLogoUrl = this.platformForm.get('url')?.value as string;

    this.platformForm
      .get('url')
      ?.valueChanges.pipe(
        debounceTime(300),
        takeUntilDestroyed(this.destroyRef)
      )
      .subscribe((url: string) => {
        this.settledLogoUrl = url;

        this.changeDetectorRef.markForCheck();
      });

    // Asked before the form is thrown away. A backdrop click or Escape used to discard
    // whatever had been typed here silently and irreversibly.
    confirmDismissWhenDirty({
      destroyRef: this.destroyRef,
      dialogRef: this.dialogRef,
      isDirty: () => this.platformForm?.dirty === true,
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

    try {
      const platform: CreatePlatformDto | UpdatePlatformDto = {
        name: this.platformForm.get('name')?.value,
        url: this.platformForm.get('url')?.value
      };

      if (this.data.platform.id) {
        (platform as UpdatePlatformDto).id = this.data.platform.id;
        await validateObjectForForm({
          classDto: UpdatePlatformDto,
          form: this.platformForm,
          object: platform
        });
      } else {
        await validateObjectForForm({
          classDto: CreatePlatformDto,
          form: this.platformForm,
          object: platform
        });
      }

      this.dialogRef.close(platform);
    } catch (error) {
      // Released, because this dialog stays open for the viewer to correct the form.
      this.isSubmitting = false;

      console.error(error);
    }
  }
}
