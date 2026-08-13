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

  /**
   * Whether a catalog row is being dragged right now.
   *
   * This notice is laid over the grid, and the grid beneath it is what listens for
   * a drop - so the canvas switches the whole overlay transparent to pointers and
   * each control here takes them back for itself. That is correct until somebody
   * drags: the controls sit in the centre of the card, which is the middle of the
   * empty canvas and exactly where a row gets dropped, so the very controls that
   * have to answer a click were swallowing the `dragover` and `drop` that the grid
   * needed. On a first visit that is the whole of drag-to-add failing, silently.
   *
   * Answered by the canvas rather than observed here, because the drag begins in
   * the catalog and this notice can see neither it nor the grid.
   */
  public readonly isDragInProgress = input(false);

  protected readonly discardLayout = output<void>();

  protected readonly openCatalog = output<void>();
}
