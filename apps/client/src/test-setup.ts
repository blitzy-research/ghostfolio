/**
 * The two globals `apps/client/src/polyfills.ts` installs for the application,
 * installed here for the same reason and in the same order.
 *
 * Neither is optional and neither can be left to individual specs:
 *
 * - `@angular/localize/init` defines `$localize`. Source messages are tagged at
 *   *module scope* in shared metadata — the dashboard module map and the route
 *   registry both do it — so the global has to exist before the first
 *   `@ghostfolio/*` import is evaluated. A spec cannot guarantee that on its
 *   own: Prettier sorts side-effect imports along with the rest, so an
 *   `import '@angular/localize/init'` written in a spec can never precede the
 *   `@ghostfolio/*` group above it. Installing it from the setup file, which
 *   Jest evaluates before the test file itself, is the only placement that
 *   always holds.
 * - `reflect-metadata` provides `Reflect.getMetadata`, which `class-transformer`
 *   calls from its `@Type()` decorator as the decorated class is defined.
 *   `@ghostfolio/common/dtos` is a barrel of such classes and is reachable from
 *   most of the client, so without this the import itself throws
 *   `TypeError: Reflect.getMetadata is not a function`.
 *
 * Keeping the test environment identical to the application's on both counts is
 * what allows specs to exercise real components rather than stand-ins.
 */
import '@angular/localize/init';
import { setupZoneTestEnv } from 'jest-preset-angular/setup-env/zone';
import 'reflect-metadata';

setupZoneTestEnv();
