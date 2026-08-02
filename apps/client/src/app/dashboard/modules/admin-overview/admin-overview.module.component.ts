import { GfAdminOverviewComponent } from '@ghostfolio/client/components/admin-overview/admin-overview.component';

import { ChangeDetectionStrategy, Component } from '@angular/core';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [GfAdminOverviewComponent],
  selector: 'gf-admin-overview-module',
  templateUrl: './admin-overview.module.html'
})
export class GfAdminOverviewModuleComponent {}
