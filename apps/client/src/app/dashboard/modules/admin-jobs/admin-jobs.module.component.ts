import { GfAdminJobsComponent } from '@ghostfolio/client/components/admin-jobs/admin-jobs.component';

import { ChangeDetectionStrategy, Component } from '@angular/core';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [GfAdminJobsComponent],
  selector: 'gf-admin-jobs-module',
  styleUrls: ['./admin-jobs.module.scss'],
  templateUrl: './admin-jobs.module.html'
})
export class GfAdminJobsModuleComponent {}
