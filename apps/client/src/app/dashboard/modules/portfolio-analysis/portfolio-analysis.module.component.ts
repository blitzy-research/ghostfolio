import { GfPortfolioAnalysisComponent } from '@ghostfolio/client/components/portfolio-analysis/portfolio-analysis.component';

import { ChangeDetectionStrategy, Component } from '@angular/core';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [GfPortfolioAnalysisComponent],
  selector: 'gf-portfolio-analysis-module',
  templateUrl: './portfolio-analysis.module.html'
})
export class GfPortfolioAnalysisModuleComponent {}
