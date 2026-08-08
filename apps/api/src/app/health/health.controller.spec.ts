import { JwtStrategy } from '@ghostfolio/api/app/auth/jwt.strategy';
import { UserService } from '@ghostfolio/api/app/user/user.service';
import { TransformDataSourceInRequestInterceptor } from '@ghostfolio/api/interceptors/transform-data-source-in-request/transform-data-source-in-request.interceptor';
import { ConfigurationService } from '@ghostfolio/api/services/configuration/configuration.service';
import { PrismaService } from '@ghostfolio/api/services/prisma/prisma.service';
import { permissions } from '@ghostfolio/common/permissions';

import { INestApplication, VersioningType } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from '@prisma/client';
import { Server } from 'node:http';
import { AddressInfo } from 'node:net';

import { HealthController } from './health.controller';
import { HealthService } from './health.service';

/**
 * Who may reach each health route.
 *
 * Three routes share the `health` prefix and they are not the same kind of thing:
 *
 * - `GET /api/v1/health` is liveness. It is documented as needing no bearer token,
 *   the shipped Docker composition polls it as a container health check, and it
 *   touches only this deployment's own database and cache. It must stay open, and a
 *   regression that guarded it would break every deployment's orchestration.
 * - `GET /api/v1/health/data-enhancer/:name` and
 *   `GET /api/v1/health/data-provider/:dataSource` are deep probes. Each starts a
 *   fresh, deliberately uncached request to a third party with a thirty-second
 *   request timeout. Public, they were an amplifier: one cheap request bought
 *   thirty seconds of a socket, a slot in the event loop and a slice of this
 *   deployment's provider quota, and nothing capped the number in flight.
 *
 * The routes are exercised over HTTP through the same pipeline `main.ts` builds -
 * URI versioning, the `api` prefix, Ghostfolio's own passport strategy registered
 * for real - because the thing under test is the guard tuple, and a unit call on
 * the handler would bypass exactly that. `JwtStrategy` being genuine is what makes
 * the 401 assertions real rather than a restatement of a stub.
 */
