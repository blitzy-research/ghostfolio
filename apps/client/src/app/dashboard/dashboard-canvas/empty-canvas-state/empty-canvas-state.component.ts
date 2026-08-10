import { GfLogoComponent } from '@ghostfolio/ui/logo';

import {
  CUSTOM_ELEMENTS_SCHEMA,
  ChangeDetectionStrategy,
  Component,
  input,
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
  /**
   * Whether there is anything saved for the discard to remove.
   *
   * Decided by the canvas, because answering it means knowing which stored entries
   * are being retained without a cell - a module the viewer is not permitted to see
   * or a type this build does not recognise - and this notice holds no part of the
   * arrangement. False for a genuinely new visitor, who has nothing to discard and
   * must not be shown a destructive action against a document they do not have.
   */
  public readonly canDiscardLayout = input(false);

  public readonly isDiscardingLayout = input(false);

  protected readonly discardLayout = output<void>();

  protected readonly openCatalog = output<void>();
}
