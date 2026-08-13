import type { AssetProfileIdentifier } from '@ghostfolio/common/interfaces';

import type { FormControl, FormGroup } from '@angular/forms';

export interface CreateWatchlistItemDialogParams {
  deviceType: string;

  /**
   * What the viewer is already watching.
   *
   * Passed in so a repeat can be recognised WITHOUT a request. The server stores a
   * watchlist entry idempotently, so asking it to add something already there
   * succeeds and changes nothing - the dialog closed, the list looked identical, and
   * the viewer was left to work out for themselves whether anything had happened.
   * Held by the module rather than the dialog, so it has to be handed over.
   */
  existingItems: AssetProfileIdentifier[];

  locale: string;
}

export type CreateWatchlistItemForm = FormGroup<{
  searchSymbol: FormControl<AssetProfileIdentifier | null>;
}>;
