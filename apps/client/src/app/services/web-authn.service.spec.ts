import { SettingsStorageService } from '@ghostfolio/client/services/settings-storage.service';

import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';

import { WebAuthnService } from './web-authn.service';

// Stubbed so a failing ceremony does not pull the real credential library into the
// test environment. Only the failure reporting is under test here; what the library
// would do afterwards is not, and loading it would make these tests depend on a
// browser API jsdom does not implement.
jest.mock('@simplewebauthn/browser', () => {
  return {
    startAuthentication: jest.fn().mockResolvedValue({}),
    startRegistration: jest.fn().mockResolvedValue({})
  };
});

/**
 * What this service is allowed to write to the console when a device operation
 * fails.
 *
 * The console is not a private place: everything written to it is readable by every
 * script on the page, is captured verbatim by error-reporting and session-replay
 * tooling, and survives in a saved log long after the session. Both failure paths
 * here used to write a raw `HttpErrorResponse`, which carries the request URL and
 * the response body - and for the enrolment path that body is the output of a
 * credential ceremony. The deregistration path additionally interpolated the
 * WebAuthn device identifier into the message, which is this browser's persistent
 * credential handle: it does not change between sessions, so it joins every log
 * line it appears in into one device's history, which is what makes it a tracking
 * identifier rather than diagnostic detail.
 *
 * These tests therefore assert on what actually reaches the console, not on how the
 * reporting helper is called - a spy on the helper would pass just as happily while
 * a second, raw write sat next to it.
 */
describe('WebAuthnService', () => {
  const deviceId = 'a9f4e1c0-device-handle-7b2d';

  let consoleError: jest.SpyInstance;
  let consoleLog: jest.SpyInstance;
  let consoleWarn: jest.SpyInstance;
  let httpTestingController: HttpTestingController;
  let removeSetting: jest.Mock;
  let webAuthnService: WebAuthnService;

  /** Everything written to the console, whichever sink was used. */
  const consoleOutput = () => {
    return [consoleError, consoleLog, consoleWarn]
      .flatMap((spy) => spy.mock.calls as unknown[][])
      .flatMap((call) => {
        return call.map((argument) => {
          // Stringified the way a console does, so an object argument cannot hide
          // a value from these assertions by not being a string.
          return typeof argument === 'string'
            ? argument
            : JSON.stringify(
                argument,
                Object.getOwnPropertyNames(argument ?? {})
              );
        });
      })
      .join(' | ');
  };

  beforeEach(() => {
    removeSetting = jest.fn();

    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        WebAuthnService,
        {
          provide: SettingsStorageService,
          useValue: {
            getSetting: () => deviceId,
            removeSetting,
            setSetting: jest.fn()
          }
        }
      ]
    });

    consoleError = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    consoleLog = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    consoleWarn = jest
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);

    httpTestingController = TestBed.inject(HttpTestingController);
    webAuthnService = TestBed.inject(WebAuthnService);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('when deregistering a device fails', () => {
    const deregister = () => {
      webAuthnService.deregister().subscribe({ error: () => undefined });

      httpTestingController
        .expectOne(`/api/v1/auth-device/${deviceId}`)
        .flush('Internal Server Error', {
          status: 500,
          statusText: 'Internal Server Error'
        });
    };

    it('never writes the device identifier anywhere', () => {
      deregister();

      // The single assertion this whole finding comes down to. The identifier is in
      // the request URL as well as the old message, so it is asserted against the
      // entire console transcript rather than one call's arguments.
      expect(consoleOutput()).not.toContain(deviceId);
    });

    it('reports a fixed event and the status, and nothing else', () => {
      deregister();

      expect(consoleError).toHaveBeenCalledTimes(1);
      expect(consoleError).toHaveBeenCalledWith(
        'GF-WEBAUTHN-DEVICE-DEREGISTRATION-FAILED (status 500)'
      );
    });

    it('writes nothing of the request or the response body', () => {
      deregister();

      const output = consoleOutput();

      expect(output).not.toContain('/api/v1/auth-device');
      expect(output).not.toContain('Internal Server Error');
      expect(output).not.toContain('Http failure');
    });

    it('stops using the console sink the raw message was written to', () => {
      deregister();

      // Pins the migration itself: the previous implementation wrote through
      // `console.warn`, so a revert would show up here even if a sanitized line
      // were being written elsewhere.
      expect(consoleWarn).not.toHaveBeenCalled();
    });

    it('still forgets the device locally, which is what the caller relies on', () => {
      deregister();

      // Asserted so the reporting change cannot be mistaken for a behaviour change:
      // a failed deregistration still clears the local setting, exactly as before.
      expect(removeSetting).toHaveBeenCalledWith('WEB_AUTH_N_DEVICE_ID');
    });
  });

  describe('when enrolling a device fails', () => {
    it('reports a fixed event and the status, with no request or response detail', async () => {
      webAuthnService.register().subscribe({ error: () => undefined });

      httpTestingController
        .expectOne('/api/v1/auth/webauthn/generate-registration-options')
        .flush('Internal Server Error', {
          status: 503,
          statusText: 'Service Unavailable'
        });

      expect(consoleError).toHaveBeenCalledTimes(1);
      expect(consoleError).toHaveBeenCalledWith(
        'GF-WEBAUTHN-DEVICE-REGISTRATION-FAILED (status 503)'
      );
      expect(consoleWarn).not.toHaveBeenCalled();

      const output = consoleOutput();

      expect(output).not.toContain('/api/v1/auth');
      expect(output).not.toContain('Internal Server Error');
      expect(output).not.toContain('Http failure');

      // The chain deliberately continues after the caught failure - unchanged
      // pre-existing behaviour - so whatever it issues next is drained here rather
      // than left outstanding for the verification below.
      await new Promise((resolve) => setTimeout(resolve, 0));

      for (const request of httpTestingController.match(() => true)) {
        request.flush({ id: deviceId });
      }

      httpTestingController.verify();
    });
  });
});
