/**
 * The two globals the client application installs from
 * `apps/client/src/polyfills.ts`, installed here for the same reasons.
 *
 * This library is consumed by that application, so its specs run against the same
 * code and need the same environment:
 *
 * - `@angular/localize/init` defines `$localize`, which source messages in shared
 *   metadata are tagged with at *module scope*, so the global has to exist before
 *   the first `@ghostfolio/*` import is evaluated. A spec cannot guarantee that on
 *   its own, because Prettier sorts side-effect imports along with the rest;
 *   installing it from the setup file, which Jest evaluates first, always holds.
 * - `reflect-metadata` provides `Reflect.getMetadata`, which `class-transformer`
 *   calls from its `@Type()` decorator as the decorated class is defined.
 *   `@ghostfolio/common/dtos` is a barrel of such classes and the data facade in
 *   this library imports it, so without this the import itself throws
 *   `TypeError: Reflect.getMetadata is not a function`.
 */
import '@angular/localize/init';
import { setupZoneTestEnv } from 'jest-preset-angular/setup-env/zone';
import { deserialize, serialize } from 'node:v8';
import 'reflect-metadata';

setupZoneTestEnv();

/**
 * `structuredClone`, which this test environment does not provide.
 *
 * Unlike the two imports above this is not an application polyfill: it is a
 * standard global that both Node and every browser have, and that the jsdom realm
 * these specs run in simply does not expose. A component calling it therefore
 * throws `ReferenceError` under test while working everywhere it actually runs.
 *
 * Backed by V8's own serializer rather than by a JSON round-trip, so it really is
 * a structured clone: dates, maps, sets and cycles survive it, and a spec cannot
 * pass here on data that the real algorithm would have rejected or altered.
 *
 * Installed conditionally, so a future environment that provides its own keeps it.
 */
globalThis.structuredClone ??= (<T>(aValue: T): T => {
  return deserialize(serialize(aValue)) as T;
}) as typeof structuredClone;
