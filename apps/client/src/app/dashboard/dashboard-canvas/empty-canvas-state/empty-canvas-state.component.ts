import { GfLogoComponent } from '@ghostfolio/ui/logo';

import {
  CUSTOM_ELEMENTS_SCHEMA,
  ChangeDetectionStrategy,
  Component,
  output
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [GfLogoComponent, MatButtonModule, MatCardModule],
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
  selector: 'gf-empty-canvas-state',
  styleUrls: ['./empty-canvas-state.scss'],
  templateUrl: './empty-canvas-state.html'
})
export class GfEmptyCanvasStateComponent {
  protected readonly openCatalog = output<void>();
}
