import { GfXRayComponent } from '@ghostfolio/client/components/x-ray/x-ray.component';

import { ChangeDetectionStrategy, Component } from '@angular/core';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [GfXRayComponent],
  selector: 'gf-x-ray-module',
  templateUrl: './x-ray.module.html'
})
export class GfXRayModuleComponent {}
