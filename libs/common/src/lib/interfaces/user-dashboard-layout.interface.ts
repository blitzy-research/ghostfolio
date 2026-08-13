import { DashboardModuleLayoutItem } from './dashboard-module-layout-item.interface';

export interface UserDashboardLayout {
  modules: DashboardModuleLayoutItem[];

  /**
   * The concurrency token for the stored row, and deliberately NOT part of the
   * stored document.
   *
   * A layout is written as a complete snapshot, so two clients editing one
   * account - most commonly the same person in two browser tabs - would
   * otherwise resolve as unconditional last-write-wins at document granularity:
   * a tab that moved one module would restore every other module to whatever
   * that tab last saw, silently discarding a change the other tab had already
   * persisted. `version` cannot serve here, because it discriminates the SHAPE
   * of the document rather than its revision.
   *
   * It is opaque to the client: read from a fetched layout, sent back with the
   * next write, and compared server-side against the row it was read from. A
   * write carrying a token the row no longer matches is refused rather than
   * applied. A write carrying no token at all is unconditional, which is what a
   * first-ever save and a deliberate overwrite both need.
   *
   * Absent from the persisted `layoutData` on purpose: it is derived from the
   * row's own `updatedAt` column, so it cannot drift from the row it describes
   * and the stored shape stays exactly `{ modules, version }`.
   */
  revision?: string;

  version?: number;
}
