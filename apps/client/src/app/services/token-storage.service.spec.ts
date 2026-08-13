import { KEY_TOKEN } from '@ghostfolio/client/services/settings-storage.service';

import { TestBed } from '@angular/core/testing';
import ms from 'ms';

import { TokenStorageService } from './token-storage.service';

/**
 * The proof that an external sign-in was started by *this* browser.
 *
 * The Google and OpenID Connect flows hand their result back through the address
 * bar, as `/<locale>/?jwt=<token>`, and a signed-out visitor's storage is empty. On
 * those two facts alone a link somebody sent is indistinguishable from the
 * provider's own hand-off, and adopting it signs the visitor into the *sender's*
 * account - where everything they subsequently enter is readable by the sender.
 *
 * These two methods are what tell the two apart. Every property they need is
 * asserted here, against real `sessionStorage`, because each one is load-bearing on
 * its own:
 *
 * - it must be absent by default, or every link is adoptable;
 * - it must survive being written and read back, or no legitimate sign-in completes;
 * - it must be spent on read, or one started sign-in authorises a reload and every
 *   later token too;
 * - it must expire, or an abandoned attempt leaves the tab willing to adopt for the
 *   rest of its session;
 * - and it must not be fooled by a clock that moved.
 */
describe('TokenStorageService', () => {
  const EXTERNAL_SIGN_IN_VALIDITY = ms('10 minutes');

  let tokenStorageService: TokenStorageService;

  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();

    TestBed.configureTestingModule({ providers: [TokenStorageService] });

    tokenStorageService = TestBed.inject(TokenStorageService);
  });

  afterEach(() => {
    jest.useRealTimers();

    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  describe('the external sign-in proof', () => {
    it('is absent until a sign-in is started', () => {
      // The default has to be refusal. A browser that has asked for nothing must
      // not be willing to adopt a credential offered to it.
      expect(tokenStorageService.consumeExternalSignInMark()).toBe(false);
    });

    it('is present once a sign-in has been started', () => {
      tokenStorageService.markExternalSignInStarted();

      expect(tokenStorageService.consumeExternalSignInMark()).toBe(true);
    });

    it('is spent on the first read', () => {
      tokenStorageService.markExternalSignInStarted();

      expect(tokenStorageService.consumeExternalSignInMark()).toBe(true);

      // Single use is what makes a reload of the hand-off address refusable, and
      // what stops one started sign-in authorising a second token offered later.
      expect(tokenStorageService.consumeExternalSignInMark()).toBe(false);
    });

    it('is spent even when it had already expired', () => {
      jest.useFakeTimers();
      tokenStorageService.markExternalSignInStarted();

      jest.advanceTimersByTime(EXTERNAL_SIGN_IN_VALIDITY + 1);

      expect(tokenStorageService.consumeExternalSignInMark()).toBe(false);

      jest.setSystemTime(Date.now());

      // Removed rather than left behind, so a stale mark cannot become valid again
      // by any means, including a clock correction.
      expect(tokenStorageService.consumeExternalSignInMark()).toBe(false);
    });

    it('survives long enough for a real sign-in', () => {
      jest.useFakeTimers();
      tokenStorageService.markExternalSignInStarted();

      // Choosing an account, typing a password and answering a second factor. A
      // window that expired inside this would break the flow it exists to protect.
      jest.advanceTimersByTime(EXTERNAL_SIGN_IN_VALIDITY - ms('1 second'));

      expect(tokenStorageService.consumeExternalSignInMark()).toBe(true);
    });

    it('expires once the window has passed', () => {
      jest.useFakeTimers();
      tokenStorageService.markExternalSignInStarted();

      jest.advanceTimersByTime(EXTERNAL_SIGN_IN_VALIDITY + ms('1 second'));

      // An attempt abandoned at the provider must not leave the tab adoptable for
      // the remainder of its session.
      expect(tokenStorageService.consumeExternalSignInMark()).toBe(false);
    });

    it('refuses a mark that claims to be from the future', () => {
      window.sessionStorage.setItem(
        'externalSignInStartedAt',
        `${Date.now() + ms('1 hour')}`
      );

      // A plain "now minus then is within the window" test would have read a
      // negative age as comfortably inside it, making a forward clock jump - or a
      // hand-written value - into a permanent authorisation.
      expect(tokenStorageService.consumeExternalSignInMark()).toBe(false);
    });

    it.each(['', 'not-a-timestamp', 'NaN'])(
      'refuses a mark holding %p',
      (stored) => {
        window.sessionStorage.setItem('externalSignInStartedAt', stored);

        // Storage is reachable from anything running in the page, so the value is
        // parsed rather than trusted.
        expect(tokenStorageService.consumeExternalSignInMark()).toBe(false);
      }
    );

    it('does not disturb the stored session token', () => {
      tokenStorageService.saveToken('a-token');
      tokenStorageService.markExternalSignInStarted();
      tokenStorageService.consumeExternalSignInMark();

      // The mark is bookkeeping beside the credential, not part of it.
      expect(tokenStorageService.getToken()).toBe('a-token');
      expect(window.sessionStorage.getItem(KEY_TOKEN)).toBe('a-token');
    });
  });
});
