import { CreateTagDto, UpdateTagDto } from '@ghostfolio/common/dtos';
import { validateObjectForForm } from '@ghostfolio/common/utils';
import { NotificationService } from '@ghostfolio/ui/notifications';
import { confirmDismissWhenDirty } from '@ghostfolio/ui/shared/confirm-dismiss-when-dirty';

import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  inject
} from '@angular/core';
import {
  AbstractControl,
  FormBuilder,
  FormGroup,
  FormsModule,
  ReactiveFormsModule,
  ValidationErrors,
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

import type { CreateOrUpdateTagDialogParams } from './interfaces/interfaces';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'h-100' },
  imports: [
    FormsModule,
    MatButtonModule,
    MatDialogModule,
    MatFormFieldModule,
    MatInputModule,
    ReactiveFormsModule
  ],
  selector: 'gf-create-or-update-tag-dialog',
  styleUrls: ['./create-or-update-tag-dialog.scss'],
  templateUrl: 'create-or-update-tag-dialog.html'
})
export class GfCreateOrUpdateTagDialogComponent {
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
   * What went wrong with the last submission, or `null` while nothing has.
   *
   * Held here rather than raised through the application-wide notice, because the
   * dialog stays open: the name that was refused is still in the field, and the
   * message has to sit beside it for the viewer to correct it. It is cleared on the
   * next submission so a corrected name is not accompanied by the old complaint.
   */
  protected errorMessage: string = null;

  /**
   * The parameters this dialog was opened with.
   *
   * Resolved through `inject` rather than declared as a constructor parameter, and that
   * is a correctness matter rather than a style one: the type is an interface imported
   * with `import type`, so as a parameter type it is ERASED at emit and Angular's
   * runtime reflection has nothing left to read. The ahead-of-time build never
   * reflects, so the failure appears only where the component is created at runtime
   * without it - which is to say, only ever in a test.
   */
  public readonly data = inject<CreateOrUpdateTagDialogParams>(MAT_DIALOG_DATA);

  private readonly destroyRef = inject(DestroyRef);
  private readonly notificationService = inject(NotificationService);

  public tagForm: FormGroup;

  public constructor(
    public dialogRef: MatDialogRef<GfCreateOrUpdateTagDialogComponent>,
    private formBuilder: FormBuilder
  ) {
    this.tagForm = this.formBuilder.group({
      // The name carried no validator at all, so Save became available on the first
      // keystroke and a name of nothing but spaces was accepted - a row in the tag table
      // with no visible label. `Validators.required` alone does not cover that: it treats
      // a string of spaces as present, which is why the blank check is separate and
      // compares the TRIMMED value.
      name: [
        this.data.tag.name,
        [Validators.required, GfCreateOrUpdateTagDialogComponent.nonBlankName]
      ]
    });

    // Asked before the form is thrown away. A backdrop click or Escape used to discard
    // whatever had been typed here silently and irreversibly.
    confirmDismissWhenDirty({
      destroyRef: this.destroyRef,
      dialogRef: this.dialogRef,
      isDirty: () => this.tagForm?.dirty === true,
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
    this.errorMessage = null;

    try {
      const tag: CreateTagDto | UpdateTagDto = {
        name: this.tagForm.get('name')?.value
      };

      // Refused here rather than by the store, and that is the point of it. A tag is
      // unique per owner, so a repeat is rejected either way - but the rejection used
      // to arrive after this dialog had closed and taken the typed name with it, and
      // for a global tag it does not arrive at all: Postgres treats the NULL owner of
      // two global tags as distinct, so a second tag with the same name is simply
      // created and the screen shows two rows nobody can tell apart. Checking before
      // closing names the collision while the name is still on screen to correct.
      const conflictingName = this.findConflictingName(tag.name);

      if (conflictingName) {
        // The name as STORED, not as typed. Naming the existing tag is what points the
        // viewer at the row already holding it - and it keeps the message stable under
        // the very input the comparison is deliberately lenient about, so typing
        // "  qa unique tag  " is not answered by quoting that back with its spaces.
        this.errorMessage = $localize`A tag named ${conflictingName} already exists.`;
        this.isSubmitting = false;

        return;
      }

      if (this.data.tag.id) {
        (tag as UpdateTagDto).id = this.data.tag.id;
        await validateObjectForForm({
          classDto: UpdateTagDto,
          form: this.tagForm,
          object: tag
        });
      } else {
        await validateObjectForForm({
          classDto: CreateTagDto,
          form: this.tagForm,
          object: tag
        });
      }

      this.dialogRef.close(tag);
    } catch (error) {
      // Released, because this dialog stays open for the viewer to correct the form.
      this.isSubmitting = false;

      console.error(error);
    }
  }

  /**
   * The existing name that collides with the given one, if any.
   *
   * Compared case-insensitively and after trimming, because two names differing only
   * in case or in surrounding space are indistinguishable in the list they end up in -
   * so refusing them here is the same service as refusing an exact repeat, even where
   * the database's own index would let one through.
   *
   * Returns the name rather than a boolean so the message can quote what is ALREADY
   * stored: the comparison is lenient by design, and echoing the typed value back
   * would report a name that does not appear anywhere in the list being complained
   * about.
   *
   * @param aName the name as typed.
   * @returns the colliding stored name, or `null` when there is none.
   */
  /**
   * Rejects a name that is empty once trimmed.
   *
   * Separate from `required` because `required` only asks whether the control has a
   * value, and a string of spaces has one. An empty control is left to `required` so the
   * viewer is not told two things about one field.
   *
   * @param aControl the name control.
   * @returns the error, or `null` when the name has some substance.
   */
  private static nonBlankName(aControl: AbstractControl): ValidationErrors {
    const value = aControl.value as string;

    if (value === '' || value === null || value === undefined) {
      return null;
    }

    return value.trim().length > 0 ? null : { blank: true };
  }

  private findConflictingName(aName: string) {
    const normalized = aName?.trim().toLowerCase();

    if (!normalized) {
      return null;
    }

    return (
      (this.data.existingNames ?? []).find((existingName) => {
        return existingName?.trim().toLowerCase() === normalized;
      }) ?? null
    );
  }
}
