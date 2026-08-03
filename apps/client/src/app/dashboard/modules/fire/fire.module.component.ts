import { GfFireComponent } from '@ghostfolio/client/components/fire/fire.component';

import { ChangeDetectionStrategy, Component } from '@angular/core';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [GfFireComponent],
  selector: 'gf-fire-module',
  templateUrl: './fire.module.html'
})
export class GfFireModuleComponent {}
