import { SettingsStorageService } from '@ghostfolio/client/services/settings-storage.service';
import type { AuthDeviceDto } from '@ghostfolio/common/dtos';
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
   * resolves, so a static import placed the whole credential library in the
   * initial bundle for every visitor - including the overwhelming majority who
   * never enrol a device. Since the route table collapsed onto a single canvas
   * there is no longer a route boundary to keep it out, so the boundary is
   * declared here.
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
        catchError((error) => {
          console.warn('Could not register device', error);
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
        catchError((error) => {
          console.warn(`Could not deregister device ${deviceId}`, error);
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

  /**
   * @returns The WebAuthn browser client, fetched on first call and reused
   * afterwards.
   */
  private static loadWebAuthnBrowser() {
    WebAuthnService.webAuthnBrowser ??= import('@simplewebauthn/browser');

    return from(WebAuthnService.webAuthnBrowser);
  }

  private getDeviceId() {
    return this.settingsStorageService.getSetting(
      WebAuthnService.WEB_AUTH_N_DEVICE_ID
    );
  }
}
