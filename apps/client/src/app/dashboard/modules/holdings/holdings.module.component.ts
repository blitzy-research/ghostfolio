import { GfHomeHoldingsComponent } from '@ghostfolio/client/components/home-holdings/home-holdings.component';

import { ChangeDetectionStrategy, Component } from '@angular/core';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [GfHomeHoldingsComponent],
  selector: 'gf-holdings-module',
  templateUrl: './holdings.module.html'
})
export class GfHoldingsModuleComponent {}
