import { GfHomeOverviewComponent } from '@ghostfolio/client/components/home-overview/home-overview.component';

import { ChangeDetectionStrategy, Component } from '@angular/core';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [GfHomeOverviewComponent],
  selector: 'gf-portfolio-overview-module',
  templateUrl: './portfolio-overview.module.html'
})
export class GfPortfolioOverviewModuleComponent {}
