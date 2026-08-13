import { Injectable } from '@angular/core';
import ms from 'ms';

import { KEY_TOKEN } from './settings-storage.service';

/**
 * Marks that *this* browser started an external sign-in, so a token offered back
 * in the address bar can be told apart from one somebody sent.
 *
 * Session storage rather than local storage, and that choice is the whole
 * mechanism: session storage is scoped to the tab, and it survives the tab
 * navigating away to the identity provider and back, which is exactly the journey
 * a legitimate hand-off makes and exactly the journey a link pasted into a fresh
 * tab has not made.
 */
const KEY_EXTERNAL_SIGN_IN_STARTED_AT = 'externalSignInStartedAt';

/**
 * How long a started external sign-in stays redeemable.
 *
 * Long enough for a real sign-in, including choosing an account, typing a password
 * and answering a second factor. Short enough that an abandoned attempt does not
 * leave the browser willing to adopt a token for the rest of the session. The
 * server's own OpenID state expires on the same ten-minute schedule, so nothing
 * that is still redeemable there has become unredeemable here.
 */
const EXTERNAL_SIGN_IN_VALIDITY = ms('10 minutes');

@Injectable({
  providedIn: 'root'
})
export class TokenStorageService {
  public getToken(): string {
    return (
      window.sessionStorage.getItem(KEY_TOKEN) ||
      window.localStorage.getItem(KEY_TOKEN)
    );
  }

  /**
   * Records that an external sign-in was started from this browser.
   *
   * Called immediately before the browser leaves for the identity provider. What
   * is stored is a timestamp rather than a secret: it carries no authority of its
   * own, and its only job is to answer "did this tab ask for this?" when a token
   * comes back.
   */
  public markExternalSignInStarted() {
    window.sessionStorage.setItem(
      KEY_EXTERNAL_SIGN_IN_STARTED_AT,
      Date.now().toString()
    );
  }

  /**
   * Answers whether this browser started an external sign-in recently, and spends
   * the answer.
   *
   * Single-use by construction: the mark is removed whether or not it was still
   * valid, so one started sign-in authorises exactly one hand-off. A second token
   * offered afterwards - including the same URL reloaded - is refused.
   *
   * @returns whether a sign-in started from this browser within the validity
   * window.
   */
  public consumeExternalSignInMark(): boolean {
    const startedAt = window.sessionStorage.getItem(
      KEY_EXTERNAL_SIGN_IN_STARTED_AT
    );

    window.sessionStorage.removeItem(KEY_EXTERNAL_SIGN_IN_STARTED_AT);

    const startedAtMilliseconds = Number(startedAt);

    if (!startedAt || !Number.isFinite(startedAtMilliseconds)) {
      return false;
    }

    // A mark from the future is treated as no mark at all rather than as valid
    // forever, which is what a plain "now minus then is under the window" check
    // would have made of a clock that moved backwards.
    const age = Date.now() - startedAtMilliseconds;

    return age >= 0 && age <= EXTERNAL_SIGN_IN_VALIDITY;
  }

  public saveToken(token: string, staySignedIn = false) {
    if (staySignedIn) {
      window.localStorage.setItem(KEY_TOKEN, token);
    }

    window.sessionStorage.setItem(KEY_TOKEN, token);
  }
}
