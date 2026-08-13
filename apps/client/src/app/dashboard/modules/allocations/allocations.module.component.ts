import { GfAllocationsComponent } from '@ghostfolio/client/components/allocations/allocations.component';

import { ChangeDetectionStrategy, Component } from '@angular/core';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [GfAllocationsComponent],
  selector: 'gf-allocations-module',
  templateUrl: './allocations.module.html'
})
export class GfAllocationsModuleComponent {}
