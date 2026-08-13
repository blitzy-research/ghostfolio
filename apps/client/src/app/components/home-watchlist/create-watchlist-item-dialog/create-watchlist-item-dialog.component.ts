import { reportSanitizedError } from '@ghostfolio/common/helper';
import type { AssetProfileIdentifier } from '@ghostfolio/common/interfaces';
import { DataService } from '@ghostfolio/ui/services';
import { GfSymbolAutocompleteComponent } from '@ghostfolio/ui/symbol-autocomplete';

import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  DestroyRef,
  inject
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  FormControl,
  FormGroup,
  FormsModule,
  ReactiveFormsModule,
  ValidationErrors,
  Validators
} from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import {
  MatDialogModule,
  MatDialogRef,
  MAT_DIALOG_DATA
} from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';

import {
  CreateWatchlistItemDialogParams,
  CreateWatchlistItemForm
} from './interfaces/interfaces';

/**
 * The stable event identifier a failed watchlist create is reported under.
 *
 * Fixed so it stays searchable, and carrying the reason only - never the response -
 * because what a viewer chooses to watch is their own business.
 */
const WATCHLIST_ITEM_CREATE_FAILED_EVENT = 'GF-WATCHLIST-ITEM-CREATE-FAILED';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'h-100' },
  imports: [
    FormsModule,
    GfSymbolAutocompleteComponent,
    MatButtonModule,
    MatDialogModule,
    MatFormFieldModule,
    ReactiveFormsModule
  ],
  selector: 'gf-create-watchlist-item-dialog',
  styleUrls: ['./create-watchlist-item-dialog.component.scss'],
  templateUrl: 'create-watchlist-item-dialog.html'
})
export class GfCreateWatchlistItemDialogComponent {
  /**
   * What went wrong with the last attempt, rendered beside the control that made it.
   *
   * The request used to be issued by the MODULE, after this dialog had already
   * closed. A rejection therefore had nowhere to be shown and nothing to be shown
   * about: the dialog was gone, the symbol the viewer had picked was gone with it,
   * and the watchlist simply looked unchanged. Owning the request here is what makes
   * a failure recoverable - the dialog stays open, holding the selection, and says
   * what happened.
   */
  protected errorMessage: string;

  /** Whether a create is in flight, so the control cannot be pressed twice. */
  protected isCreating = false;

  protected readonly createWatchlistItemForm: CreateWatchlistItemForm =
    new FormGroup(
      {
        searchSymbol: new FormControl<AssetProfileIdentifier | null>(null, [
          Validators.required
        ])
      },
      {
        validators: this.validator
      }
    );

  private readonly changeDetectorRef = inject(ChangeDetectorRef);
  private readonly dataService = inject(DataService);
  private readonly data =
    inject<CreateWatchlistItemDialogParams>(MAT_DIALOG_DATA);
  private readonly destroyRef = inject(DestroyRef);
  private readonly dialogRef =
    inject<MatDialogRef<GfCreateWatchlistItemDialogComponent>>(MatDialogRef);

  protected onCancel() {
    this.dialogRef.close();
  }

  /**
   * Adds the selected symbol to the watchlist, and closes ONLY once that worked.
   *
   * A repeat is answered without asking the server at all. The endpoint stores an
   * entry idempotently, so a duplicate create succeeds and changes nothing - which
   * read to the viewer as the dialog closing and their watchlist ignoring them. The
   * viewer's current list is handed in for exactly this, so the dialog can say the
   * symbol is already there and leave the selection in place to be changed.
   */
  protected onSubmit() {
    if (this.isCreating) {
      return;
    }

    const { dataSource, symbol } =
      this.createWatchlistItemForm.controls.searchSymbol.value ?? {};

    if (!dataSource || !symbol) {
      return;
    }

    const isAlreadyWatched = (this.data.existingItems ?? []).some((item) => {
      return item.dataSource === dataSource && item.symbol === symbol;
    });

    if (isAlreadyWatched) {
      this.errorMessage = $localize`${symbol} is already on your watchlist.`;

      this.changeDetectorRef.markForCheck();

      return;
    }

    this.errorMessage = undefined;
    this.isCreating = true;

    this.changeDetectorRef.markForCheck();

    this.dataService
      .postWatchlistItem({ dataSource, symbol })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        error: (error: unknown) => {
          // Held open on purpose. The selection is the expensive part - it took a
          // search to find - so discarding it in order to report the failure would
          // make the report cost more than the failure did.
          this.errorMessage = $localize`${symbol} could not be added to your watchlist. Please try again.`;
          this.isCreating = false;

          reportSanitizedError(WATCHLIST_ITEM_CREATE_FAILED_EVENT, error);

          this.changeDetectorRef.markForCheck();
        },
        next: () => {
          this.isCreating = false;

          this.dialogRef.close({ dataSource, symbol });
        }
      });
  }

  private validator(control: CreateWatchlistItemForm): ValidationErrors {
    const searchSymbolControl = control.controls.searchSymbol;

    if (
      searchSymbolControl.valid &&
      searchSymbolControl.value?.dataSource &&
      searchSymbolControl.value?.symbol
    ) {
      return { incomplete: false };
    }

    return { incomplete: true };
  }
}
