import { GfMarketsComponent } from '@ghostfolio/client/components/markets/markets.component';

import { ChangeDetectionStrategy, Component } from '@angular/core';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [GfMarketsComponent],
  selector: 'gf-markets-premium-module',
  styleUrls: ['./markets-premium.module.scss'],
  templateUrl: './markets-premium.module.html'
})
export class GfMarketsPremiumModuleComponent {}
