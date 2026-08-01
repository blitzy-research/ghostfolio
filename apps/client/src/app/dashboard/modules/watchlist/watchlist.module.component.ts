import { GfHomeWatchlistComponent } from '@ghostfolio/client/components/home-watchlist/home-watchlist.component';

import { ChangeDetectionStrategy, Component } from '@angular/core';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [GfHomeWatchlistComponent],
  selector: 'gf-watchlist-module',
  templateUrl: './watchlist.module.html'
})
export class GfWatchlistModuleComponent {}
