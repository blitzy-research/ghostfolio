import { JwtStrategy } from '@ghostfolio/api/app/auth/jwt.strategy';
import { HAS_PERMISSION_KEY } from '@ghostfolio/api/decorators/has-permission.decorator';
import { HasPermissionGuard } from '@ghostfolio/api/guards/has-permission.guard';
import { PerformanceLoggingInterceptor } from '@ghostfolio/api/interceptors/performance-logging/performance-logging.interceptor';
import { PerformanceLoggingModule } from '@ghostfolio/api/interceptors/performance-logging/performance-logging.module';
import { ConfigurationService } from '@ghostfolio/api/services/configuration/configuration.service';
import { PrismaService } from '@ghostfolio/api/services/prisma/prisma.service';
import { UpdateUserDashboardLayoutDto } from '@ghostfolio/common/dtos';
import { UserDashboardLayout } from '@ghostfolio/common/interfaces';

import {
  ExecutionContext,
  INestApplication,
  Logger,
  ValidationPipe,
  VersioningType
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host';
import { JwtService } from '@nestjs/jwt';
import { AuthGuard } from '@nestjs/passport';
import { Test, TestingModule } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { Server } from 'node:http';
import { AddressInfo } from 'node:net';

import { UserDashboardLayoutController } from './user-dashboard-layout.controller';
import { UserDashboardLayoutService } from './user-dashboard-layout.service';
import { UserController } from './user.controller';
import { UserModule } from './user.module';
import { UserService } from './user.service';

describe('UserDashboardLayoutController', () => {
  const layoutPath = '/api/v1/user/layout';

  const requestUserId = 'c0a8012e-4f7b-4d1a-9f3e-2b6d8c5a1e44';

  /**
   * The `updatedAt` the stubbed row reports, and therefore the concurrency token
   * every response below carries.
   *
   * Named rather than repeated, because it appears on both sides of the round trip:
   * a write answers with the token the row now holds, and the next write is
   * compared against exactly that.
   */
  const writtenRevision = '2026-01-01T00:00:00.000Z';

  /**
   * The secret the booted application is configured with, and therefore the only
   * one a token these endpoints accept can be signed with.
   */
  const jwtSecret = 'user-dashboard-layout-spec-secret';

  /**
   * Ghostfolio's own signer, the same one `AuthService` mints real tokens with.
   *
   * Used rather than reaching for `jsonwebtoken` directly: `@nestjs/jwt` is a
   * pinned direct dependency of this workspace and `jsonwebtoken` is only a
   * transitive one, so signing through it keeps this file's dependency surface
   * inside the lockfile's declared set.
   */
  const jwtService = new JwtService({ secret: jwtSecret });

  /**
   * A user record shaped the way `JwtStrategy.validate` needs it.
   *
   * `settings.settings` is not optional to the strategy: it reads
   * `user.settings.settings.baseCurrency` and `.language` and defaults each,
   * so a user double without that nesting fails inside `validate` and the
   * request comes back 401 for the wrong reason entirely.
   */
  const createUserRecord = (aUserId: string) => ({
    id: aUserId,
    permissions: [],
    role: 'USER',
    settings: { settings: { baseCurrency: 'CHF', language: 'en' } }
  });

  const storedLayout: UserDashboardLayout = {
    modules: [
      { cols: 6, moduleType: 'portfolio-overview', rows: 4, x: 0, y: 0 }
    ],
    version: 1
  };

  // The Prisma delegate is handed to Nest once, when the application boots, so
  // these functions are created once and reset between tests. Replacing them
  // per test would leave the booted application holding the previous set.
  const deleteMany = jest.fn();
  const findUnique = jest.fn();
  const updateMany = jest.fn();
  const upsert = jest.fn();

  /**
   * The user lookup `JwtStrategy` performs on every authenticated request.
   *
   * Held at this level for the same reason as the Prisma delegates - the booted
   * application captures it - and reset between tests so one group's identity
   * cannot answer another group's request.
   */
  const findUser = jest.fn();

  beforeEach(() => {
    deleteMany.mockReset();
    findUnique.mockReset();
    updateMany.mockReset();
    upsert.mockReset();
    findUser.mockReset();
  });

  /**
   * Boots the controller behind the same request pipeline `main.ts` builds, so
   * a request in this file travels the production path: URI versioning, the
   * `api` prefix, the strict global validation pipe and the guard tuple.
   *
   * Passing `authenticatedUserId` replaces only the passport guard, which is
   * how an authenticated identity is supplied without minting a token. Omitting
   * it leaves Ghostfolio's own guard in place, which is what makes the 401
   * assertions genuine rather than a restatement of a stub — and what lets the
   * `with a genuine bearer token` group below travel the real strategy end to
   * end. That group is why the override is safe to keep here: the guard stack is
   * exercised for real somewhere in this file, so the groups that override it are
   * scoped to the controller's own behaviour rather than standing in for the
   * authentication it sits behind.
   */
  async function createApplication({
    authenticatedUserId
  }: {
    authenticatedUserId?: string;
  }): Promise<INestApplication> {
    const testingModuleBuilder = Test.createTestingModule({
      controllers: [UserDashboardLayoutController],
      // The read handler is decorated with the shared
      // `PerformanceLoggingInterceptor`, and Nest resolves a method-scoped
      // enhancer out of the module the controller was registered in - so without
      // this import the endpoint fails at request time rather than at boot. It is
      // the same import `UserModule` carries in production, which is what makes a
      // request in this file travel the production instrumentation path too.
      imports: [PerformanceLoggingModule],
      providers: [
        // Ghostfolio's own passport strategy, registered for real. Without it
        // passport reports an unknown strategy and the response is a 500 instead
        // of the required 401; with it, a request without a bearer token fails in
        // the extractor and a request with one is verified against the configured
        // secret and resolved through the user lookup below.
        JwtStrategy,
        UserDashboardLayoutService,
        {
          provide: ConfigurationService,
          // Keyed rather than constant, and that matters: answering every key
          // with the secret would also enable the subscription feature, which
          // sends `validate()` into an analytics upsert this Prisma double does
          // not provide - turning a valid token into a 401 for a reason that has
          // nothing to do with authentication.
          useValue: {
            get: (aKey: string) =>
              aKey === 'JWT_SECRET_KEY' ? jwtSecret : undefined
          }
        },
        {
          provide: PrismaService,
          useValue: {
            userDashboardLayout: { deleteMany, findUnique, updateMany, upsert }
          }
        },
        { provide: UserService, useValue: { user: findUser } }
      ]
    });

    if (authenticatedUserId) {
      testingModuleBuilder.overrideGuard(AuthGuard('jwt')).useValue({
        canActivate: (context: ExecutionContext) => {
          // The identity is placed where passport would place it, because the
          // controller reads it from the request through `REQUEST` injection.
          context.switchToHttp().getRequest<{
            user: { id: string; permissions: string[] };
          }>().user = {
            id: authenticatedUserId,
            permissions: []
          };

          return true;
        }
      });
    }

    const module: TestingModule = await testingModuleBuilder.compile();

    // `forceCloseConnections` keeps teardown deterministic: the requests below
    // are issued with a keep-alive capable client, and an idle socket left over
    // from the last one must not be able to hold the server open.
    const app = module.createNestApplication({ forceCloseConnections: true });

    app.enableVersioning({ defaultVersion: '1', type: VersioningType.URI });
    app.setGlobalPrefix('api');
    app.useGlobalPipes(
      new ValidationPipe({
        forbidNonWhitelisted: true,
        transform: true,
        whitelist: true
      })
    );

    await app.listen(0, '127.0.0.1');

    return app;
  }

  async function request({
    app,
    authorization,
    method,
    path,
    payload
  }: {
    app: INestApplication;
    /** Sent verbatim, so a malformed header can be exercised as easily as a valid one. */
    authorization?: string;
    method: 'DELETE' | 'GET' | 'PATCH';
    path: string;
    payload?: unknown;
  }) {
    const { port } = (app.getHttpServer() as Server).address() as AddressInfo;

    const headers: Record<string, string> = {};

    if (authorization !== undefined) {
      headers.authorization = authorization;
    }

    if (payload !== undefined) {
      headers['content-type'] = 'application/json';
    }

    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      body: payload === undefined ? undefined : JSON.stringify(payload),
      headers: Object.keys(headers).length > 0 ? headers : undefined,
      method
    });

    // The raw text and the content type are captured alongside the parsed body,
    // because the wire representation is itself part of the contract: an absent
    // layout has to arrive as the JSON literal `null` with a JSON content type,
    // not as an empty body that only some clients coerce to `null`. Parsing is
    // deliberately not guarded against an empty body — a zero-byte response has
    // to surface as a failure rather than be silently normalised away.
    const text = await response.text();

    return {
      contentType: response.headers.get('content-type'),
      json: text === '' ? undefined : (JSON.parse(text) as unknown),
      status: response.status,
      text
    };
  }

  describe('without an authenticated request', () => {
    let app: INestApplication;

    // Booting an application is heavier than a unit test's default budget
    // allows for on a loaded machine, so both suites state their own.
    beforeAll(async () => {
      app = await createApplication({});
    }, 30000);

    afterAll(async () => {
      await app.close();
    });

    it('rejects a read with 401, because the passport guard runs first', async () => {
      const { status } = await request({
        app,
        method: 'GET',
        path: layoutPath
      });

      expect(status).toBe(401);
    });

    it('rejects a write with 401', async () => {
      const { status } = await request({
        app,
        method: 'PATCH',
        path: layoutPath,
        payload: storedLayout
      });

      expect(status).toBe(401);
    });

    it('rejects a discard with 401', async () => {
      const { status } = await request({
        app,
        method: 'DELETE',
        path: layoutPath
      });

      expect(status).toBe(401);
    });

    it('never reaches the persistence layer', async () => {
      await request({ app, method: 'DELETE', path: layoutPath });
      await request({ app, method: 'GET', path: layoutPath });
      await request({
        app,
        method: 'PATCH',
        path: layoutPath,
        payload: storedLayout
      });

      expect(deleteMany).not.toHaveBeenCalled();
      expect(findUnique).not.toHaveBeenCalled();
      expect(upsert).not.toHaveBeenCalled();
    });
  });

  /**
   * The authenticated path travelled for real, from the `Authorization` header to
   * the persistence layer.
   *
   * Every other authenticated group in this file replaces `AuthGuard('jwt')` and
   * writes `request.user` itself, which is the right tool for asserting what the
   * controller does with an identity but says nothing about how it acquires one.
   * With only those groups, a regression anywhere along the acquisition chain -
   * bearer extraction, the configured secret, signature verification, expiry, the
   * user lookup, or the population of `request.user` that the controller reads
   * through `REQUEST` injection - left every "authenticated" case green while no
   * real credential would have been accepted, or worse, while the wrong one would.
   *
   * Nothing here is overridden. The token is minted with Ghostfolio's own signer
   * against the same secret the application is configured with, and it is verified
   * by the genuine `JwtStrategy` resolving a genuine user record. The negative
   * cases matter as much as the positive one: they are what shows the acceptance
   * is conditional, and each of them travels the same real chain.
   */
  describe('with a genuine bearer token', () => {
    let app: INestApplication;

    /**
     * The user lookup as the real one behaves: an identity it knows resolves to
     * that user, and anything else - a deleted account, or an absent identity -
     * resolves nobody.
     *
     * Id-aware rather than a constant, and that is load-bearing: a lookup that
     * answers every argument with the same user makes the strategy appear to
     * accept a token whose payload names no identity at all, which is the exact
     * class of defect this group exists to catch.
     */
    const knowUsers = (...userIds: string[]) => {
      findUser.mockImplementation(({ id }: { id?: string }) => {
        return Promise.resolve(
          typeof id === 'string' && userIds.includes(id)
            ? createUserRecord(id)
            : null
        );
      });
    };

    beforeAll(async () => {
      app = await createApplication({});
    }, 30000);

    afterAll(async () => {
      await app.close();
    });

    it('admits a read carrying a token signed with the configured secret', async () => {
      knowUsers(requestUserId);
      findUnique.mockResolvedValue({
        layoutData: storedLayout,
        userId: requestUserId
      });

      const { json, status } = await request({
        app,
        authorization: `Bearer ${jwtService.sign({ id: requestUserId })}`,
        method: 'GET',
        path: layoutPath
      });

      expect(status).toBe(200);
      expect(json).toEqual(storedLayout);

      // The whole chain is asserted, not merely the status: the strategy resolved
      // the identity the token names, and the row was read for that identity.
      expect(findUser).toHaveBeenCalledWith({ id: requestUserId });
      expect(findUnique).toHaveBeenCalledWith({
        where: { userId: requestUserId }
      });
    });

    it('admits a write carrying a token signed with the configured secret', async () => {
      knowUsers(requestUserId);
      upsert.mockResolvedValue({
        layoutData: storedLayout,
        userId: requestUserId
      });

      const { json, status } = await request({
        app,
        authorization: `Bearer ${jwtService.sign({ id: requestUserId })}`,
        method: 'PATCH',
        path: layoutPath,
        payload: storedLayout
      });

      expect(status).toBe(200);
      expect(json).toEqual(storedLayout);
      expect(upsert).toHaveBeenCalledTimes(1);
    });

    it('writes for the identity the token names and no other', async () => {
      const otherUserId = '7b1f4c2a-9d3e-4a58-8c61-0e2f5a7b3d19';

      knowUsers(otherUserId);
      upsert.mockResolvedValue({
        layoutData: storedLayout,
        userId: otherUserId
      });

      const { status } = await request({
        app,
        authorization: `Bearer ${jwtService.sign({ id: otherUserId })}`,
        method: 'PATCH',
        path: layoutPath,
        payload: storedLayout
      });

      expect(status).toBe(200);

      // The identity is taken from the verified token every time, so two viewers
      // holding two tokens cannot write to one row.
      const [{ where }] = upsert.mock.calls[0] as [{ where: unknown }];

      expect(where).toEqual({ userId: otherUserId });
      expect(findUser).toHaveBeenCalledWith({ id: otherUserId });
    });

    it.each([
      {
        authorization: () =>
          `Bearer ${new JwtService({ secret: 'a-different-secret' }).sign({
            id: requestUserId
          })}`,
        description: 'a token signed with a secret this deployment does not use'
      },
      {
        authorization: () =>
          `Bearer ${jwtService.sign({ id: requestUserId }, { expiresIn: '-1s' })}`,
        description: 'a token that has expired'
      },
      {
        authorization: () => 'Bearer not-a-json-web-token',
        description: 'a bearer value that is not a token at all'
      },
      {
        authorization: () => `Basic ${jwtService.sign({ id: requestUserId })}`,
        description: 'a valid token offered under the wrong scheme'
      },
      {
        authorization: () => 'Bearer ',
        description: 'an empty bearer value'
      }
    ])(
      'refuses $description with 401 and reaches no data',
      async ({ authorization }) => {
        // Deliberately made to know this user, so a refusal cannot be mistaken
        // for a lookup that simply found nobody.
        knowUsers(requestUserId);

        for (const method of ['GET', 'PATCH'] as const) {
          const { status } = await request({
            app,
            authorization: authorization(),
            method,
            path: layoutPath,
            payload: method === 'PATCH' ? storedLayout : undefined
          });

          expect(status).toBe(401);
        }

        // Verification fails before the identity is resolved, so a rejected
        // credential costs no query at all - and, decisively, the layout of the
        // user the token *claimed* to be is never read or written.
        expect(findUser).not.toHaveBeenCalled();
        expect(findUnique).not.toHaveBeenCalled();
        expect(upsert).not.toHaveBeenCalled();
      }
    );

    it('refuses a validly signed token whose user no longer exists', async () => {
      // The signature verifies and the payload is well formed, so this is the one
      // rejection that happens *after* the lookup: an account deleted while a
      // token was still in a browser must not keep working.
      knowUsers();

      const { status } = await request({
        app,
        authorization: `Bearer ${jwtService.sign({ id: requestUserId })}`,
        method: 'GET',
        path: layoutPath
      });

      expect(status).toBe(401);
      expect(findUser).toHaveBeenCalledWith({ id: requestUserId });
      expect(findUnique).not.toHaveBeenCalled();
    });

    it('refuses a token whose payload carries no identity', async () => {
      knowUsers(requestUserId);

      const { status } = await request({
        app,
        authorization: `Bearer ${jwtService.sign({ sub: requestUserId })}`,
        method: 'GET',
        path: layoutPath
      });

      // `validate()` destructures `id` from the payload and looks it up, so a
      // payload naming the identity under some other claim resolves nobody.
      expect(status).toBe(401);
      expect(findUser).toHaveBeenCalledWith({ id: undefined });
      expect(findUnique).not.toHaveBeenCalled();
    });
  });

  describe('with an authenticated request', () => {
    let app: INestApplication;

    beforeAll(async () => {
      app = await createApplication({ authenticatedUserId: requestUserId });
    }, 30000);

    afterAll(async () => {
      await app.close();
    });

    describe('reading the layout', () => {
      it('is served at exactly /api/v1/user/layout', async () => {
        findUnique.mockResolvedValue({
          layoutData: storedLayout,
          userId: requestUserId
        });

        const versioned = await request({
          app,
          method: 'GET',
          path: layoutPath
        });
        const unversioned = await request({
          app,
          method: 'GET',
          path: '/api/user/layout'
        });
        const unprefixed = await request({
          app,
          method: 'GET',
          path: '/v1/user/layout'
        });

        expect(versioned.status).toBe(200);
        expect(unversioned.status).toBe(404);
        expect(unprefixed.status).toBe(404);
      });

      it('returns the stored document unwrapped, without the row envelope', async () => {
        findUnique.mockResolvedValue({
          layoutData: storedLayout,
          updatedAt: new Date('2026-01-01T00:00:00.000Z'),
          userId: requestUserId
        });

        const { json, status } = await request({
          app,
          method: 'GET',
          path: layoutPath
        });

        expect(status).toBe(200);

        // The stored document plus the row's concurrency token, and nothing else off
        // the row: the token is derived from `updatedAt` so that the next write can
        // be conditional on the revision this read observed.
        expect(json).toEqual({ ...storedLayout, revision: writtenRevision });
        expect(Object.keys(json as object).sort()).toEqual([
          'modules',
          'revision',
          'version'
        ]);
        expect(json).not.toHaveProperty('layoutData');
        expect(json).not.toHaveProperty('updatedAt');
        expect(json).not.toHaveProperty('userId');
      });

      it.each([
        { description: 'no stored row at all', row: null },
        {
          description: 'a row whose layout column reads back as null',
          row: {
            layoutData: null,
            userId: 'c0a8012e-4f7b-4d1a-9f3e-2b6d8c5a1e44'
          }
        }
      ])(
        'reports $description as the JSON literal null, neither as an empty body nor as a fabricated document nor as a 404',
        async ({ row }) => {
          findUnique.mockResolvedValue(row);

          const { contentType, json, status, text } = await request({
            app,
            method: 'GET',
            path: layoutPath
          });

          expect(status).toBe(200);
          expect(text).toBe('null');
          expect(contentType).toMatch(/^application\/json/);
          expect(json).toBeNull();
          expect(JSON.parse(text)).toBeNull();
        }
      );

      it('returns a stored empty layout as a document, keeping it distinct from an absent one', async () => {
        const emptyLayout: UserDashboardLayout = { modules: [], version: 1 };

        findUnique.mockResolvedValue({
          layoutData: emptyLayout,
          userId: requestUserId
        });

        const { contentType, json, status, text } = await request({
          app,
          method: 'GET',
          path: layoutPath
        });

        expect(status).toBe(200);
        expect(text).not.toBe('null');
        expect(contentType).toMatch(/^application\/json/);
        expect(json).not.toBeNull();
        expect(json).toEqual(emptyLayout);
      });

      it('reads the row keyed by the authenticated user, never by an identifier the caller supplies', async () => {
        findUnique.mockResolvedValue(null);

        await request({
          app,
          method: 'GET',
          path: `${layoutPath}?userId=a-different-user`
        });

        expect(findUnique).toHaveBeenCalledTimes(1);
        expect(findUnique).toHaveBeenCalledWith({
          where: { userId: requestUserId }
        });
      });

      it('is timed by the shared performance instrumentation, and says nothing else', async () => {
        findUnique.mockResolvedValue({
          layoutData: storedLayout,
          userId: requestUserId
        });

        // `debug` is where the shared authority reports: this endpoint carries a
        // stated p95 budget, and `PerformanceLoggingService` - the one service
        // every timing in this application is emitted through - writes it at that
        // level. Which environments keep it is a deployment decision made once
        // through `LOG_LEVELS`, not a decision this controller takes for itself;
        // what is asserted here is that the timing exists and travels the shared
        // path, so a budget is measurable rather than merely stated.
        const loggerDebug = jest
          .spyOn(Logger, 'debug')
          .mockImplementation(() => undefined);

        try {
          await request({
            app,
            method: 'GET',
            path: `${layoutPath}?userId=a-different-user`
          });

          expect(loggerDebug).toHaveBeenCalledTimes(1);

          const [message, context] = loggerDebug.mock.calls[0] as [
            string,
            string
          ];

          expect(context).toBe('UserDashboardLayoutController');
          expect(message).toMatch(
            /^Completed execution of getUserDashboardLayout\(\) in \d+\.\d{3} seconds$/
          );

          // Nothing about who asked, what they asked with, or what came back. The
          // handler's class, the handler's own name and an elapsed time are the
          // whole of it.
          const emitted = `${message} ${context}`;

          expect(emitted).not.toContain(requestUserId);
          expect(emitted).not.toContain('a-different-user');
          expect(emitted).not.toContain('portfolio-overview');
          expect(emitted).not.toContain(layoutPath);
        } finally {
          loggerDebug.mockRestore();
        }
      });

      it('leaves the write untimed, because only the read carries a budget', async () => {
        upsert.mockResolvedValue({
          layoutData: storedLayout,
          userId: requestUserId
        });

        const loggerDebug = jest
          .spyOn(Logger, 'debug')
          .mockImplementation(() => undefined);

        try {
          await request({
            app,
            method: 'PATCH',
            path: layoutPath,
            payload: storedLayout
          });

          // Method-scoped rather than controller-scoped, deliberately: a line per
          // save would say nothing about anything a budget is stated for, and every
          // drag produces one.
          expect(loggerDebug).not.toHaveBeenCalled();
        } finally {
          loggerDebug.mockRestore();
        }
      });
    });

    describe('writing the layout', () => {
      function respondWithWrittenDocument() {
        upsert.mockImplementation(
          ({ create }: { create: { layoutData: UserDashboardLayout } }) => {
            return Promise.resolve({
              layoutData: create.layoutData,
              updatedAt: new Date(writtenRevision),
              userId: requestUserId
            });
          }
        );
      }

      it('persists the submitted snapshot and answers 200 with the persisted document', async () => {
        const payload: UpdateUserDashboardLayoutDto = {
          modules: [{ cols: 4, moduleType: 'holdings', rows: 4, x: 0, y: 0 }],
          version: 1
        };

        respondWithWrittenDocument();

        const { json, status } = await request({
          app,
          method: 'PATCH',
          path: layoutPath,
          payload
        });

        expect(status).toBe(200);

        // The submitted document plus the row's concurrency token, which is
        // transport-only: it is what the next write is compared against, and it is
        // never part of the stored `layoutData`.
        expect(json).toEqual({ ...payload, revision: writtenRevision });
        expect(Object.keys(json as object).sort()).toEqual([
          'modules',
          'revision',
          'version'
        ]);
      });

      it('accepts an empty module list, so removing the last module is persistable', async () => {
        respondWithWrittenDocument();

        const { json, status } = await request({
          app,
          method: 'PATCH',
          path: layoutPath,
          payload: { modules: [] }
        });

        expect(status).toBe(200);
        expect(json).toEqual({ modules: [], revision: writtenRevision });
        expect(upsert).toHaveBeenCalledTimes(1);
      });

      it('accepts a payload that omits the version', async () => {
        const payload = {
          modules: [{ cols: 4, moduleType: 'watchlist', rows: 3, x: 8, y: 0 }]
        };

        respondWithWrittenDocument();

        const { json, status } = await request({
          app,
          method: 'PATCH',
          path: layoutPath,
          payload
        });

        expect(status).toBe(200);
        expect(json).toEqual({ ...payload, revision: writtenRevision });
      });

      /**
       * The write and the read have to agree on what a valid envelope is, and this
       * is what pins that agreement end to end rather than at the boundary alone.
       *
       * Every version this endpoint accepts must still be readable afterwards. The
       * defect this covers was precisely a disagreement: the writer admitted
       * `version: null` and the reader - correctly - refused a declared version it
       * does not support, leaving the row permanently unreadable with no way back
       * from inside the application. Rejecting the write is what keeps the two in
       * step, so the round trip is asserted for both accepted forms.
       */
      it.each([
        { description: 'the supported version', version: 1 },
        { description: 'no version at all', version: undefined }
      ])(
        'keeps a document written with $description readable afterwards',
        async ({ version }) => {
          const modules = [
            { cols: 4, moduleType: 'holdings', rows: 4, x: 0, y: 0 }
          ];
          const payload =
            version === undefined ? { modules } : { modules, version };

          respondWithWrittenDocument();

          const written = await request({
            app,
            method: 'PATCH',
            path: layoutPath,
            payload
          });

          expect(written.status).toBe(200);

          // Destructured through a typed tuple rather than indexed, exactly as the
          // `where` assertion above does it. A `jest.fn()` records its calls as
          // `any[]`, so reading `calls[0][0].create.layoutData` would carry that
          // `any` into the value the read below is then driven from - which is the
          // one place in this round trip where an unchecked value would quietly make
          // the assertion vacuous.
          const [{ create }] = upsert.mock.calls[0] as [
            { create: { layoutData: Prisma.JsonValue } }
          ];

          // The row now holds exactly what the write persisted, which is what the
          // read has to be able to interpret.
          findUnique.mockResolvedValue({
            layoutData: create.layoutData,
            updatedAt: new Date(writtenRevision),
            userId: requestUserId
          });

          const read = await request({ app, method: 'GET', path: layoutPath });

          expect(read.status).toBe(200);
          expect(read.json).toEqual({ ...payload, revision: writtenRevision });
        }
      );

      /**
       * One row, one document - whichever verb is asked.
       *
       * The round trip above pins each verb against the payload; this pins the two
       * verbs against EACH OTHER, which is a different assertion and the one that
       * failed. The write used to answer with the stored value asserted to be a
       * layout, while the read answered with the value put through the five-field
       * projection - so for any row the projection would alter, the same row
       * returned two different documents depending on how it was asked, and the
       * write's answer was the one that did not hold to its declared type. Both
       * verbs now answer through the same projection.
       *
       * Asserted on the DOCUMENTS rather than on which function was called, so it
       * keeps holding however the projection is implemented, and asserted against
       * a stored value taken from what the write actually persisted rather than
       * from the payload, so the row the read is served really is the row the write
       * made.
       */
      it('answers a write with the same document a read of that row answers', async () => {
        const payload = {
          modules: [
            { cols: 6, moduleType: 'portfolio-overview', rows: 4, x: 0, y: 0 },
            { cols: 4, moduleType: 'watchlist', rows: 3, x: 8, y: 0 }
          ],
          version: 1
        };

        respondWithWrittenDocument();

        const written = await request({
          app,
          method: 'PATCH',
          path: layoutPath,
          payload
        });

        const [{ create }] = upsert.mock.calls[0] as [
          { create: { layoutData: Prisma.JsonValue } }
        ];

        findUnique.mockResolvedValue({
          layoutData: create.layoutData,
          updatedAt: new Date('2026-01-01T00:00:00.000Z'),
          userId: requestUserId
        });

        const read = await request({ app, method: 'GET', path: layoutPath });

        expect(written.status).toBe(200);
        expect(read.status).toBe(200);

        // The assertion this test exists for: one row, one document, whichever verb
        // asked for it - token included, since both verbs read the token off the same
        // row.
        expect(written.json).toEqual(read.json);

        // And that document is the submitted arrangement, plus the row's concurrency
        // token. The token is transport-only - it describes the row rather than the
        // arrangement and is never part of the stored `layoutData` - so it is the one
        // member the payload cannot carry.
        expect(written.json).toEqual({ ...payload, revision: writtenRevision });
      });

      // `watchlist` is spelled at exactly its own declared minimum - four columns
      // by three rows - rather than at the grid-wide 2x2 floor, because the two
      // bounds are now both enforced and the narrower one wins. That makes each
      // case doubly inclusive: it proves the grid edge is reachable *and* that a
      // module sized exactly to its declared minimum is accepted rather than
      // rejected by one cell.
      it.each([
        {
          description:
            'a module whose columns end exactly at the right edge of the grid',
          module: { cols: 4, moduleType: 'watchlist', rows: 3, x: 8, y: 0 }
        },
        {
          description:
            'a module whose rows end exactly at the bottom of the grid',
          module: { cols: 4, moduleType: 'watchlist', rows: 3, x: 0, y: 97 }
        },
        {
          // Exactly the AI chat module's own declared minimum, which is the
          // strictest in the catalog. The two rejections below sit one cell inside
          // each of these dimensions, so without this case both could be satisfied
          // by a rule that was off by one in the rejecting direction.
          description: 'a known module sized exactly to its declared minimum',
          module: { cols: 3, moduleType: 'ai-chat', rows: 5, x: 0, y: 0 }
        },
        {
          // A discriminator the catalog does not know carries no declared minimum
          // to measure, so only the grid-wide floor applies to it. That is
          // deliberate rather than a gap: an arrangement holding a module that has
          // since been withdrawn has to stay writable, and such an entry is dropped
          // per item when the layout is read.
          description: 'an unknown module type at the grid-wide floor',
          module: {
            cols: 2,
            moduleType: 'some-future-module',
            rows: 2,
            x: 0,
            y: 0
          }
        },
        {
          description: 'a module type of exactly the maximum length',
          module: {
            cols: 2,
            moduleType: 'm'.repeat(64),
            rows: 2,
            x: 0,
            y: 0
          }
        },
        {
          description: 'a document holding exactly the maximum module count',
          module: undefined,
          modules: Array.from({ length: 300 }, (_unused, index) => ({
            cols: 2,
            moduleType: `module-${index}`,
            rows: 2,
            x: 0,
            y: 0
          }))
        }
      ])(
        'accepts $description, so the bound is inclusive',
        async ({ module: aModule, modules }) => {
          // The inclusive counterpart of a rejection below. Without it a bound
          // could be tightened by one - `@Max(11)` becoming `@Max(10)`, the grid
          // constraint becoming strictly-less-than - and every rejection test
          // would still pass while a legitimate arrangement was refused.
          const payload = { modules: modules ?? [aModule], version: 1 };

          respondWithWrittenDocument();

          const { status } = await request({
            app,
            method: 'PATCH',
            path: layoutPath,
            payload
          });

          expect(status).toBe(200);
          expect(upsert).toHaveBeenCalledTimes(1);
        }
      );

      it('persists a module type it has never heard of, because the registry owns that vocabulary', async () => {
        const payload = {
          modules: [
            { cols: 3, moduleType: 'some-future-module', rows: 3, x: 0, y: 0 }
          ],
          version: 1
        };

        respondWithWrittenDocument();

        const { json, status } = await request({
          app,
          method: 'PATCH',
          path: layoutPath,
          payload
        });

        expect(status).toBe(200);
        expect(upsert).toHaveBeenCalledWith({
          create: { layoutData: payload, userId: requestUserId },
          update: { layoutData: payload },
          where: { userId: requestUserId }
        });
        expect(json).toEqual({ ...payload, revision: writtenRevision });
      });

      it('writes the row keyed by the authenticated user', async () => {
        respondWithWrittenDocument();

        await request({
          app,
          method: 'PATCH',
          path: layoutPath,
          payload: { modules: [] }
        });

        expect(upsert).toHaveBeenCalledTimes(1);
        expect(upsert).toHaveBeenCalledWith({
          create: { layoutData: { modules: [] }, userId: requestUserId },
          update: { layoutData: { modules: [] } },
          where: { userId: requestUserId }
        });
      });

      it.each([
        {
          description: 'a payload without a module list',
          payload: {}
        },
        {
          // The whole non-object category, at the boundary that has to refuse it.
          //
          // `@ValidateNested({ each: true })` descends into an element and reports
          // what the element's own rules report; it does not assert that the
          // element is an object. An element that is itself an EMPTY array offers
          // nothing to descend into, so no item rule ran and this exact request
          // used to answer 200 and reach storage - while the three below it were
          // always refused, because each of them does have something to descend
          // into. The read path drops such an entry, so nothing was lost; but the
          // five-field-per-item contract was not enforced here, and every later
          // read of that row reported a dropped item. The case that escaped is the
          // one nobody would have thought to write down, which is why its whole
          // category is now spelled out.
          description: 'a module entry that is an empty array',
          payload: { modules: [[]] }
        },
        {
          description: 'a module entry that is a populated array',
          payload: { modules: [[1, 2, 3]] }
        },
        {
          description: 'a module entry that is null',
          payload: { modules: [null] }
        },
        {
          description: 'a module entry that is a string',
          payload: { modules: ['holdings'] }
        },
        {
          description:
            'a list in which only one entry among valid ones is not an object',
          payload: {
            modules: [
              { cols: 4, moduleType: 'holdings', rows: 4, x: 0, y: 0 },
              [],
              { cols: 4, moduleType: 'holdings', rows: 4, x: 4, y: 0 }
            ]
          }
        },
        {
          description: 'a module narrower than the two column minimum',
          payload: {
            modules: [{ cols: 1, moduleType: 'holdings', rows: 4, x: 0, y: 0 }]
          }
        },
        {
          description: 'a module wider than the twelve column grid',
          payload: {
            modules: [{ cols: 13, moduleType: 'holdings', rows: 4, x: 0, y: 0 }]
          }
        },
        {
          description: 'a module shorter than the two row minimum',
          payload: {
            modules: [{ cols: 4, moduleType: 'holdings', rows: 1, x: 0, y: 0 }]
          }
        },
        {
          description: 'a module whose column origin is off the grid',
          payload: {
            modules: [{ cols: 4, moduleType: 'holdings', rows: 4, x: 12, y: 0 }]
          }
        },
        {
          description: 'a module without a type',
          payload: {
            modules: [{ cols: 4, moduleType: '', rows: 4, x: 0, y: 0 }]
          }
        },
        {
          // Every per-field bound is satisfied - `x` is within 0..11 and `cols`
          // within 2..12 - and the placement is still impossible, because the two
          // together span columns 11 and 12 of a grid that ends at 11. Only the
          // cross-field rule can reject this, so this case is the only thing
          // standing between that rule and silent removal. The existing `x: 12`
          // case cannot serve: it fails `@Max(11)` first.
          //
          // The module type is deliberately one the catalog does not know, which
          // is what keeps this case a probe of the grid rule alone: every module
          // that *is* known declares a minimum of at least three columns, so
          // naming one would fail the declared-minimum rule first and this test
          // would pass whether the grid rule existed or not.
          description: 'a module whose columns overflow the right edge',
          payload: {
            modules: [
              {
                cols: 2,
                moduleType: 'some-future-module',
                rows: 2,
                x: 11,
                y: 0
              }
            ]
          }
        },
        {
          // The vertical half of the same rule, and likewise unreachable through
          // the per-field bounds: `y` is within 0..99 and `rows` within 2..100.
          description: 'a module whose rows overflow the bottom of the grid',
          payload: {
            modules: [
              {
                cols: 2,
                moduleType: 'some-future-module',
                rows: 2,
                x: 0,
                y: 99
              }
            ]
          }
        },
        {
          // The declared-minimum rule, horizontally. Every other bound is
          // satisfied - two columns clears the grid-wide floor and the placement
          // fits - and the arrangement is still one the grid engine would never
          // have let a person produce, because the AI chat module declares three
          // columns as its own minimum. Without this rule the footprint could only
          // be enforced in the browser, and a hand-written request would store a
          // module at a size no resize could reach.
          description: 'a known module narrower than its own declared minimum',
          payload: {
            modules: [{ cols: 2, moduleType: 'ai-chat', rows: 5, x: 0, y: 0 }]
          }
        },
        {
          // The vertical half of the same rule: the AI chat module declares five
          // rows, so four is a rejection even though it clears the grid-wide floor
          // of two.
          description: 'a known module shorter than its own declared minimum',
          payload: {
            modules: [{ cols: 3, moduleType: 'ai-chat', rows: 4, x: 0, y: 0 }]
          }
        },
        {
          // `forbidNonWhitelisted` has to reach *into* the array. A surplus member
          // on the document itself is covered by the identity case below, but a
          // nested one is only rejected because the item type is declared with
          // `@Type()` and validated with `@ValidateNested({ each: true })`;
          // without either, this payload would be stored verbatim into a JSONB
          // column that the client later reads back.
          description: 'a module carrying a property of its own',
          payload: {
            modules: [
              {
                cols: 4,
                moduleType: 'holdings',
                rows: 4,
                surplus: 'unexpected',
                x: 0,
                y: 0
              }
            ]
          }
        },
        {
          // The five cases below are one defect, and it is the reason `modules`
          // carries a structural guard as well as nested validation. Nested
          // validation admits an element that is "object OR array" and, for an
          // array element, measures that array's MEMBERS instead of refusing the
          // element - so an element that is an array was reached by no item rule
          // of its own. An empty one has no members at all, which is how this
          // exact payload was accepted, stored, and then read back WITHOUT the
          // entry, because the read projection drops what it cannot interpret:
          // one row answering a write and a read with different documents.
          //
          // Kept as five rather than one because each closes a different half of
          // the hole and any single one of them could pass while the others did
          // not: nothing inside, several of them, something VALID inside, one
          // alongside a genuine item, and nesting a level deeper.
          description:
            'a module list holding an empty array where an item belongs',
          payload: { modules: [[]] }
        },
        {
          description: 'a module list holding several empty arrays',
          payload: { modules: [[], [], []] }
        },
        {
          // The case a member-level rule cannot catch. Its one member IS a valid
          // item, so descending into it reports nothing and the element travelled
          // into the column as a nested array - which is why the guard has to be
          // about the element's own type rather than about what it contains.
          description: 'a module list holding an array that wraps a valid item',
          payload: {
            modules: [
              [{ cols: 4, moduleType: 'holdings', rows: 4, x: 0, y: 0 }]
            ]
          }
        },
        {
          // Mixed with a legitimate item, so the whole request must be refused
          // rather than the good entry saved and the bad one silently dropped.
          description: 'a module list holding a valid item alongside an array',
          payload: {
            modules: [
              { cols: 4, moduleType: 'holdings', rows: 4, x: 0, y: 0 },
              []
            ]
          }
        },
        {
          description: 'a module list holding an array of arrays',
          payload: { modules: [[[]]] }
        },
        {
          // One past the declared ceiling. The body parser allows 10 MiB, so
          // without a maximum size a single request could persist hundreds of
          // thousands of items into one document.
          description: 'a document holding one module too many',
          payload: {
            modules: Array.from({ length: 301 }, (_unused, index) => ({
              cols: 2,
              moduleType: `module-${index}`,
              rows: 2,
              x: 0,
              y: 0
            }))
          }
        },
        {
          // One past the declared length. A module type is a machine identifier
          // and is deliberately not checked against a vocabulary, so its length is
          // the only thing keeping an unbounded string out of persistent storage.
          description: 'a module type one character too long',
          payload: {
            modules: [
              { cols: 4, moduleType: 'm'.repeat(65), rows: 4, x: 0, y: 0 }
            ]
          }
        },
        {
          // PostgreSQL cannot store a NUL inside a JSONB document, so without a
          // control-character rule this payload satisfies every declared bound,
          // reaches the driver and surfaces as a 500 instead of a 400.
          description: 'a module type carrying a NUL character',
          payload: {
            modules: [{ cols: 4, moduleType: 'a\u0000b', rows: 4, x: 0, y: 0 }]
          }
        },
        {
          description: 'a module type carrying a lone surrogate',
          payload: {
            modules: [{ cols: 4, moduleType: 'a\ud800b', rows: 4, x: 0, y: 0 }]
          }
        },
        {
          description: 'a document of an unsupported version',
          payload: { modules: [], version: 2 }
        },
        {
          // The one bypass an `@IsOptional()` discriminator leaves open, and the
          // reason this DTO gates on absence instead: `@IsOptional()` skips every
          // remaining validator for `null` as well as for `undefined`, so an
          // explicit `null` was accepted here, stored verbatim, and then refused
          // by the reader on every subsequent request - a write that succeeded and
          // a layout that could never be read again. It must be rejected exactly
          // as `0`, `2` and `"1"` are.
          description: 'a version declared as null',
          payload: {
            modules: [{ cols: 4, moduleType: 'holdings', rows: 4, x: 0, y: 0 }],
            version: null
          }
        },
        {
          description: 'a version declared as a string',
          payload: { modules: [], version: '1' }
        },
        {
          description: 'a version declared as zero',
          payload: { modules: [], version: 0 }
        },
        {
          description: 'a payload that carries an identity of its own',
          payload: {
            modules: [{ cols: 4, moduleType: 'holdings', rows: 4, x: 0, y: 0 }],
            userId: 'a-different-user'
          }
        },
        {
          // `@ValidateNested` validates whatever each member turns out to be, and
          // an array is a member it recurses into rather than refuses - so this
          // payload used to answer 200, echo its nested arrays back, and sit in the
          // JSONB column until the owner's next edit, while every subsequent read
          // reported the document as empty because the reader rebuilds each item
          // from five named fields and an array has none. Refusing a member that is
          // not an object is what makes the write and the read describe the same
          // document.
          description: 'a module list holding an array instead of a module',
          payload: {
            modules: [
              [{ cols: 4, moduleType: 'holdings', rows: 4, x: 0, y: 0 }]
            ],
            version: 1
          }
        },
        {
          description: 'a module list holding a bare string',
          payload: { modules: ['holdings'], version: 1 }
        },
        {
          description: 'a module list holding a null',
          payload: { modules: [null], version: 1 }
        }
      ])('rejects $description with 400', async ({ payload }) => {
        const { status } = await request({
          app,
          method: 'PATCH',
          path: layoutPath,
          payload
        });

        expect(status).toBe(400);
        expect(upsert).not.toHaveBeenCalled();
      });
    });

    /**
     * The escape from a stored arrangement this build cannot interpret.
     *
     * It has to be a DELETE rather than a write, and that is the point being pinned
     * here: the canvas refuses every write while it holds a layout it could not
     * read - which is what stops the error state from destroying the document that
     * caused it - so recovery cannot go through the write path without reopening
     * exactly the hole that protection exists to close.
     */
    describe('discarding the layout', () => {
      it('answers 204 with no body at all', async () => {
        deleteMany.mockResolvedValue({ count: 1 });

        const { contentType, status, text } = await request({
          app,
          method: 'DELETE',
          path: layoutPath
        });

        // 204 rather than an empty 200: Nest's Express adapter answers a nil handler
        // result with no `Content-Type` at all, which is not valid JSON and fails any
        // consumer stricter than Angular's `HttpClient`. A 204 states the absence of
        // a body as part of the status.
        expect(status).toBe(204);
        expect(text).toBe('');
        expect(contentType).toBeNull();
      });

      it('deletes only the authenticated caller row, keyed by identity rather than by payload', async () => {
        deleteMany.mockResolvedValue({ count: 1 });

        await request({ app, method: 'DELETE', path: layoutPath });

        expect(deleteMany).toHaveBeenCalledTimes(1);
        expect(deleteMany).toHaveBeenCalledWith({
          where: { userId: requestUserId }
        });
      });

      it('succeeds when there was nothing saved, so discarding is idempotent', async () => {
        deleteMany.mockResolvedValue({ count: 0 });

        const { status } = await request({
          app,
          method: 'DELETE',
          path: layoutPath
        });

        expect(status).toBe(204);
      });

      it('writes no arrangement, so recovery is not a second write origin', async () => {
        deleteMany.mockResolvedValue({ count: 1 });

        await request({ app, method: 'DELETE', path: layoutPath });

        expect(updateMany).not.toHaveBeenCalled();
        expect(upsert).not.toHaveBeenCalled();
      });
    });

    /**
     * What happens when two clients of one account edit the same arrangement.
     *
     * Every write is a complete snapshot, so without a revision to compare, a tab
     * that moved one module would restore every other module to whatever it last
     * read - silently discarding what another tab had already saved. The token makes
     * that submission refusable, and the refusal is a 409 so the client can offer its
     * viewer the choice rather than guess at one.
     */
    describe('a write carrying a concurrency token', () => {
      const staleRevision = '2025-06-01T00:00:00.000Z';

      it('applies the write only while the row still carries the revision it was built on', async () => {
        updateMany.mockResolvedValue({ count: 1 });
        findUnique.mockResolvedValue({
          layoutData: storedLayout,
          updatedAt: new Date(writtenRevision),
          userId: requestUserId
        });

        const { json, status } = await request({
          app,
          method: 'PATCH',
          path: layoutPath,
          payload: { ...storedLayout, revision: staleRevision }
        });

        expect(status).toBe(200);

        // The comparison is the WHERE clause of the write itself rather than a read
        // followed by a write, which is what makes it atomic: two conditional writes
        // racing on one row cannot both find it current.
        expect(updateMany).toHaveBeenCalledTimes(1);
        expect(updateMany).toHaveBeenCalledWith({
          data: { layoutData: storedLayout },
          where: {
            updatedAt: new Date(staleRevision),
            userId: requestUserId
          }
        });
        expect(upsert).not.toHaveBeenCalled();

        // The token never reaches storage - the stored shape stays exactly the two
        // envelope members - and the response carries the revision the write produced
        // so the client's next write is conditional on the row as it now stands.
        const [{ data }] = updateMany.mock.calls[0] as [
          { data: { layoutData: Record<string, unknown> } }
        ];

        expect(data.layoutData).not.toHaveProperty('revision');
        expect(json).toEqual({ ...storedLayout, revision: writtenRevision });
      });

      it('refuses a write built on a superseded revision with 409 and persists nothing', async () => {
        updateMany.mockResolvedValue({ count: 0 });

        const { json, status } = await request({
          app,
          method: 'PATCH',
          path: layoutPath,
          payload: { ...storedLayout, revision: staleRevision }
        });

        expect(status).toBe(409);
        expect(json).toMatchObject({
          message: 'The dashboard layout was changed elsewhere',
          statusCode: 409
        });
        expect(upsert).not.toHaveBeenCalled();
      });

      it('writes unconditionally when no token is sent, which is a first save and a deliberate overwrite', async () => {
        upsert.mockResolvedValue({
          layoutData: storedLayout,
          updatedAt: new Date(writtenRevision),
          userId: requestUserId
        });

        const { status } = await request({
          app,
          method: 'PATCH',
          path: layoutPath,
          payload: storedLayout
        });

        expect(status).toBe(200);
        expect(upsert).toHaveBeenCalledTimes(1);
        expect(updateMany).not.toHaveBeenCalled();
      });

      it('rejects a token that is not a date with 400, rather than treating it as no token', async () => {
        const { status } = await request({
          app,
          method: 'PATCH',
          path: layoutPath,
          payload: { ...storedLayout, revision: 'not-a-date' }
        });

        // Left unvalidated, `new Date('not-a-date')` would match no row and every
        // write would be refused as a conflict - a 409 for a client mistake that has
        // nothing to do with concurrency.
        expect(status).toBe(400);
        expect(updateMany).not.toHaveBeenCalled();
        expect(upsert).not.toHaveBeenCalled();
      });
    });

    /**
     * A stored document this build cannot interpret, answered as a conflict rather
     * than as a server error.
     *
     * The distinction is what the client acts on. A 500 says the server failed and
     * invites a retry; nothing failed here and no retry can succeed, because the row
     * holds the same document on every request. Answering with a retryable status
     * left a viewer whose stored `version` had moved ahead of their client locked out
     * of their own dashboard with nothing to press but "Try again" - six times, to the
     * same 500. A 409 is distinguishable, so the client can say what is wrong and
     * offer the one action that resolves it.
     */
    describe('a stored document this build cannot interpret', () => {
      let loggerError: jest.SpyInstance;

      beforeEach(() => {
        loggerError = jest
          .spyOn(Logger, 'error')
          .mockImplementation(() => undefined);
      });

      afterEach(() => {
        loggerError.mockRestore();
      });

      it.each([
        {
          description: 'a version this build does not know',
          layoutData: { modules: [], version: 2 }
        },
        { description: 'an envelope that is not an object', layoutData: '' },
        {
          description: 'an envelope holding no modules array',
          layoutData: { version: 1 }
        }
      ])(
        'answers 409 for $description, and stores nothing',
        async ({ layoutData }) => {
          findUnique.mockResolvedValue({
            layoutData,
            updatedAt: new Date(writtenRevision),
            userId: requestUserId
          });

          const { json, status } = await request({
            app,
            method: 'GET',
            path: layoutPath
          });

          expect(status).toBe(409);
          expect(json).toMatchObject({
            message: 'The stored dashboard layout could not be read',
            statusCode: 409
          });

          // The row survives for an operator to look at, and the reason category is
          // reported without any part of what was stored.
          expect(updateMany).not.toHaveBeenCalled();
          expect(upsert).not.toHaveBeenCalled();
          expect(deleteMany).not.toHaveBeenCalled();
          expect(loggerError).toHaveBeenCalled();
        }
      );
    });

    describe('when the persistence layer fails', () => {
      const internalFailure = 'connection terminated unexpectedly';

      let loggerError: jest.SpyInstance;

      // Nest reports an unhandled error through its own logger before replying.
      // That line is silenced for these two tests so a deliberately provoked
      // failure cannot be read as a real one in the suite output, and asserted
      // on rather than merely suppressed, because a failure the operator never
      // sees is as damaging as one the caller never sees.
      beforeEach(() => {
        loggerError = jest
          .spyOn(Logger.prototype, 'error')
          .mockImplementation(() => undefined);
      });

      afterEach(() => {
        loggerError.mockRestore();
      });

      it('answers a failing read with 500 rather than with the absent-layout body', async () => {
        findUnique.mockRejectedValue(new Error(internalFailure));

        const { json, status, text } = await request({
          app,
          method: 'GET',
          path: layoutPath
        });

        expect(status).toBe(500);
        expect(json).toEqual({
          message: 'Internal server error',
          statusCode: 500
        });
        expect(text).not.toBe('');
        expect(text).not.toBe('null');
        expect(text).not.toContain(internalFailure);
        expect(loggerError).toHaveBeenCalled();
      });

      it('answers a failing write with 500 and reports nothing as persisted', async () => {
        upsert.mockRejectedValue(new Error(internalFailure));

        const { json, status, text } = await request({
          app,
          method: 'PATCH',
          path: layoutPath,
          payload: storedLayout
        });

        expect(status).toBe(500);
        expect(json).toEqual({
          message: 'Internal server error',
          statusCode: 500
        });
        expect(text).not.toContain(internalFailure);
        expect(upsert).toHaveBeenCalledTimes(1);
        expect(loggerError).toHaveBeenCalled();
      });
    });
  });

  describe('guard configuration', () => {
    // Nest writes a handler's enhancer metadata onto the handler function
    // itself, and its guards read it back off `context.getHandler()`, so every
    // assertion below is made against that same function object.
    function handlerOf(
      name:
        | 'deleteUserDashboardLayout'
        | 'getUserDashboardLayout'
        | 'updateUserDashboardLayout'
    ) {
      return UserDashboardLayoutController.prototype[name];
    }

    it.each([
      { handler: 'deleteUserDashboardLayout' },
      { handler: 'getUserDashboardLayout' },
      { handler: 'updateUserDashboardLayout' }
    ] as const)(
      'guards $handler with the passport guard first and the permission guard second',
      ({ handler }) => {
        const guards = Reflect.getMetadata(
          '__guards__',
          handlerOf(handler)
        ) as unknown[];

        expect(guards).toHaveLength(2);
        expect(guards[0]).toBe(AuthGuard('jwt'));
        expect(guards[1]).toBe(HasPermissionGuard);
      }
    );

    it.each([
      { handler: 'deleteUserDashboardLayout' },
      { handler: 'getUserDashboardLayout' },
      { handler: 'updateUserDashboardLayout' }
    ] as const)(
      'annotates no required permission on $handler',
      ({ handler }) => {
        expect(
          Reflect.getMetadata(HAS_PERMISSION_KEY, handlerOf(handler))
        ).toBeUndefined();
      }
    );

    it('lets the permission guard through when nothing is annotated, so a 401 can never surface as a 403', () => {
      const hasPermissionGuard = new HasPermissionGuard(new Reflector());
      const context = new ExecutionContextHost(
        [{ user: undefined }],
        UserDashboardLayoutController,
        handlerOf('getUserDashboardLayout')
      );

      expect(hasPermissionGuard.canActivate(context)).toBe(true);
    });
  });

  describe('module wiring', () => {
    // Read through a computed member access for the same reason the guard suite
    // does it: Nest writes a handler's enhancer metadata onto the handler
    // function itself, and naming that function directly would be an unbound
    // method reference.
    function handlerOf(
      name:
        | 'deleteUserDashboardLayout'
        | 'getUserDashboardLayout'
        | 'updateUserDashboardLayout'
    ) {
      return UserDashboardLayoutController.prototype[name];
    }

    // The assertion lives here because `UserModule` cannot be booted in a unit
    // test — it reaches Redis and a Bull queue through `ActivitiesModule` — so
    // its metadata is read directly instead.
    it('registers the layout endpoints', () => {
      expect(Reflect.getMetadata('controllers', UserModule)).toContain(
        UserDashboardLayoutController
      );
      expect(Reflect.getMetadata('providers', UserModule)).toContain(
        UserDashboardLayoutService
      );
    });

    // Registration order is load-bearing here, so it is pinned rather than left to
    // whichever order reads tidily. `UserController` declares `@Delete(':id')`
    // annotated with the `deleteUser` permission; Nest registers controllers in the
    // order given and the router matches the first fitting declaration, so with that
    // controller first the discard resolved to `deleteUser` with `id: 'layout'` and
    // answered 403 to every viewer without administrative rights - which is every
    // viewer the recovery exists for. Nothing about it is visible in a type or at
    // build time; it only shows up as a status code at request time.
    it('declares the layout routes ahead of the parameterised user routes', () => {
      const controllers = Reflect.getMetadata(
        'controllers',
        UserModule
      ) as unknown[];

      expect(controllers.indexOf(UserDashboardLayoutController)).toBeLessThan(
        controllers.indexOf(UserController)
      );
    });

    it('imports the module that supplies the shared performance interceptor', () => {
      // The read is decorated with `PerformanceLoggingInterceptor`, and Nest
      // resolves a method-scoped enhancer out of the module the controller was
      // registered in - so this import is what makes the decoration work at all.
      // Its absence would not fail the build; it would fail every read at request
      // time, which is why it is pinned here rather than left implicit.
      const imports = Reflect.getMetadata('imports', UserModule) as unknown[];

      expect(imports).toContain(PerformanceLoggingModule);
    });

    it('times the read through the shared interceptor and leaves the write alone', () => {
      expect(
        Reflect.getMetadata(
          '__interceptors__',
          handlerOf('getUserDashboardLayout')
        )
      ).toEqual([PerformanceLoggingInterceptor]);

      expect(
        Reflect.getMetadata(
          '__interceptors__',
          handlerOf('updateUserDashboardLayout')
        )
      ).toBeUndefined();

      // The discard carries no latency budget either, so timing it would add a line
      // per recovery that says nothing about anything a budget is stated for.
      expect(
        Reflect.getMetadata(
          '__interceptors__',
          handlerOf('deleteUserDashboardLayout')
        )
      ).toBeUndefined();
    });
  });
});
