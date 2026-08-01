import { GfAdminMarketDataComponent } from '@ghostfolio/client/components/admin-market-data/admin-market-data.component';

import { ChangeDetectionStrategy, Component } from '@angular/core';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [GfAdminMarketDataComponent],
  selector: 'gf-admin-market-data-module',
  templateUrl: './admin-market-data.module.html'
})
export class GfAdminMarketDataModuleComponent {}
