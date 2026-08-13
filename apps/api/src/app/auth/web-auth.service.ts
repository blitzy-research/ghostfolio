import { AuthDeviceService } from '@ghostfolio/api/app/auth-device/auth-device.service';
import { UserService } from '@ghostfolio/api/app/user/user.service';
import { ConfigurationService } from '@ghostfolio/api/services/configuration/configuration.service';
import { AuthDeviceDto } from '@ghostfolio/common/dtos';
import {
  AssertionCredentialJSON,
  AttestationCredentialJSON
} from '@ghostfolio/common/interfaces';
import type { RequestWithUser } from '@ghostfolio/common/types';

import {
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger
} from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import {
  generateAuthenticationOptions,
  GenerateAuthenticationOptionsOpts,
  generateRegistrationOptions,
  GenerateRegistrationOptionsOpts,
  VerifiedAuthenticationResponse,
  VerifiedRegistrationResponse,
  verifyAuthenticationResponse,
  VerifyAuthenticationResponseOpts,
  verifyRegistrationResponse,
  VerifyRegistrationResponseOpts
} from '@simplewebauthn/server';
import { isoBase64URL, isoUint8Array } from '@simplewebauthn/server/helpers';
import ms from 'ms';

const WEB_AUTHN_VERIFICATION_FAILED_EVENT = 'GF-WEBAUTHN-VERIFICATION-FAILED';

/**
 * The reasons a credential ceremony can be rejected, as a closed vocabulary.
 *
 * A verification failure is worth recording - it is how an operator sees a
 * misconfigured relying party or a client that is being tampered with - but the
 * library's own exception is not what should record it. Its message quotes the
 * challenge, the origin and the relying-party identifier it was given, and its
 * stack names the verification internals and their file paths, all of which end up
 * in a log that is far more widely readable than the request was.
 *
 * These names carry the operational answer instead: which way the ceremony failed.
 * They are emitted verbatim and are never derived from anything a caller supplied,
 * so a log line cannot be steered by a crafted request.
 */
const WEB_AUTHN_FAULT_CATEGORIES = {
  challengeMismatch: 'CHALLENGE_MISMATCH',
  counterRegression: 'COUNTER_REGRESSION',
  credentialTypeUnexpected: 'CREDENTIAL_TYPE_UNEXPECTED',
  malformedResponse: 'MALFORMED_RESPONSE',
  originMismatch: 'ORIGIN_MISMATCH',
  relyingPartyMismatch: 'RELYING_PARTY_MISMATCH',
  signatureRejected: 'SIGNATURE_REJECTED',
  unclassified: 'UNCLASSIFIED',
  userVerificationMissing: 'USER_VERIFICATION_MISSING'
} as const;

/**
 * How a rejection is recognised, in order.
 *
 * Ordered rather than a lookup because the library reports these as prose, and the
 * first match wins - the more specific patterns therefore precede the general
 * `malformedResponse` catch. Anything unrecognised becomes `UNCLASSIFIED` rather
 * than falling back to the message, so a library upgrade that rewords an error
 * degrades the precision of a log line and never its safety.
 */
const WEB_AUTHN_FAULT_PATTERNS: {
  category: WebAuthnFaultCategory;
  pattern: RegExp;
}[] = [
  {
    category: WEB_AUTHN_FAULT_CATEGORIES.challengeMismatch,
    pattern: /challenge/i
  },
  { category: WEB_AUTHN_FAULT_CATEGORIES.originMismatch, pattern: /origin/i },
  {
    category: WEB_AUTHN_FAULT_CATEGORIES.relyingPartyMismatch,
    pattern: /\brp\s?id\b/i
  },
  {
    category: WEB_AUTHN_FAULT_CATEGORIES.userVerificationMissing,
    pattern: /user (?:could not be )?verif/i
  },
  {
    category: WEB_AUTHN_FAULT_CATEGORIES.signatureRejected,
    pattern: /signature/i
  },
  {
    category: WEB_AUTHN_FAULT_CATEGORIES.counterRegression,
    pattern: /counter/i
  },
  {
    category: WEB_AUTHN_FAULT_CATEGORIES.credentialTypeUnexpected,
    pattern: /credential type/i
  },
  {
    category: WEB_AUTHN_FAULT_CATEGORIES.malformedResponse,
    pattern: /base64|missing|invalid|unable to parse|no attestation/i
  }
];

