import { GfHomeMarketComponent } from '@ghostfolio/client/components/home-market/home-market.component';

import { ChangeDetectionStrategy, Component } from '@angular/core';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [GfHomeMarketComponent],
  selector: 'gf-markets-module',
  styleUrls: ['./markets.module.scss'],
  templateUrl: './markets.module.html'
})
export class GfMarketsModuleComponent {}
