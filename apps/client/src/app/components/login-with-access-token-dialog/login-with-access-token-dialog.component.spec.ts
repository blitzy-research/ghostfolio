import { SettingsStorageService } from '@ghostfolio/client/services/settings-storage.service';
import { TokenStorageService } from '@ghostfolio/client/services/token-storage.service';

import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { By } from '@angular/platform-browser';

import { GfLoginWithAccessTokenDialogComponent } from './login-with-access-token-dialog.component';

/**
 * The two links that begin an external sign-in - and the record they leave behind.
 *
 * These anchors are the *only* places this application starts a Google or OpenID
 * Connect flow. The provider returns the resulting token to the address bar, and
 * the root route's guard will only adopt it if this browser recorded that it asked;
 * otherwise `/<locale>/?jwt=<somebody else's token>` sent to a signed-out visitor
 * signs them into the sender's account.
 *
 * So the guard's refusal and this mark are one mechanism in two halves, and this
 * half fails in the opposite direction: forget it here and no legitimate Google or
 * OIDC sign-in completes at all, on any deployment that enables them. The template
 * is rendered and the anchors clicked rather than the handler called directly,
 * because the binding is the part that can be lost.
 */
describe('GfLoginWithAccessTokenDialogComponent', () => {
  let fixture: ComponentFixture<GfLoginWithAccessTokenDialogComponent>;
  let markExternalSignInStarted: jest.Mock;

  const createFixture = async (
    data: Partial<{
      hasPermissionToUseAuthGoogle: boolean;
      hasPermissionToUseAuthOidc: boolean;
      hasPermissionToUseAuthToken: boolean;
    }>
  ) => {
    markExternalSignInStarted = jest.fn();

    TestBed.configureTestingModule({
      imports: [GfLoginWithAccessTokenDialogComponent],
      providers: [
        { provide: MAT_DIALOG_DATA, useValue: { title: 'Sign in', ...data } },
        { provide: MatDialogRef, useValue: { close: jest.fn() } },
        {
          provide: SettingsStorageService,
          useValue: { setSetting: jest.fn() }
        },
        {
          provide: TokenStorageService,
          useValue: { markExternalSignInStarted }
        }
      ]
    });

    fixture = TestBed.createComponent(GfLoginWithAccessTokenDialogComponent);
    fixture.detectChanges();

    await fixture.whenStable();

    return fixture;
  };

  const clickAnchorTo = (href: string) => {
    const anchor = fixture.debugElement
      .queryAll(By.css('a[href]'))
      .find((candidate) => {
        return (candidate.nativeElement as HTMLAnchorElement)
          .getAttribute('href')
          ?.endsWith(href);
      });

    if (!anchor) {
      throw new Error(`No link to ${href} was rendered.`);
    }

    // Prevented so jsdom does not report a refused navigation; the handler under
    // test runs before the anchor's own default action either way.
    anchor.nativeElement.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true })
    );
  };

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('records that this browser started the sign-in when Google is chosen', async () => {
    await createFixture({ hasPermissionToUseAuthGoogle: true });

    clickAnchorTo('/auth/google');

    expect(markExternalSignInStarted).toHaveBeenCalledTimes(1);
  });

  it('records that this browser started the sign-in when OpenID Connect is chosen', async () => {
    await createFixture({ hasPermissionToUseAuthOidc: true });

    clickAnchorTo('/auth/oidc');

    expect(markExternalSignInStarted).toHaveBeenCalledTimes(1);
  });

  it('still navigates to the provider rather than replacing the link with a handler', async () => {
    await createFixture({
      hasPermissionToUseAuthGoogle: true,
      hasPermissionToUseAuthOidc: true
    });

    const hrefs = fixture.debugElement
      .queryAll(By.css('a[href]'))
      .map((anchor) => {
        return (anchor.nativeElement as HTMLAnchorElement).getAttribute('href');
      });

    // The flow must remain a top-level document navigation. Starting it with
    // `fetch` or in a new window would leave the provider's redirect landing
    // somewhere the tab's own session storage - and therefore the mark - is not.
    expect(hrefs).toContain('../api/v1/auth/google');
    expect(hrefs).toContain('../api/auth/oidc');
  });

  it('records nothing until a provider link is actually used', async () => {
    await createFixture({
      hasPermissionToUseAuthGoogle: true,
      hasPermissionToUseAuthToken: true
    });

    // Opening the dialog is not asking for an external sign-in. Marking on render
    // would make merely *seeing* the prompt enough to authorise a hand-off.
    expect(markExternalSignInStarted).not.toHaveBeenCalled();
  });
});
