import { GfActivitiesComponent } from '@ghostfolio/client/components/activities/activities.component';

import { ChangeDetectionStrategy, Component } from '@angular/core';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [GfActivitiesComponent],
  selector: 'gf-activities-module',
  templateUrl: './activities.module.html'
})
export class GfActivitiesModuleComponent {}
