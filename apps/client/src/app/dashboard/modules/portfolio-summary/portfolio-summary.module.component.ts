import { GfHomeSummaryComponent } from '@ghostfolio/client/components/home-summary/home-summary.component';

import { ChangeDetectionStrategy, Component } from '@angular/core';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [GfHomeSummaryComponent],
  selector: 'gf-portfolio-summary-module',
  styleUrls: ['./portfolio-summary.module.scss'],
  templateUrl: './portfolio-summary.module.html'
})
export class GfPortfolioSummaryModuleComponent {}
