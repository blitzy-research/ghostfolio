import {
  EnhancedSymbolProfile,
  PortfolioDetails,
  PortfolioPosition
} from '@ghostfolio/common/interfaces';
import { Market } from '@ghostfolio/common/types';

import { Order } from '@prisma/client';

export interface PublicPortfolioResponse extends PublicPortfolioResponseV1 {
  alias?: string;
  hasDetails: boolean;
  holdings: {
    [symbol: string]: Pick<
      PortfolioPosition,
      | 'allocationInPercentage'

      /** @deprecated */
      | 'assetClass'
      | 'assetProfile'

      /** @deprecated */
      | 'countries'
      | 'currency'

      /** @deprecated */
      | 'dataSource'
      | 'dateOfFirstActivity'
      | 'markets'

      /** @deprecated */
      | 'name'
      | 'netPerformancePercentWithCurrencyEffect'

      /** @deprecated */
      | 'sectors'

      /** @deprecated */
      | 'symbol'

      /** @deprecated */
      | 'url'
      | 'valueInBaseCurrency'
      | 'valueInPercentage'
    >;
  };
  /**
   * The most recent trades behind a share link.
   *
   * Every monetary member is nullable because a share link that was not granted
   * unrestricted read receives `null` in their place - this application's
   * established redaction marker, which the value component renders as `*****`.
   * The nullability is part of the contract rather than an implementation detail:
   * a consumer that assumes a number here is assuming a permission the link may
   * not carry, and the type is what says so.
   */
  latestActivities: (Pick<Order, 'currency' | 'date' | 'type'> & {
    fee: number | null;
    quantity: number | null;
    SymbolProfile?: EnhancedSymbolProfile;
    unitPrice: number | null;
    value: number | null;
    valueInBaseCurrency: number | null;
  })[];
  markets: {
    [key in Market]: Pick<
      NonNullable<PortfolioDetails['markets']>[key],
      'id' | 'valueInPercentage'
    >;
  };
}

interface PublicPortfolioResponseV1 {
  createdAt: Date;
  performance: {
    '1d': {
      relativeChange: number;
    };
    max: {
      relativeChange: number;
    };
    ytd: {
      relativeChange: number;
    };
  };
}
