import { KEY_STORAGE_AUTHORIZATION_TOKEN } from '@ghostfolio/common/config';

import { Injectable } from '@angular/core';

export const KEY_RANGE = 'range';
export const KEY_STAY_SIGNED_IN = 'staySignedIn';

/**
 * Re-exported rather than declared, so this key has exactly one definition.
 *
 * The shared data facade needs the same key to tell whether two overlapping reads
 * were issued as the same account, and `libs/ui` may not import from
 * `apps/client`, so the literal itself lives in `@ghostfolio/common/config`. The
 * local name is kept because it is what every call site in this application
 * already imports.
 */
export const KEY_TOKEN = KEY_STORAGE_AUTHORIZATION_TOKEN;

@Injectable({
  providedIn: 'root'
})
export class SettingsStorageService {
  public getSetting(aKey: string): string {
    return window.localStorage.getItem(aKey);
  }

  public removeSetting(aKey: string) {
    return window.localStorage.removeItem(aKey);
  }

  public setSetting(aKey: string, aValue: string) {
    window.localStorage.setItem(aKey, aValue);
  }
}
