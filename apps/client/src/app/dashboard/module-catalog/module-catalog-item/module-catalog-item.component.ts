import { DashboardModuleType } from '@ghostfolio/common/dashboard';

import { FocusableOption } from '@angular/cdk/a11y';
import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  ElementRef,
  HostBinding,
  Input,
  ViewChild,
  inject,
  output
} from '@angular/core';
import { MatCardModule } from '@angular/material/card';

import { DashboardModuleDefinition } from '../../interfaces/interfaces';

/**
 * A single row of the dashboard module catalog. The parent catalog renders one
 * instance per module it has already narrowed down by permission and by the
 * active search term, so this row draws whatever definition it is handed.
 *
 * The row plays three roles at the same time:
 *
 * 1. a click target that emits an add-module intent;
 * 2. a native HTML5 drag source whose payload the dashboard canvas reads when
 *    the row is dropped onto an empty grid cell;
 * 3. a `FocusableOption`, so the parent's `FocusKeyManager` can move a roving
 *    virtual focus across the rows with wraparound.
 *
 * Everything else is deliberately out of reach. The row holds no layout
 * geometry, resolves no module component, checks no permission and persists
 * nothing; its only outward signals are the `moduleAdded` output and the drag
 * payload. Layout ownership stays with the grid, module resolution stays with
 * the registry, and persistence stays with the canvas.
 *
 * @example
 * ```html
 * <gf-module-catalog-item
 *   [definition]="module"
 *   (moduleAdded)="onAddModule($event)"
 * />
 * ```
 */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatCardModule],
  selector: 'gf-module-catalog-item',
  styleUrls: ['./module-catalog-item.scss'],
  templateUrl: './module-catalog-item.html'
})
export class GfModuleCatalogItemComponent implements FocusableOption {
  /**
   * Complements the `role="list"` the parent sets on its results container, so
   * assistive technology announces the catalog as a list and each row as one of
   * its items.
   */
  @HostBinding('attr.role') role = 'listitem';

  /**
   * Keeps the row out of the natural tab order while leaving it
   * programmatically focusable. Focus here is a roving virtual focus driven by
   * the parent, not a per-row tab stop.
   */
  @HostBinding('attr.tabindex') tabindex = -1;

  /**
   * Registry metadata for the module this row offers.
   *
   * Only `name` and `moduleType` are ever read. Materialising the module's
   * component belongs to the canvas, the cell dimensions belong to the grid
   * engine, and the visibility permission was already applied by the parent
   * before this row was created.
   */
  @Input() definition: DashboardModuleDefinition;

  /**
   * The actionable element inside the row. The parent scrolls it into view as
   * focus moves between rows and clicks it to action the focused row on Enter,
   * which is why the click handler is bound to this element rather than to the
   * component host: a second binding on the host would add the module twice.
   *
   * `read: ElementRef` is required, not decorative. The referenced element
   * hosts a component, so an unqualified query would hand back that component
   * instance instead of an element reference, leaving the parent's
   * `nativeElement?.click()` and `nativeElement?.scrollIntoView()` to no-op
   * silently against an undefined property.
   */
  @ViewChild('row', { read: ElementRef })
  public rowElement: ElementRef<HTMLElement>;

  public hasFocus = false;
  public isDragging = false;

  protected readonly moduleAdded = output<DashboardModuleType>();

  private readonly changeDetectorRef = inject(ChangeDetectorRef);

  /**
   * The parent reads this as a property when it looks up which row currently
   * holds focus, so it has to remain a getter. As a method it would still
   * compile while always reading as truthy, silently breaking that lookup.
   */
  @HostBinding('class.has-focus')
  public get getHasFocus() {
    return this.hasFocus;
  }

  public focus() {
    this.hasFocus = true;

    this.changeDetectorRef.markForCheck();
  }

  public onClick() {
    this.moduleAdded.emit(this.definition.moduleType);
  }

  /**
   * Clears the drag-active styling. `dragend` is the only dependable place to
   * do this, because a drag can also end in a cancel or in a drop outside the
   * grid, and neither of those fires a drop event.
   */
  public onDragEnd() {
    this.isDragging = false;

    this.changeDetectorRef.markForCheck();
  }

  /**
   * Publishes the module type as the drag payload for the canvas.
   *
   * The payload is written under `text/plain` as the bare discriminator, with
   * no wrapper and no encoding, for two reasons: `text/plain` is the one
   * transfer key browsers still expose while a drag is merely hovering, which
   * is when the grid engine inspects the payload to decide whether to accept a
   * drop, and the bare value is what the module registry resolves against.
   *
   * `dataTransfer` is guarded rather than assumed. The workspace compiles with
   * `strictNullChecks` disabled, so nothing but this check stands between an
   * event without a transfer object and a runtime failure.
   */
  public onDragStart(event: DragEvent) {
    if (!event.dataTransfer) {
      return;
    }

    event.dataTransfer.effectAllowed = 'copy';
    event.dataTransfer.setData('text/plain', this.definition.moduleType);

    // Flagged only once the payload is attached, so the drag-active styling
    // never advertises a drag the canvas would be unable to act on.
    this.isDragging = true;

    this.changeDetectorRef.markForCheck();
  }

  public removeFocus() {
    this.hasFocus = false;

    this.changeDetectorRef.markForCheck();
  }
}
