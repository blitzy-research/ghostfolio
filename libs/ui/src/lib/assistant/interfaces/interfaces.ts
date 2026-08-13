import { DashboardModuleType } from '@ghostfolio/common/dashboard';
import { AssetProfileIdentifier } from '@ghostfolio/common/interfaces';
import { AccountWithValue, DateRange } from '@ghostfolio/common/types';

import { SearchMode } from '../enums/search-mode';

export interface AccountSearchResultItem extends Pick<
  AccountWithValue,
  'id' | 'name'
> {
  mode: SearchMode.ACCOUNT;
  moduleType: DashboardModuleType;
}

/**
 * The presentation fields the two asset-shaped result kinds share. Extracted so
 * that the kinds can differ in the one respect that matters - whether they name
 * a dashboard module - without duplicating what they display.
 */
interface AssetSearchResultItemFields extends AssetProfileIdentifier {
  assetSubClassString: string;
  currency: string;
  name: string;
}

/**
 * An asset profile from the market data administration surface.
 *
 * Carries a module discriminator because the dialog it opens belongs to the
 * Admin Market Data module, which is only present if the viewer has placed it.
 * The discriminator is what lets the result ask for that module to be surfaced,
 * so activating it does something whether or not the module is already there.
 */
export interface AssetProfileSearchResultItem extends AssetSearchResultItemFields {
  mode: SearchMode.ASSET_PROFILE;
  moduleType: DashboardModuleType;
}

/**
 * A holding from the viewer's own portfolio.
 *
 * Deliberately carries no module discriminator: the holding detail dialog is
 * owned by the application shell, which is mounted for the whole session, so
 * there is no module to surface and the query parameters alone are sufficient.
 * Modelling that difference in the type - rather than leaving both kinds to
 * share one optional field - is what keeps a holding from ever being mistaken
 * for something that needs a module revealed.
 */
export interface HoldingSearchResultItem extends AssetSearchResultItemFields {
  mode: SearchMode.HOLDING;
}

/**
 * Either asset-shaped result kind, for the places that only care about the
 * fields they have in common.
 */
export type AssetSearchResultItem =
  | AssetProfileSearchResultItem
  | HoldingSearchResultItem;

export interface DateRangeOption {
  label: string;
  value: DateRange;
}

export interface QuickLinkSearchResultItem {
  mode: SearchMode.QUICK_LINK;
  moduleType: DashboardModuleType;
  name: string;
}

export type SearchResultItem =
  | AccountSearchResultItem
  | AssetSearchResultItem
  | QuickLinkSearchResultItem;

export interface SearchResults {
  accounts: SearchResultItem[];
  assetProfiles: SearchResultItem[];
  holdings: SearchResultItem[];
  quickLinks: SearchResultItem[];
}
