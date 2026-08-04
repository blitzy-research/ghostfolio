export interface AccountDetailDialogParams {
  accountId: string;
  deviceType: string;
  hasImpersonationId: boolean;
  hasPermissionToCreateActivity: boolean;
}

/**
 * What this dialog resolves with when it closes itself in order to open another
 * module's dialog.
 *
 * The host that opened it clears the query parameters this dialog travelled on as
 * soon as it closes, which is correct for an ordinary close and destructive for a
 * hand-off: the navigation that asks for the activities module writes
 * `activityId`, `createDialog`/`editDialog` and `dialogModule` onto the very same
 * URL, and the host's clear removes three of them again. A module that was lazily
 * loaded in response to the hand-off subscribes *after* that, sees nothing
 * addressed to it, and the requested dialog silently never appears.
 *
 * Reporting the hand-off in the close result is what lets the host tell the two
 * apart, and it is deliberately not inferred from the URL: reading the current
 * parameters back inside `afterClosed` would depend on the hand-off navigation
 * having completed before the close animation finished, which is timing rather
 * than a contract.
 *
 * `undefined` is the ordinary close, so nothing about the existing close paths
 * changes.
 */
export interface AccountDetailDialogResult {
  hasHandedOver: true;
}
