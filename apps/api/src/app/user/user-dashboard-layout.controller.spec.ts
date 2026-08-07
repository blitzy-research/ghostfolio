import { JwtStrategy } from '@ghostfolio/api/app/auth/jwt.strategy';
import { HAS_PERMISSION_KEY } from '@ghostfolio/api/decorators/has-permission.decorator';
import { HasPermissionGuard } from '@ghostfolio/api/guards/has-permission.guard';
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
   * `api` prefix, the strict global validation pipe and the guard tuple.
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

      it('times itself at a level the production logger keeps, and says nothing else', async () => {
        findUnique.mockResolvedValue({
          layoutData: storedLayout,
          userId: requestUserId
        });

        // `log` specifically. This endpoint carries a stated p95 budget, and the
        // default production logger is `['error', 'log', 'warn']`, so a timing
        // emitted at `debug` - which is what the shared
        // `PerformanceLoggingInterceptor` does - would be discarded in exactly the
        // environment the budget applies to. Asserting the level is therefore
        // asserting that the budget is measurable at all, and it is the reason
        // this handler times itself rather than being decorated.
        const loggerLog = jest
          .spyOn(Logger, 'log')
          .mockImplementation(() => undefined);

        try {
          await request({
            app,
            method: 'GET',
            path: `${layoutPath}?userId=a-different-user`
          });

          expect(loggerLog).toHaveBeenCalledTimes(1);

          const [message, context] = loggerLog.mock.calls[0] as [
            string,
            string
          ];

          expect(context).toBe('UserDashboardLayoutController');
          expect(message).toMatch(
            /^Completed execution of getUserDashboardLayout\(\) in \d+\.\d{3} seconds$/
          );

          // Nothing about who asked, what they asked with, or what came back. The
          // handler's own name and an elapsed time are the whole of it.
          const emitted = `${message} ${context}`;

          expect(emitted).not.toContain(requestUserId);
          expect(emitted).not.toContain('a-different-user');
          expect(emitted).not.toContain('portfolio-overview');
          expect(emitted).not.toContain(layoutPath);
        } finally {
          loggerLog.mockRestore();
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

    it('needs no interceptor module for the layout endpoints', () => {
      // The read handler times itself and reports through `Logger.log`, so it
      // injects no enhancer and `UserModule` needs no extra import to satisfy
      // one. Pinned rather than left implicit, because the alternative -
      // decorating the handler with the shared `PerformanceLoggingInterceptor` -
      // both requires that import and reports at `debug`, which the default
      // production logger discards; a timing nobody can see is worse than none,
      // because it looks like coverage.
      const imports = Reflect.getMetadata('imports', UserModule) as unknown[];

      expect(
        imports.some((imported) => {
          return (
            typeof imported === 'function' &&
            imported.name === 'PerformanceLoggingModule'
          );
        })
      ).toBe(false);
    });
  });
});
