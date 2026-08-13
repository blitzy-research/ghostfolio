import { reportSanitizedError } from '@ghostfolio/common/helper';
import { NotificationService } from '@ghostfolio/ui/notifications';

import { inject, Injectable } from '@angular/core';

/**
 * Resolves a dialog's own chunk on demand, once, and tells the viewer when that
 * cannot be done.
 *
 * The application splits its bundle at dynamic `import()` boundaries rather than at
 * route boundaries, so each dialog that reaches a large graph of its own is loaded
 * at the point it is opened. That makes opening one a network request: it can be
 * slow and it can fail.
 *
 * Deduplicating those requests, reporting a rejection and releasing the pending
 * entry are therefore handled here rather than at every call site, because a
 * per-site copy is a per-site opportunity to omit one.
 *
 * It resolves the dialog's COMPONENT and opens nothing. Which dialog to open, with
 * what data and what to do with its result stays with the caller, which is what
 * keeps this free of any knowledge of the dialogs it loads.
 *
 * Placed in `core/` alongside the other application-wide collaborators, and free of
 * any import from `dashboard/` so that a module can open a dialog without
 * depending on the canvas layer.
 */
@Injectable({ providedIn: 'root' })
export class LazyDialogService {
  /**
   * The attempts currently in flight, keyed by caller-supplied name.
   *
   * Held on the service rather than in each component because the duplication
   * worth preventing is across components as well as within one: the shell and the
   * signed-out prompt both open the account registration dialog, and two
   * simultaneous requests for it should cost one chunk request.
   *
   * Bounded by the number of distinct dialogs the application can open, and each
   * entry is removed as soon as its attempt settles, so this holds at most one
   * entry per dialog currently being resolved.
   */
  private readonly attempts = new Map<string, Promise<unknown>>();

  private readonly notificationService = inject(NotificationService);

  /**
   * Whether an attempt for this key is still resolving.
   *
   * Exposed so a caller can reflect the wait in its own UI - disabling the control
   * that started it - without keeping a second copy of the state this map already
   * holds.
   *
   * @param aKey the same key the attempt was started with.
   */
  public isLoading(aKey: string): boolean {
    return this.attempts.has(aKey);
  }

  /**
   * Resolves a dialog component, sharing one attempt per key.
   *
   * @param aKey a stable, data-free name for the dialog being resolved. It keys the
   * deduplication and identifies the failure in the sanitized report, so two
   * different dialogs must never share one and it must never carry viewer data.
   * @param aLoad performs the dynamic `import()` and picks the component out of the
   * resolved module. Called at most once per key while an attempt is outstanding.
   * @returns the component, or `null` when the chunk could not be loaded - in which
   * case the viewer has already been told, and the caller's only remaining
   * obligation is to abandon whatever it was about to open.
   */
  public load<T>(aKey: string, aLoad: () => Promise<T>): Promise<T | null> {
    const outstanding = this.attempts.get(aKey);

    // Compared against `undefined` rather than tested for truthiness, because the
    // value is a promise: a bare condition on one is the mistake that silently
    // treats a rejected or pending promise as "true and done with".
    if (outstanding !== undefined) {
      return outstanding as Promise<T | null>;
    }

    const attempt = aLoad()
      .catch((error: unknown) => {
        // Reported and shown, in that order and both deliberately. The report is
        // data-free and searchable; the alert is what stops the viewer staring at a
        // control that appeared to do nothing. The message is one this application
        // already translates, so no locale gains an untranslated string.
        reportSanitizedError(`GF-LAZY-DIALOG-LOAD-FAILED-${aKey}`, error);

        this.notificationService.alert({
          title: $localize`Oops! Something went wrong.`
        });

        // Resolved rather than rethrown: the caller has nothing left to decide, and
        // a rejection escaping here would be the unhandled rejection this exists to
        // remove.
        return null;
      })
      .finally(() => {
        // Released however the attempt settled, so a failure does not make the
        // affordance permanently inert. Safe against a later attempt for the same
        // key, because a settled entry is only ever the one this call created: a
        // second call while this was outstanding was handed this very promise and
        // created no entry of its own.
        this.attempts.delete(aKey);
      });

    this.attempts.set(aKey, attempt);

    return attempt;
  }
}
