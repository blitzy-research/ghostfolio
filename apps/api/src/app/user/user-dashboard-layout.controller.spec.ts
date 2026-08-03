import { JwtStrategy } from '@ghostfolio/api/app/auth/jwt.strategy';
import { HAS_PERMISSION_KEY } from '@ghostfolio/api/decorators/has-permission.decorator';
import { HasPermissionGuard } from '@ghostfolio/api/guards/has-permission.guard';
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
import { AuthGuard } from '@nestjs/passport';
import { Test, TestingModule } from '@nestjs/testing';
import { Server } from 'node:http';
import { AddressInfo } from 'node:net';

import { UserDashboardLayoutController } from './user-dashboard-layout.controller';
import { UserDashboardLayoutService } from './user-dashboard-layout.service';
import { UserModule } from './user.module';
import { UserService } from './user.service';

describe('UserDashboardLayoutController', () => {
  // The client addresses this endpoint literally, so the address is declared
  // once here and every request in this file is built from it. A drift in the
  // global prefix, in the URI version or in the handler path therefore has to
  // fail in this file rather than silently in the browser.
  const layoutPath = '/api/v1/user/layout';

  const requestUserId = 'c0a8012e-4f7b-4d1a-9f3e-2b6d8c5a1e44';

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

  beforeEach(() => {
    findUnique.mockReset();
    upsert.mockReset();
  });

  /**
   * Boots the controller behind the same request pipeline `main.ts` builds, so
   * a request in this file travels the production path: URI versioning, the
   * `api` prefix, the strict global validation pipe, the guard tuple and — on
   * the read handler — the performance logging interceptor.
   *
   * Passing `authenticatedUserId` replaces only the passport guard, which is
   * how an authenticated identity is supplied without minting a token. Omitting
   * it leaves Ghostfolio's own guard in place, which is what makes the 401
   * assertions genuine rather than a restatement of a stub.
   */
  async function createApplication({
    authenticatedUserId
  }: {
    authenticatedUserId?: string;
  }): Promise<INestApplication> {
    const testingModuleBuilder = Test.createTestingModule({
      controllers: [UserDashboardLayoutController],
      // The read handler is decorated with `PerformanceLoggingInterceptor`,
      // which constructor-injects a real provider, and Nest resolves a
      // controller's enhancers while it builds the module. This is the same
      // import `UserModule` needs, and the wiring test below pins it there.
      imports: [PerformanceLoggingModule],
      providers: [
        // Ghostfolio's own passport strategy. Without a registered `jwt`
        // strategy passport reports an unknown strategy and the response is a
        // 500 instead of the required 401, so the strategy is real while its
        // collaborators are not: a request without a bearer token fails in the
        // extractor, and `validate()` is never reached.
        JwtStrategy,
        UserDashboardLayoutService,
        {
          provide: ConfigurationService,
          useValue: { get: () => 'user-dashboard-layout-spec-secret' }
        },
        {
          provide: PrismaService,
          useValue: { userDashboardLayout: { findUnique, upsert } }
        },
        { provide: UserService, useValue: {} }
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
    method,
    path,
    payload
  }: {
    app: INestApplication;
    method: 'GET' | 'PATCH';
    path: string;
    payload?: unknown;
  }) {
    const { port } = (app.getHttpServer() as Server).address() as AddressInfo;

    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      body: payload === undefined ? undefined : JSON.stringify(payload),
      headers:
        payload === undefined
          ? undefined
          : { 'content-type': 'application/json' },
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

      // The literal is asserted, not just the parsed value: an empty body also
      // parses to `null` in Angular's `HttpClient`, so only the raw text and the
      // content type distinguish a real JSON `null` from a zero-byte response
      // that no strict consumer can read.
      //
      // Both rows below read back with a null layout column — Prisma reports a
      // stored SQL NULL and a stored JSON null identically — so both are the
      // "user has never saved a layout" state and both must answer `null`.
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
    });

    describe('writing the layout', () => {
      // The write carries a complete snapshot, so echoing back whatever the
      // service handed the delegate is what the real upsert does — and it is
      // what proves the response is the persisted document rather than a copy
      // of the request or a row.
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
          modules: [{ cols: 2, moduleType: 'watchlist', rows: 2, x: 10, y: 0 }]
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

    // A failure inside the persistence layer has to reach the caller as a 500
    // that carries no internal detail. The read case is the load-bearing one:
    // an absent layout is answered 200 with the JSON literal `null`, so a
    // failure that degraded into that shape - or into the empty body that shape
    // replaced - would be indistinguishable from a user who has never saved a
    // layout, and the canvas would replace the stored layout on its next
    // debounced write. Both shapes are therefore ruled out below.
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
    // A missing `PerformanceLoggingModule` import fails neither the compiler nor
    // the linter: it fails when Nest resolves the read handler's interceptor.
    // The assertion lives here because `UserModule` cannot be booted in a unit
    // test — it reaches Redis and a Bull queue through `ActivitiesModule`.
    it('registers the layout endpoints and the interceptor module they depend on', () => {
      expect(Reflect.getMetadata('controllers', UserModule)).toContain(
        UserDashboardLayoutController
      );
      expect(Reflect.getMetadata('providers', UserModule)).toContain(
        UserDashboardLayoutService
      );
      expect(Reflect.getMetadata('imports', UserModule)).toContain(
        PerformanceLoggingModule
      );
    });
  });
});
