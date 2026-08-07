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
import { Server } from 'node:http';
import { AddressInfo } from 'node:net';

import { UserDashboardLayoutController } from './user-dashboard-layout.controller';
import { UserDashboardLayoutService } from './user-dashboard-layout.service';
import { UserModule } from './user.module';
import { UserService } from './user.service';

describe('UserDashboardLayoutController', () => {
  const layoutPath = '/api/v1/user/layout';

  const requestUserId = 'c0a8012e-4f7b-4d1a-9f3e-2b6d8c5a1e44';

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
  // per test would leave the booted application holding the previous pair.
  const findUnique = jest.fn();
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
    findUnique.mockReset();
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
          useValue: { userDashboardLayout: { findUnique, upsert } }
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
    method: 'GET' | 'PATCH';
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

    it('never reaches the persistence layer', async () => {
      await request({ app, method: 'GET', path: layoutPath });
      await request({
        app,
        method: 'PATCH',
        path: layoutPath,
        payload: storedLayout
      });

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
        expect(json).toEqual(storedLayout);
        expect(Object.keys(json as object).sort()).toEqual([
          'modules',
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
              updatedAt: new Date('2026-01-01T00:00:00.000Z'),
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
        expect(json).toEqual(payload);
        expect(Object.keys(json as object).sort()).toEqual([
          'modules',
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
        expect(json).toEqual({ modules: [] });
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
        expect(json).toEqual(payload);
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

          // The row now holds exactly what the write persisted, which is what the
          // read has to be able to interpret.
          findUnique.mockResolvedValue({
            layoutData: upsert.mock.calls[0][0].create.layoutData,
            updatedAt: new Date('2026-01-01T00:00:00.000Z'),
            userId: requestUserId
          });

          const read = await request({ app, method: 'GET', path: layoutPath });

          expect(read.status).toBe(200);
          expect(read.json).toEqual(payload);
        }
      );

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
        expect(json).toEqual(payload);
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
      name: 'getUserDashboardLayout' | 'updateUserDashboardLayout'
    ) {
      return UserDashboardLayoutController.prototype[name];
    }

    it.each([
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
      name: 'getUserDashboardLayout' | 'updateUserDashboardLayout'
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
    });
  });
});
