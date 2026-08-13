import type { AuthDeviceDto } from './auth-device.dto';
import { CreateAccessDto } from './create-access.dto';
import { CreateAccountBalanceDto } from './create-account-balance.dto';
import { CreateAccountWithBalancesDto } from './create-account-with-balances.dto';
import { CreateAccountDto } from './create-account.dto';
import { CreateAssetProfileWithMarketDataDto } from './create-asset-profile-with-market-data.dto';
import { CreateAssetProfileDto } from './create-asset-profile.dto';
import { CreateOrderDto } from './create-order.dto';
import { CreatePlatformDto } from './create-platform.dto';
import { CreateStripeCheckoutSessionDto } from './create-stripe-checkout-session.dto';
import { CreateTagDto } from './create-tag.dto';
import { CreateWatchlistItemDto } from './create-watchlist-item.dto';
import { DashboardModuleLayoutItemDto } from './dashboard-module-layout-item.dto';
import { DeleteOwnUserDto } from './delete-own-user.dto';
import { RedeemCouponDto } from './redeem-coupon.dto';
import { TransferBalanceDto } from './transfer-balance.dto';
import { UpdateAccessDto } from './update-access.dto';
import { UpdateAccountDto } from './update-account.dto';
import { UpdateAssetProfileDto } from './update-asset-profile.dto';
import { UpdateBulkMarketDataDto } from './update-bulk-market-data.dto';
import { UpdateMarketDataDto } from './update-market-data.dto';
import { UpdateOrderDto } from './update-order.dto';
import { UpdateOwnAccessTokenDto } from './update-own-access-token.dto';
import { UpdatePlatformDto } from './update-platform.dto';
import { UpdatePropertyDto } from './update-property.dto';
import { UpdateTagDto } from './update-tag.dto';
import { UpdateUserDashboardLayoutDto } from './update-user-dashboard-layout.dto';
import { UpdateUserSettingDto } from './update-user-setting.dto';

// `AuthDeviceDto` is an interface rather than a decorated class, so it exists
// only in the type system. Re-exporting it through the value export below is
// rejected as TS1205 wherever `isolatedModules` is enabled — the client's spec
// compilation, for one — because a single-file compilation cannot tell that the
// binding carries no runtime value. Naming it in its own `export type` clause
// states that explicitly and leaves every consumer's import untouched.
export type { AuthDeviceDto };

export {
  CreateAccessDto,
  CreateAccountBalanceDto,
  CreateAccountDto,
  CreateAccountWithBalancesDto,
  CreateAssetProfileDto,
  CreateAssetProfileWithMarketDataDto,
  CreateOrderDto,
  CreatePlatformDto,
  CreateStripeCheckoutSessionDto,
  CreateTagDto,
  CreateWatchlistItemDto,
  DashboardModuleLayoutItemDto,
  DeleteOwnUserDto,
  RedeemCouponDto,
  TransferBalanceDto,
  UpdateAccessDto,
  UpdateAccountDto,
  UpdateAssetProfileDto,
  UpdateBulkMarketDataDto,
  UpdateMarketDataDto,
  UpdateOrderDto,
  UpdateOwnAccessTokenDto,
  UpdatePlatformDto,
  UpdatePropertyDto,
  UpdateTagDto,
  UpdateUserDashboardLayoutDto,
  UpdateUserSettingDto
};
