import { UserDashboardLayout } from '@ghostfolio/common/interfaces';

export interface DashboardLayoutStoreState {
  /**
   * The viewer's saved arrangement, and three genuinely distinct values rather
   * than two.
   *
   * `undefined` means nothing has been fetched yet - the value the store seeds
   * itself with - `null` means fetched and genuinely absent, and an object means
   * fetched and present. The read cache keys on this slice being *defined*, not
   * on it being truthy, so conflating the first two would serve "no saved
   * arrangement" to a viewer whose arrangement had simply not arrived, which is
   * exactly the state that opens the module catalog. The union is spelled out
   * because this workspace compiles with `strictNullChecks` disabled: the
   * compiler would accept the narrower declaration and quietly let a reader
   * assume a value that is not there.
   */
  layout: UserDashboardLayout | null | undefined;
}
