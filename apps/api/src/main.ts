import {
  BULL_BOARD_ROUTE,
  DEFAULT_HOST,
  DEFAULT_PORT,
  STORYBOOK_PATH,
  SUPPORTED_LANGUAGE_CODES
} from '@ghostfolio/common/config';

import {
  Logger,
  LogLevel,
  ValidationPipe,
  VersioningType
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import { NextFunction, Request, Response } from 'express';
import helmet from 'helmet';
import { getReasonPhrase, StatusCodes } from 'http-status-codes';

import { AppModule } from './app/app.module';
import { environment } from './environments/environment';

/**
 * The paths that exist at the ROOT of the served client build.
 *
 * A closed, small set, because everything else the build emits is per locale.
 * Listed rather than probed on disk: the answer is fixed by the build, and a
 * filesystem call per request would put I/O in front of every asset the
 * application serves.
 */
const ROOT_LEVEL_CLIENT_FILES = [
  '/3rdpartylicenses.txt',
  '/favicon.ico',
  '/prerendered-routes.json',
  '/robots.txt',
  '/sitemap.xml'
];

/** The root-level directories the build copies whole. */
const ROOT_LEVEL_CLIENT_DIRECTORIES = ['/.well-known/', '/assets/'];

/**
 * Whether a path asks for a client build artefact that only exists inside a
 * locale directory.
 *
 * Deliberately narrow. It answers `true` only for a FILE-LIKE path - one whose
 * last segment carries an extension - that is neither one of the fixed
 * root-level files, nor inside a root-level directory, nor under a locale
 * prefix, nor addressed to the API or one of the mounted tools. Anything without
 * an extension is left alone, because that is what an application route looks
 * like and those are the shell's to serve.
 */
function isUnscopedClientAssetRequest(path: string): boolean {
  const lastSegment = path.substring(path.lastIndexOf('/') + 1);

  if (!lastSegment.includes('.')) {
    return false;
  }

  if (
    path.startsWith('/api/') ||
    path.startsWith(`${BULL_BOARD_ROUTE}/`) ||
    path.startsWith(STORYBOOK_PATH) ||
    ROOT_LEVEL_CLIENT_FILES.includes(path) ||
    ROOT_LEVEL_CLIENT_DIRECTORIES.some((directory) => {
      return path.startsWith(directory);
    })
  ) {
    return false;
  }

  return !SUPPORTED_LANGUAGE_CODES.some((languageCode) => {
    return path.startsWith(`/${languageCode}/`);
  });
}

/**
 * The status that describes a request body this application could not read, or
 * `undefined` when the error is not about the body at all.
 *
 * Recognised by `body-parser`'s own `type` discriminator rather than by matching its
 * message, so the classification cannot drift with a dependency's wording and cannot
 * be influenced by anything the caller sent. The four types are the whole of what the
 * JSON parser raises:
 *
 * - `entity.too.large` - past the configured limit, which is what 413 means.
 * - `entity.parse.failed` - not valid JSON, which is a bad request.
 * - `encoding.unsupported` - a `Content-Encoding` this build cannot decode, which is
 *   an unsupported media type.
 * - `request.aborted` - the caller hung up mid-body; answering at all is
 *   best-effort, and 400 is the honest description of what arrived.
 */
function getRequestBodyErrorStatus(error: unknown): number | undefined {
  switch ((error as { type?: unknown })?.type) {
    case 'encoding.unsupported':
      return StatusCodes.UNSUPPORTED_MEDIA_TYPE;
    case 'entity.parse.failed':
    case 'request.aborted':
      return StatusCodes.BAD_REQUEST;
    case 'entity.too.large':
      return StatusCodes.REQUEST_TOO_LONG;
    default:
      return undefined;
  }
}

async function bootstrap() {
  const configApp = await NestFactory.create(AppModule);
  const configService = configApp.get<ConfigService>(ConfigService);
  let customLogLevels: LogLevel[];

  try {
    customLogLevels = JSON.parse(
      configService.get<string>('LOG_LEVELS')
    ) as LogLevel[];
  } catch {}

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger:
      customLogLevels ??
      (environment.production
        ? ['error', 'log', 'warn']
        : ['debug', 'error', 'log', 'verbose', 'warn'])
  });

  app.enableCors();
  app.enableVersioning({
    defaultVersion: '1',
    type: VersioningType.URI
  });
  app.setGlobalPrefix('api', {
    exclude: [
      `${BULL_BOARD_ROUTE.substring(1)}{/*wildcard}`,
      'sitemap.xml',
      ...SUPPORTED_LANGUAGE_CODES.map((languageCode) => {
        // Exclude language-specific routes with an optional wildcard
        return `/${languageCode}{/*wildcard}`;
      })
    ]
  });

  app.useGlobalPipes(
    new ValidationPipe({
      forbidNonWhitelisted: true,
      transform: true,
      whitelist: true
    })
  );

  // Answer a build artefact asked for without its locale prefix truthfully.
  //
  // Everything the client build emits lives under `/<languageCode>/`, so
  // `/ngsw-worker.js`, `/ngsw.json` or `/main.js` addresses no file. The static
  // handler nevertheless answers any unmatched path with the zero-byte
  // `index.html` that exists only to give `/` something to redirect from, so such
  // a request received an EMPTY HTML document with status 200: a browser asked to
  // execute that as a service worker or a stylesheet fails obscurely, and any
  // monitor reading the status concludes the asset is being served.
  //
  // Registered here rather than in `HtmlTemplateMiddleware`, and the reason is
  // structural rather than stylistic. Middleware applied through
  // `MiddlewareConsumer` is mounted under the global prefix plus the routes
  // excluded from it, which for this application is `/api/**` and the twelve
  // locale prefixes - so a class middleware never sees `/ngsw-worker.js` at all.
  // Middleware installed on the adapter during bootstrap runs before every route
  // the modules register, static serving included, which is exactly the position
  // this decision has to be made from.
  //
  // Only in a production build, because that is the only configuration in which
  // this process serves the client at all.
  if (environment.production) {
    app.use((req: Request, res: Response, next: NextFunction) => {
      if (isUnscopedClientAssetRequest(req.path)) {
        res.sendStatus(StatusCodes.NOT_FOUND);
      } else {
        next();
      }
    });
  }

  // Support 10mb csv/json files for importing activities
  app.useBodyParser('json', { limit: '10mb' });

  // Answer a body this application could not read with the status that describes it.
  //
  // The JSON parser above rejects a malformed body and one past the limit by
  // throwing, and an error thrown by middleware travels FORWARD to the next error
  // handler. Without this one, the next handler is the static file module's, which
  // sees an excluded `/api/**` path and replaces whatever went wrong with `Cannot
  // PATCH /api/v1/...` - so a caller sending truncated JSON, or fifteen megabytes of
  // it, was told the endpoint does not exist. That is actively misleading: it points
  // at routing while the request never got past parsing, and it hides the size limit
  // completely.
  //
  // Registered immediately after the parser so it precedes that handler in the
  // stack, and it forwards anything it does not recognise, so a genuine fault still
  // fails as loudly as it should.
  app.use(
    (
      error: Error,
      _request: Request,
      response: Response,
      next: NextFunction
    ) => {
      const status = getRequestBodyErrorStatus(error);

      if (!status) {
        next(error);

        return;
      }

      // The reason phrase and nothing from the error. A parse failure's message
      // quotes the offending fragment of the body, which is the caller's own data
      // and has no business being echoed; a size failure names the configured limit.
      // The status carries the whole of the decision the caller has to make.
      response.status(status).json({
        message: getReasonPhrase(status),
        statusCode: status
      });
    }
  );

  app.use(cookieParser());

  // Nothing announces the server that produced a response. Express advertises
  // itself on every reply by default, including the error replies an attacker is
  // most interested in, and the header buys a deployment nothing while telling a
  // scanner which framework's advisories to try.
  app.disable('x-powered-by');

  // Security headers are installed for EVERY deployment, not only the ones with
  // payments switched on. They were previously inside the subscription branch
  // below, which meant the default self-hosted runtime - the majority of
  // deployments - answered every request, including its 401s, 403s, 404s and
  // redirects, with no CSP, no HSTS, no `X-Content-Type-Options` and no frame or
  // referrer protection. None of those protections has anything to do with
  // subscriptions; only the Stripe allowances below do, so only they are
  // conditional.
  const isSubscriptionEnabled =
    configService.get<string>('ENABLE_FEATURE_SUBSCRIPTION') === 'true';

  // Stripe ships its checkout as a script and an iframe from its own origin, so
  // a deployment that takes payments has to allow both. A deployment that does
  // not gets the stricter policy, which is the whole point of deriving the
  // directives rather than shipping one policy for everybody.
  const stripeOrigins = isSubscriptionEnabled ? ['https://js.stripe.com'] : [];

  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.path.startsWith(STORYBOOK_PATH)) {
      // Storybook is a static build of component sandboxes that inlines its own
      // scripts and styles from generated files; a CSP strict enough for the
      // application blanks it. It is excluded here exactly as it was before, and
      // for the same reason.
      next();
    } else {
      helmet({
        contentSecurityPolicy: {
          directives: {
            connectSrc: ["'self'", ...stripeOrigins], // Allow connections to Stripe
            frameSrc: ["'self'", ...stripeOrigins], // Allow loading frames from Stripe
            scriptSrc: ["'self'", "'unsafe-inline'", ...stripeOrigins], // Allow inline scripts and scripts from Stripe
            scriptSrcAttr: ["'self'", "'unsafe-inline'"], // Allow inline event handlers
            styleSrc: ["'self'", "'unsafe-inline'"] // Allow inline styles
          }
        },
        crossOriginOpenerPolicy: false // Disable Cross-Origin-Opener-Policy header (for Internet Identity)
      })(req, res, next);
    }
  });

  const HOST = configService.get<string>('HOST') || DEFAULT_HOST;
  const PORT = configService.get<number>('PORT') || DEFAULT_PORT;

  await app.listen(PORT, HOST, () => {
    logLogo();

    let address = app.getHttpServer().address();

    if (typeof address === 'object') {
      const addressObject = address;
      let host = addressObject.address;

      if (addressObject.family === 'IPv6') {
        host = `[${addressObject.address}]`;
      }

      address = `${host}:${addressObject.port}`;
    }

    Logger.log(`Listening at http://${address}`);
    Logger.log('');
  });
}

function logLogo() {
  Logger.log('   ________               __  ____      ___');
  Logger.log('  / ____/ /_  ____  _____/ /_/ __/___  / (_)___');
  Logger.log(' / / __/ __ \\/ __ \\/ ___/ __/ /_/ __ \\/ / / __ \\');
  Logger.log('/ /_/ / / / / /_/ (__  ) /_/ __/ /_/ / / / /_/ /');
  Logger.log(
    `\\____/_/ /_/\\____/____/\\__/_/  \\____/_/_/\\____/ ${environment.version}`
  );
  Logger.log('');
}

bootstrap();