/**
 * The ceremony a rejection belongs to, so the two call sites stay distinguishable
 * in a log without either of them describing its input.
 */
const WEB_AUTHN_CEREMONIES = {
  authentication: 'AUTHENTICATION',
  registration: 'REGISTRATION'
} as const;

type WebAuthnCeremony =
  (typeof WEB_AUTHN_CEREMONIES)[keyof typeof WEB_AUTHN_CEREMONIES];

type WebAuthnFaultCategory =
  (typeof WEB_AUTHN_FAULT_CATEGORIES)[keyof typeof WEB_AUTHN_FAULT_CATEGORIES];

@Injectable()
export class WebAuthService {
  public constructor(
    private readonly configurationService: ConfigurationService,
    private readonly deviceService: AuthDeviceService,
    private readonly jwtService: JwtService,
    private readonly userService: UserService,
    @Inject(REQUEST) private readonly request: RequestWithUser
  ) {}

  private get expectedOrigin() {
    return this.configurationService.get('ROOT_URL');
  }

  private get rpID() {
    return new URL(this.configurationService.get('ROOT_URL')).hostname;
  }

  public async generateRegistrationOptions() {
    const user = this.request.user;

    const opts: GenerateRegistrationOptionsOpts = {
      authenticatorSelection: {
        authenticatorAttachment: 'platform',
        residentKey: 'required',
        userVerification: 'preferred'
      },
      rpID: this.rpID,
      rpName: 'Ghostfolio',
      timeout: ms('60 seconds'),
      userID: isoUint8Array.fromUTF8String(user.id),
      userName: ''
    };

    const registrationOptions = await generateRegistrationOptions(opts);

    await this.userService.updateUser({
      data: {
        authChallenge: registrationOptions.challenge
      },
      where: {
        id: user.id
      }
    });

    return registrationOptions;
  }

  public async verifyAttestation(
    credential: AttestationCredentialJSON
  ): Promise<AuthDeviceDto> {
    const user = this.request.user;
    const expectedChallenge = user.authChallenge;
    let verification: VerifiedRegistrationResponse;

    try {
      const opts: VerifyRegistrationResponseOpts = {
        expectedChallenge,
        expectedOrigin: this.expectedOrigin,
        expectedRPID: this.rpID,
        requireUserVerification: false,
        response: {
          clientExtensionResults: credential.clientExtensionResults,
          id: credential.id,
          rawId: credential.rawId,
          response: credential.response,
          type: 'public-key'
        }
      };

      verification = await verifyRegistrationResponse(opts);
    } catch (error) {
      this.reportVerificationFault(WEB_AUTHN_CEREMONIES.registration, error);

      // The same generic message this method already uses for a ceremony that
      // completes without verifying, so the two outcomes are indistinguishable to
      // the caller. Returning `error.message` told an authenticated caller which of
      // the challenge, origin or relying-party checks their crafted response had
      // tripped, which is an oracle for probing the ceremony one field at a time.
      throw new InternalServerErrorException('An unknown error occurred');
    }

    const { registrationInfo, verified } = verification;

    const devices = await this.deviceService.authDevices({
      where: { userId: user.id }
    });
    if (registrationInfo && verified) {
      const {
        credential: {
          counter,
          id: credentialId,
          publicKey: credentialPublicKey
        }
      } = registrationInfo;

      let existingDevice = devices.find((device) => {
        return isoBase64URL.fromBuffer(device.credentialId) === credentialId;
      });

      if (!existingDevice) {
        /**
         * Add the returned device to the user's list of devices
         */
        existingDevice = await this.deviceService.createAuthDevice({
          counter,
          credentialId: Buffer.from(credentialId),
          credentialPublicKey: Buffer.from(credentialPublicKey),
          user: { connect: { id: user.id } }
        });
      }

      return {
        createdAt: existingDevice.createdAt.toISOString(),
        id: existingDevice.id
      };
    }

    throw new InternalServerErrorException('An unknown error occurred');
  }

