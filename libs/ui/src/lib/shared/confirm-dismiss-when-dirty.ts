import { ESCAPE } from '@angular/cdk/keycodes';
import { DestroyRef } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatDialogRef } from '@angular/material/dialog';

import { NotificationService } from '../notifications/notification.service';

/**
 * Stops a dialog with unsaved edits from being dismissed by accident.
 *
 * A Material dialog closes on a backdrop click and on Escape, and it does so silently and
 * irreversibly: every one of this application's form dialogs would discard a part-filled
 * activity, a typed account name or a composed note on a single stray click beside the
 * dialog, with nothing asked and nothing recoverable. The dialogs are large, so the
 * backdrop is a narrow margin around a wide target - and Escape is a key people press to
 * dismiss an autocomplete panel, not necessarily the dialog behind it.
 *
 * What this does NOT do is block those two routes out, which would be its own defect: a
 * viewer who wants to abandon a form must be able to. It asks first, and only when there
 * is something to lose. A pristine dialog closes exactly as it always did, with no
 * confirmation, because there is nothing to confirm.
 *
 * Wiring it requires taking `disableClose` over from Material, since the dialog has to
 * stay open long enough to ask. Both routes are then handled explicitly, and the close is
 * performed here once the question is answered.
 *
 * Dependencies are passed rather than injected inside, so this can be called from
 * `ngOnInit` as readily as from a constructor - these dialogs are split between
 * constructor injection and field injection - and so a test can exercise it without
 * standing up an injection context.
 *
 * @param aParams.destroyRef the caller's own `DestroyRef`, so both subscriptions end with
 * the dialog rather than outliving it.
 * @param aParams.dialogRef the dialog to guard. Its `disableClose` is taken over.
 * @param aParams.isDirty answers whether there is anything to lose. A function rather
 * than a value because it is asked at dismissal time, not at wiring time.
 * @param aParams.notificationService opens the confirmation.
 */
export function confirmDismissWhenDirty({
  destroyRef,
  dialogRef,
  isDirty,
  notificationService
}: {
  destroyRef: DestroyRef;
  dialogRef: MatDialogRef<unknown>;
  isDirty: () => boolean;
  notificationService: NotificationService;
}): void {
  // Taken over from Material, because a dialog that closes itself the moment the backdrop
  // is clicked leaves nothing to ask about. Every dismissal below closes it explicitly.
  dialogRef.disableClose = true;

  const dismiss = () => {
    if (!isDirty()) {
      dialogRef.close();

      return;
    }

    notificationService.confirm({
      confirmFn: () => {
        dialogRef.close();
      },
      // The confirmation must not itself be dismissible by the same gesture that reached
      // it, or a viewer clicking twice in the same place discards the form after all.
      disableClose: true,
      title: $localize`Do you really want to discard your changes?`
    });
  };

  dialogRef
    .backdropClick()
    .pipe(takeUntilDestroyed(destroyRef))
    .subscribe(() => {
      dismiss();
    });

  dialogRef
    .keydownEvents()
    .pipe(takeUntilDestroyed(destroyRef))
    .subscribe((event) => {
      if (event.keyCode !== ESCAPE || hasOpenPopup(event.target)) {
        return;
      }

      // Material would have closed the dialog on this key, so the browser's own default
      // for it is no longer wanted either.
      event.preventDefault();

      dismiss();
    });
}

/**
 * Whether the key was pressed on a control whose own popup was open, and which therefore
 * has first claim on Escape.
 *
 * A viewer pressing Escape over an open autocomplete or select panel is dismissing THAT
 * panel, not the dialog behind it, so the dialog must not act on the same key.
 *
 * The obvious test - `event.defaultPrevented` - looks right and is wrong, which is worth
 * recording because it reads as the more robust of the two. Angular Material's
 * autocomplete trigger calls `preventDefault()` for Escape UNCONDITIONALLY, before it
 * looks at whether its panel is open at all, to suppress the browser's native
 * revert-the-input behaviour. So the flag is set on every Escape the field ever sees, and
 * deferring on it made Escape appear dead: measured at runtime, the first press closed the
 * panel and every press after it did nothing whatsoever while focus stayed in the field.
 * The only way out was to move focus first.
 *
 * `aria-expanded` answers the question actually being asked, and it is the control's own
 * public statement about its popup rather than a private detail. It also reads correctly
 * at this point in the dispatch: Material binds the attribute, so it is written during
 * change detection, which is queued and therefore has not run yet while this listener is
 * still on the bubbling path. The value seen here is the state as the key was pressed -
 * open for the press that closes the panel, closed for the next one.
 */
function hasOpenPopup(aTarget: EventTarget | null): boolean {
  return (
    aTarget instanceof Element &&
    aTarget.getAttribute('aria-expanded') === 'true'
  );
}
