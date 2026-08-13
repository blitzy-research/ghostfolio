import { SettingsStorageService } from '@ghostfolio/client/services/settings-storage.service';
import type { AuthDeviceDto } from '@ghostfolio/common/dtos';
import { reportSanitizedError } from '@ghostfolio/common/helper';
import {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON
} from '@ghostfolio/common/interfaces';

import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { from, of } from 'rxjs';
import { catchError, switchMap, tap } from 'rxjs/operators';

@Injectable({
  providedIn: 'root'
})
export class WebAuthnService {
  private static readonly WEB_AUTH_N_DEVICE_ID = 'WEB_AUTH_N_DEVICE_ID';

  /**
   * Loads the WebAuthn browser client on first use instead of at start-up.
   *
   * This service is reachable from the viewer store, which every page load
   * resolves, so a static import would place the whole credential library in the
   * initial bundle for every visitor - including the overwhelming majority who
   * never enrol a device. The application has a single route, so there is no route
   * boundary to keep it out and the boundary is declared here instead.
   *
   * The promise is memoised, so the module is fetched at most once per session
   * and a second enrolment attempt resolves immediately. `isSupported()` and
   * `isEnabled()` deliberately do NOT touch it: both answer from the platform and
   * from local settings, and `signOut()` calls `isEnabled()` on every sign-out.
   */
  private static webAuthnBrowser: Promise<
    typeof import('@simplewebauthn/browser')
  >;

  public constructor(
    private http: HttpClient,
    private settingsStorageService: SettingsStorageService
  ) {}

  /**
   * @returns The WebAuthn browser client, fetched on first call and reused
   * afterwards.
   *
   * Declared here, after the constructor and ahead of the public methods, because
   * that is the band the lint configuration reserves for a private static method.
   */
  private static loadWebAuthnBrowser() {
    WebAuthnService.webAuthnBrowser ??= import('@simplewebauthn/browser');

    return from(WebAuthnService.webAuthnBrowser);
  }

  public isSupported() {
    return typeof PublicKeyCredential !== 'undefined';
  }

  public isEnabled() {
    return !!this.getDeviceId();
  }

  public register() {
    return this.http
      .get<PublicKeyCredentialCreationOptionsJSON>(
        `/api/v1/auth/webauthn/generate-registration-options`,
        {}
      )
      .pipe(
        catchError((error: unknown) => {
          // The event identifier and the HTTP status, and nothing else. The caught
          // value here is an `HttpErrorResponse`, which carries the request URL and
          // whatever the server put in the response body - and this particular
          // response body is the output of a credential ceremony, so it describes
          // the enrolment attempt in detail. Written to the console it would be
          // readable by every script on the page and captured verbatim by
          // session-replay tooling.
          reportSanitizedError('GF-WEBAUTHN-DEVICE-REGISTRATION-FAILED', error);

          return of(null);
        }),
        switchMap((attOps) => {
          return WebAuthnService.loadWebAuthnBrowser().pipe(
            switchMap(({ startRegistration }) => {
              return startRegistration({ optionsJSON: attOps });
            })
          );
        }),
        switchMap((credential) => {
          return this.http.post<AuthDeviceDto>(
            `/api/v1/auth/webauthn/verify-attestation`,
            { credential }
          );
        }),
        tap((authDevice) =>
          this.settingsStorageService.setSetting(
            WebAuthnService.WEB_AUTH_N_DEVICE_ID,
            authDevice.id
          )
        )
      );
  }

  public deregister() {
    const deviceId = this.getDeviceId();

    return this.http
      .delete<AuthDeviceDto>(`/api/v1/auth-device/${deviceId}`)
      .pipe(
        catchError((error: unknown) => {
          // Deliberately without `deviceId`. It is this browser's persistent
          // WebAuthn credential identifier, it does not change between sessions,
          // and it is the one value here that identifies the device across every
          // log line it ever appears in - which is precisely what makes it a
          // tracking identifier rather than diagnostic detail. Knowing that a
          // deregistration failed, and with what status, is what an operator can
          // act on; knowing which credential it was is not.
          reportSanitizedError(
            'GF-WEBAUTHN-DEVICE-DEREGISTRATION-FAILED',
            error
          );

          return of(null);
        }),
        tap(() =>
          this.settingsStorageService.removeSetting(
            WebAuthnService.WEB_AUTH_N_DEVICE_ID
          )
        )
      );
  }

  public login() {
    const deviceId = this.getDeviceId();

    return this.http
      .post<PublicKeyCredentialRequestOptionsJSON>(
        '/api/v1/auth/webauthn/generate-authentication-options',
        { deviceId }
      )
      .pipe(
        switchMap((optionsJSON) => {
          return WebAuthnService.loadWebAuthnBrowser().pipe(
            switchMap(({ startAuthentication }) => {
              return startAuthentication({ optionsJSON });
            })
          );
        }),
        switchMap((credential) => {
          return this.http.post<{ authToken: string }>(
            '/api/v1/auth/webauthn/verify-authentication',
            {
              credential,
              deviceId
            }
          );
        })
      );
  }

  private getDeviceId() {
    return this.settingsStorageService.getSetting(
      WebAuthnService.WEB_AUTH_N_DEVICE_ID
    );
  }
}
