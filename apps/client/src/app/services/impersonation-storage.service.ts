import { KEY_STORAGE_IMPERSONATION_ID } from '@ghostfolio/common/config';

import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';

/**
 * Re-exported rather than declared, so this key has exactly one definition.
 *
 * The shared data facade needs the same key to tell whether two overlapping reads
 * were issued under the same impersonation, and `libs/ui` may not import from
 * `apps/client`, so the literal itself lives in `@ghostfolio/common/config`. The
 * local name is kept because it is what the call sites in this application already
 * import.
 */
export const IMPERSONATION_KEY = KEY_STORAGE_IMPERSONATION_ID;

@Injectable({
  providedIn: 'root'
})
export class ImpersonationStorageService {
  private hasImpersonationChangeSubject = new BehaviorSubject<string>(
    this.getId()
  );

  public getId(): string {
    return window.localStorage.getItem(IMPERSONATION_KEY);
  }

  public onChangeHasImpersonation() {
    return this.hasImpersonationChangeSubject.asObservable();
  }

  public removeId() {
    window.localStorage.removeItem(IMPERSONATION_KEY);

    this.hasImpersonationChangeSubject.next(null);
  }

  public setId(aId: string) {
    window.localStorage.setItem(IMPERSONATION_KEY, aId);

    this.hasImpersonationChangeSubject.next(aId);
  }
}