describe('HealthController', () => {
  const jwtSecret = 'health-controller-spec-secret';
  const jwtService = new JwtService({ secret: jwtSecret });

  const enhancerPath = '/api/v1/health/data-enhancer/TRACKINSIGHT';
  const livenessPath = '/api/v1/health';
  const providerPath = `/api/v1/health/data-provider/${DataSource.YAHOO}`;

  const administratorId = 'a2f3c1d4-5b6e-4a7f-8c9d-0e1f2a3b4c5d';
  const memberId = 'b3e4d2c5-6c7f-4b8a-9d0e-1f2a3b4c5d6e';

  const findUser = jest.fn();

  const hasResponseFromDataEnhancer = jest.fn().mockResolvedValue(true);
  const hasResponseFromDataProvider = jest.fn().mockResolvedValue(true);
  const isDatabaseHealthy = jest.fn().mockResolvedValue(true);
  const isRedisCacheHealthy = jest.fn().mockResolvedValue(true);

  let app: INestApplication;

  /**
   * A user record shaped the way `JwtStrategy.validate` needs it, carrying the
   * permissions the caller is supposed to hold.
   *
   * `settings.settings` is not optional to the strategy - it reads `baseCurrency`
   * and `language` off it - so a flatter double fails inside `validate` and the
   * request comes back 401 for a reason that has nothing to do with the guard under
   * test.
   */
  const createUserRecord = (aUserId: string, aPermissions: string[]) => {
    return {
      id: aUserId,
      permissions: aPermissions,
      role: aPermissions.length > 0 ? 'ADMIN' : 'USER',
      settings: { settings: { baseCurrency: 'CHF', language: 'en' } }
    };
  };

  const requestPath = async ({
    authorization,
    path
  }: {
    authorization?: string;
    path: string;
  }) => {
    const { port } = (app.getHttpServer() as Server).address() as AddressInfo;

    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      headers: authorization ? { authorization } : undefined
    });

    return { status: response.status };
  };

  const tokenFor = (aUserId: string) => {
    return `Bearer ${jwtService.sign({ id: aUserId })}`;
  };

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        // Registered for real, so a request without a bearer token fails in the
        // extractor and produces the required 401 rather than an unknown-strategy
        // 500.
        JwtStrategy,
        TransformDataSourceInRequestInterceptor,
        {
          provide: ConfigurationService,
          // Keyed rather than constant: answering every key with the secret would
          // also switch the subscription feature on, sending `validate()` into an
          // analytics upsert this module does not provide.
          useValue: {
            get: (aKey: string) =>
              aKey === 'JWT_SECRET_KEY' ? jwtSecret : undefined
          }
        },
        {
          provide: HealthService,
          useValue: {
            hasResponseFromDataEnhancer,
            hasResponseFromDataProvider,
            isDatabaseHealthy,
            isRedisCacheHealthy
          }
        },
        // `JwtStrategy` takes a Prisma client as well as the user service; it uses
        // it only on the analytics path the subscription feature enables, which the
        // configuration above deliberately leaves off, so an unimplemented double
        // is correct here rather than merely convenient.
        { provide: PrismaService, useValue: {} },
        { provide: UserService, useValue: { user: findUser } }
      ]
    }).compile();

    app = module.createNestApplication({ forceCloseConnections: true });

    app.enableVersioning({ defaultVersion: '1', type: VersioningType.URI });
    app.setGlobalPrefix('api');

    await app.listen(0, '127.0.0.1');
  }, 30000);

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    findUser.mockReset();
    hasResponseFromDataEnhancer.mockClear();
    hasResponseFromDataProvider.mockClear();
  });

  describe('liveness', () => {
    it('answers an unauthenticated caller', async () => {
      const { status } = await requestPath({ path: livenessPath });

      // Documented as requiring no bearer token, and polled by the shipped Docker
      // composition. Guarding this would break every deployment's orchestration,
      // so its openness is asserted rather than assumed.
      expect(status).toBe(200);
    });

    it('reaches no third party', async () => {
      await requestPath({ path: livenessPath });

      // Shallow by design: this is what makes it safe to leave open. It consults
      // only this deployment's own database and cache.
      expect(isDatabaseHealthy).toHaveBeenCalled();
      expect(isRedisCacheHealthy).toHaveBeenCalled();
      expect(hasResponseFromDataEnhancer).not.toHaveBeenCalled();
      expect(hasResponseFromDataProvider).not.toHaveBeenCalled();
    });

    it('reports 503 when a dependency is down', async () => {
      isRedisCacheHealthy.mockResolvedValueOnce(false);

      const { status } = await requestPath({ path: livenessPath });

      expect(status).toBe(503);
    });
  });

  describe.each([
    { description: 'the data-enhancer probe', path: enhancerPath },
    { description: 'the data-provider probe', path: providerPath }
  ])('$description', ({ path }) => {
    it('rejects an unauthenticated caller with 401', async () => {
      const { status } = await requestPath({ path });

      // The passport guard runs first, which is what makes this 401 rather than
      // 403 - and 401 is the answer for a caller who presented no identity.
      expect(status).toBe(401);
    });

    it('makes no outbound call for an unauthenticated caller', async () => {
      await requestPath({ path });

      // The whole point of the guard. Before it, this request reached a third party
      // and held a socket for up to thirty seconds.
      expect(hasResponseFromDataEnhancer).not.toHaveBeenCalled();
      expect(hasResponseFromDataProvider).not.toHaveBeenCalled();
    });

    it('rejects a bearer token this deployment did not sign with 401', async () => {
      const foreignToken = new JwtService({
        secret: 'a-different-secret'
      }).sign({ id: administratorId });

      const { status } = await requestPath({
        path,
        authorization: `Bearer ${foreignToken}`
      });

      expect(status).toBe(401);
    });

    it('rejects an authenticated member without administration rights with 403', async () => {
      findUser.mockResolvedValue(createUserRecord(memberId, []));

      const { status } = await requestPath({
        path,
        authorization: tokenFor(memberId)
      });

      // A caller who *is* identified but lacks the permission gets 403, which is
      // the distinction the permission guard exists to draw.
      expect(status).toBe(403);
    });

    it('makes no outbound call for a member without administration rights', async () => {
      findUser.mockResolvedValue(createUserRecord(memberId, []));

      await requestPath({ path, authorization: tokenFor(memberId) });

      expect(hasResponseFromDataEnhancer).not.toHaveBeenCalled();
      expect(hasResponseFromDataProvider).not.toHaveBeenCalled();
    });

    it('answers an administrator', async () => {
      findUser.mockResolvedValue(
        createUserRecord(administratorId, [permissions.accessAdminControl])
      );

      const { status } = await requestPath({
        path,
        authorization: tokenFor(administratorId)
      });

      // The audience the feature always had: its only consumer in this application
      // is the administration settings screen, which renders exclusively for a
      // viewer holding this permission. Asserted so the guard cannot have been
      // achieved by closing the route to everybody.
      expect(status).toBe(200);
    });
  });
});