  public async generateAuthenticationOptions(deviceId: string) {
    const device = await this.deviceService.authDevice({ id: deviceId });

    if (!device) {
      throw new Error('Device not found');
    }

    const opts: GenerateAuthenticationOptionsOpts = {
      allowCredentials: [],
      rpID: this.rpID,
      timeout: ms('60 seconds'),
      userVerification: 'preferred'
    };

    const authenticationOptions = await generateAuthenticationOptions(opts);

    await this.userService.updateUser({
      data: {
        authChallenge: authenticationOptions.challenge
      },
      where: {
        id: device.userId
      }
    });

    return authenticationOptions;
  }

  public async verifyAuthentication(
    deviceId: string,
    credential: AssertionCredentialJSON
  ) {
    const device = await this.deviceService.authDevice({ id: deviceId });

    if (!device) {
      throw new Error('Device not found');
    }

    const user = await this.userService.user({ id: device.userId });

    let verification: VerifiedAuthenticationResponse;

    try {
      const opts: VerifyAuthenticationResponseOpts = {
        credential: {
          counter: device.counter,
          id: isoBase64URL.fromBuffer(device.credentialId),
          publicKey: device.credentialPublicKey
        },
        expectedChallenge: `${user.authChallenge}`,
        expectedOrigin: this.expectedOrigin,
        expectedRPID: this.rpID,
        requireUserVerification: false,
        response: {
          clientExtensionResults: credential.clientExtensionResults,
          id: credential.id,
          rawId: credential.rawId,
          response: credential.response,
          type: 'public-key'
        }
      };

      verification = await verifyAuthenticationResponse(opts);
    } catch (error) {
      this.reportVerificationFault(WEB_AUTHN_CEREMONIES.authentication, error);

      // Genericised, and also unified with the registration path above, which threw
      // a bare string where this one threw `{ error: … }`. Two shapes for the same
      // class of failure told a caller which ceremony it had reached before it told
      // them anything else; no consumer reads either body - both sign-in and
      // enrolment surface a fixed message of their own.
      throw new InternalServerErrorException('An unknown error occurred');
    }

    const { authenticationInfo, verified } = verification;

    if (verified) {
      device.counter = authenticationInfo.newCounter;

      await this.deviceService.updateAuthDevice({
        data: device,
        where: { id: device.id }
      });

      return this.jwtService.sign({
        id: user.id
      });
    }

    throw new Error();
  }

  /**
   * Records that a credential ceremony was rejected, without recording anything
   * about the request that was rejected.
   *
   * Three things are emitted and nothing else: a fixed event identifier, which
   * ceremony it was, and which category of check failed. Absent by design are the
   * exception object, its message and its stack; the credential and device
   * identifiers, which are stable per browser and would let separate log lines be
   * joined into one device's history; and the account, which is already recoverable
   * from the request log if an investigation genuinely needs it.
   *
   * @param aCeremony which ceremony rejected the credential.
   * @param aFault the caught value, read only to categorise it and then discarded.
   */
  private reportVerificationFault(
    aCeremony: WebAuthnCeremony,
    aFault: unknown
  ) {
    const { message } = (aFault ?? {}) as { message?: unknown };

    const category =
      (typeof message === 'string' &&
        WEB_AUTHN_FAULT_PATTERNS.find(({ pattern }) => {
          return pattern.test(message);
        })?.category) ||
      WEB_AUTHN_FAULT_CATEGORIES.unclassified;

    Logger.error(
      `${WEB_AUTHN_VERIFICATION_FAILED_EVENT} (ceremony ${aCeremony}, category ${category})`,
      'WebAuthService'
    );
  }
}
