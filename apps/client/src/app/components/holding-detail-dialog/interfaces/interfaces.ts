import { ColorScheme } from '@ghostfolio/common/types';

import { DataSource } from '@prisma/client';

/**
 * What this dialog resolves with when it closes itself in order to open the market
 * data administration module's asset profile dialog.
 *
 * That hand-off keeps `dataSource` and `symbol` on the URL deliberately - the
 * asset profile dialog is opened for the same asset and reads the very same pair -
 * and drops only `holdingDetailDialog`, the key that identifies this dialog. The
 * application shell, which is what opened this dialog, then clears all three as
 * soon as it closes, taking the two the hand-off was relying on with it: the
 * administration module receives `assetProfileDialog` with no asset to open it for.
 *
 * Reporting the hand-off in the close result is what lets the shell tell an
 * ordinary close from this one. It is deliberately not inferred from the URL, which
 * would depend on the hand-off navigation completing before the close animation
 * finished - timing rather than a contract.
 *
 * `undefined` is the ordinary close, so no existing close path changes.
 */
export interface HoldingDetailDialogResult {
  hasHandedOverAssetProfile: true;
}

export interface HoldingDetailDialogParams {
  baseCurrency: string;
  colorScheme: ColorScheme;
  dataSource: DataSource;
  deviceType: string;
  hasImpersonationId: boolean;
  hasPermissionToAccessAdminControl: boolean;
  hasPermissionToCreateActivity: boolean;
  hasPermissionToReportDataGlitch: boolean;
  hasPermissionToUpdateActivity: boolean;
  locale: string;
  symbol: string;
}
