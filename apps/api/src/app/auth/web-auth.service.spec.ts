import { AuthDeviceService } from '@ghostfolio/api/app/auth-device/auth-device.service';
import { UserService } from '@ghostfolio/api/app/user/user.service';
import { ConfigurationService } from '@ghostfolio/api/services/configuration/configuration.service';
import {
  AssertionCredentialJSON,
  AttestationCredentialJSON
} from '@ghostfolio/common/interfaces';
import type { RequestWithUser } from '@ghostfolio/common/types';

import { InternalServerErrorException, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

import { WebAuthService } from './web-auth.service';

/**
 * What a rejected credential ceremony is allowed to say, to the log and to the
 * caller.
 *
 * Neither `Logger.error` nor the caller is a safe place for the library's own
 * exception. The message quotes the challenge, the origin and the relying-party
 * identifier the ceremony was given, and the stack names the verification
 * internals and their file paths - so a log read far more widely than the request
 * would end up holding the ceremony's inputs. Returning the message is worse than
 * untidy: it tells an authenticated caller *which* check their crafted response
 * tripped, which turns the endpoint into an oracle that can be probed one field at
 * a time.
 *
 * These tests are written against the two observable outputs - the exact string
 * handed to the logger, and the exception handed to the caller - because that is
 * the only place the guarantee can be seen. A test of the categoriser alone would
 * pass while the raw object still reached the console beside it.
 */
describe('WebAuthService', () => {
  const rootUrl = 'https://ghostfolio.example';

  /**
   * A response that cannot verify.
   *
   * Deliberately not a hand-built failure: the library is left to reject it, so
   * these tests observe how a *real* rejection is reported rather than how a
   * simulated one is. The marker string is what proves nothing of the input
   * survives into the log - the library echoes its inputs into its message, so if
   * the message were being logged this value would appear there.
   */
  const marker = 'e5b1c7d2-secret-credential-material';

  let loggerError: jest.SpyInstance;
  let webAuthService: WebAuthService;

  const createService = ({
    authChallenge = marker,
    device
  }: {
    authChallenge?: string;
    device?: unknown;
  } = {}) => {
    return new WebAuthService(
      {
        get: (key: string) => (key === 'ROOT_URL' ? rootUrl : undefined)
      } as unknown as ConfigurationService,
      {
        authDevice: jest.fn().mockResolvedValue(device)
      } as unknown as AuthDeviceService,
      { sign: jest.fn().mockReturnValue('token') } as unknown as JwtService,
      {
        user: jest.fn().mockResolvedValue({ authChallenge, id: 'user-1' })
      } as unknown as UserService,
      { user: { authChallenge, id: 'user-1' } } as unknown as RequestWithUser
    );
  };

  /**
   * Every log line the service emitted, as the logger received it.
   *
   * Each call's arguments are stringified and joined, so an argument that is not a
   * string cannot hide a value from the assertions below by virtue of its type -
   * which is exactly what the raw exception object did.
   */
  const emitted = (): string[] => {
    const calls = loggerError.mock.calls as unknown[][];

    return calls.map((call) => {
      return call
        .map((argument) => {
          // Serialised rather than coerced. `String(anObject)` yields
          // '[object Object]', which would *hide* a leaked payload from the
          // assertions below instead of exposing it - the exact failure these
          // tests exist to catch. An error's `message` and `stack` are own
          // properties, so naming them explicitly captures them too, which
          // `JSON.stringify` alone would not.
          return typeof argument === 'string'
            ? argument
            : JSON.stringify(
                argument,
                Object.getOwnPropertyNames(argument ?? {})
              );
        })
        .join(' ');
    });
  };

  beforeEach(() => {
    // Silenced as well as observed: an unsilenced spy would print the assertions'
    // own fixtures during the run.
    loggerError = jest
      .spyOn(Logger, 'error')
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('when a registration ceremony is rejected', () => {
    const attest = () => {
      webAuthService = createService();

      return webAuthService.verifyAttestation({
        clientExtensionResults: {},
        id: marker,
        rawId: marker,
        response: { attestationObject: marker, clientDataJSON: marker },
        type: 'public-key'
      } as unknown as AttestationCredentialJSON);
    };

    it('records the ceremony and the category, and nothing else', async () => {
      await expect(attest()).rejects.toBeInstanceOf(
        InternalServerErrorException
      );

      expect(emitted()).toHaveLength(1);
      expect(emitted()[0]).toContain('GF-WEBAUTHN-VERIFICATION-FAILED');
      expect(emitted()[0]).toContain('ceremony REGISTRATION');
      expect(emitted()[0]).toMatch(/category [A-Z_]+/);
    });

    it('puts nothing from the credential or the exception in the log', async () => {
      await expect(attest()).rejects.toThrow();

      const line = emitted()[0];

      // The marker is the challenge, the credential id and every field of the
      // response, so its absence covers all of them at once. `at ` and `.ts:`
      // would betray a stack frame having been stringified into the line.
      expect(line).not.toContain(marker);
      expect(line).not.toContain(rootUrl);
      expect(line).not.toContain('ghostfolio.example');
      expect(line).not.toContain('at ');
      expect(line).not.toContain('.ts:');
    });

    it('names the category when the ceremony fails a check it can recognise', async () => {
      webAuthService = createService();

      // Well-formed enough that the library gets past decoding and reaches a
      // semantic check - here the challenge, which does not match the one issued.
      // The garbage fixture above only ever reaches the decoder, so without this
      // case the classification table would never be exercised and only its
      // `UNCLASSIFIED` fallback would be under test.
      const clientDataJSON = Buffer.from(
        JSON.stringify({
          challenge: 'Zm9yZ2VkLWNoYWxsZW5nZQ',
          origin: rootUrl,
          type: 'webauthn.create'
        })
      ).toString('base64url');

      await expect(
        webAuthService.verifyAttestation({
          clientExtensionResults: {},
          id: marker,
          rawId: marker,
          response: { attestationObject: marker, clientDataJSON },
          type: 'public-key'
        } as unknown as AttestationCredentialJSON)
      ).rejects.toThrow('An unknown error occurred');

      const line = emitted()[0];

      // A recognised failure mode, reported as one of the closed vocabulary's own
      // names - the operational answer - with none of the values that produced it.
      expect(line).toMatch(
        /category (CHALLENGE_MISMATCH|ORIGIN_MISMATCH|RELYING_PARTY_MISMATCH|MALFORMED_RESPONSE)\b/
      );
      expect(line).not.toContain(marker);
      expect(line).not.toContain('Zm9yZ2VkLWNoYWxsZW5nZQ');
    });

    it('tells the caller only that something failed', async () => {
      await expect(attest()).rejects.toThrow('An unknown error occurred');

      const error = await attest().catch((caught: unknown) => caught);
      const body = JSON.stringify(
        (error as InternalServerErrorException).getResponse()
      );

      // No detail of which check failed, so the endpoint cannot be used to test
      // one field of a crafted response at a time.
      expect(body).not.toContain(marker);
      expect(body).not.toContain('challenge');
      expect(body).not.toContain('origin');
      expect(body).not.toContain('RP ID');
    });
  });

  describe('when an authentication ceremony is rejected', () => {
    const authenticate = () => {
      webAuthService = createService({
        device: {
          counter: 0,
          credentialId: Buffer.from('credential'),
          credentialPublicKey: Buffer.from('public-key'),
          id: 'device-1',
          userId: 'user-1'
        }
      });

      return webAuthService.verifyAuthentication('device-1', {
        clientExtensionResults: {},
        id: marker,
        rawId: marker,
        response: {
          authenticatorData: marker,
          clientDataJSON: marker,
          signature: marker
        },
        type: 'public-key'
      } as unknown as AssertionCredentialJSON);
    };

    it('is distinguishable from a registration failure in the log', async () => {
      await expect(authenticate()).rejects.toBeInstanceOf(
        InternalServerErrorException
      );

      // The one thing the two sites may differ by. Without it a log cannot tell
      // enrolment failing from sign-in failing, which are very different events.
      expect(emitted()[0]).toContain('ceremony AUTHENTICATION');
      expect(emitted()[0]).not.toContain(marker);
    });

    it('returns the same generic error as registration, not a different shape', async () => {
      const error = await authenticate().catch((caught: unknown) => caught);

      // Two shapes for one class of failure would itself be a signal - this path
      // wrapping the message where registration throws it bare - so the two are
      // asserted to be identical.
      expect((error as InternalServerErrorException).getResponse()).toEqual(
        new InternalServerErrorException(
          'An unknown error occurred'
        ).getResponse()
      );
    });
  });

  describe('a device that is not enrolled', () => {
    it('is refused before any ceremony is attempted', async () => {
      webAuthService = createService({ device: null });

      await expect(
        webAuthService.verifyAuthentication(
          'device-1',
          {} as unknown as AssertionCredentialJSON
        )
      ).rejects.toThrow('Device not found');

      // Pre-existing behaviour, asserted so the new reporting is not mistaken for
      // covering it: this path logs nothing, and should not start to.
      expect(loggerError).not.toHaveBeenCalled();
    });
  });
});
