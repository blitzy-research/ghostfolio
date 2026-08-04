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

// Type-only: this interface is named in a decorated `@Input()` signature, and
// with `isolatedModules` and decorator metadata both on, a value import there
// is a spec-compilation error (TS1272). The sibling module host imports it the
// same way for the same reason.
import type { DashboardModuleDefinition } from '../../interfaces/interfaces';

/**
 * A single row of the dashboard module catalog, drawing whatever definition the
 * parent hands it - already narrowed by permission and by the active search term.
 *
 * It is three things at once: a click target that emits an add-module intent, a
 * native HTML5 drag source whose payload the canvas reads on drop, and a
 * `FocusableOption` so the parent's `FocusKeyManager` can move a roving focus across
 * the rows with wraparound.
 *
 * 1. a click target that emits an add-module intent;
 * 2. a native HTML5 drag source whose payload the dashboard canvas reads when
 *    the row is dropped onto an empty grid cell;
 * 3. a `FocusableOption`, so the parent's `FocusKeyManager` can move focus
 *    across the rows with wraparound. The focus is real DOM focus on the row's
 *    button, which is what a key manager assumes: it calls `focus()` on the
 *    option it moves to and does nothing else, so an option that only painted a
 *    highlight would leave keyboard focus stranded wherever it started.
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
   * Registry metadata for the module this row offers.
   *
   * Only `name` and `moduleType` are ever read. Materialising the module's
   * component belongs to the canvas, the cell dimensions belong to the grid
   * engine, and the visibility permission was already applied by the parent
   * before this row was created.
   */
  @Input() definition: DashboardModuleDefinition;

  /**
   * The actionable element inside the row: a real button, which is what
   * `focus()` focuses and what activates on Enter and Space without this
   * component or its parent handling either key.
   *
   * The parent also scrolls it into view as focus moves between rows. It does
   * not synthesise clicks on it any more - a focused native button needs no help
   * being activated, and helping it would add the module twice.
   *
   * The host around it is deliberately NOT focusable: a focusable wrapper about
   * a focusable control would be a second tab stop announcing the same command
   * twice. The button carries `tabindex="-1"` instead, keeping the rows out of
   * the natural tab order while leaving them programmatically focusable, which
   * is the roving pattern the parent's key manager drives.
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

  /**
   * The row's accessible name. Composed here because it interpolates the module
   * name, and Angular's `i18n-` attribute localization applies only to static
   * attributes; a bound one has to be localized in code.
   *
   * The module name arrives already translated from the shared metadata, so it
   * is interpolated as a placeholder rather than re-translated.
   */
  public get ariaLabel() {
    return $localize`Add ${this.definition?.name}:moduleName: module`;
  }

  /**
   * Moves real DOM focus to the row's button.
   *
   * This is the `FocusableOption` contract and the parent's key manager is its
   * only caller.
   *
   * The highlight is recorded here as well as from the button's own `focus`
   * event, and both are needed. The event covers focus this component never
   * asked for - a click, or the browser restoring it - while this path covers
   * the case the event cannot: focusing an element that already holds focus
   * fires nothing at all. That happens whenever the key manager returns to the
   * row it is already on, which a single-row result list does on every step, and
   * so does a results update that leaves the focused row in place. Without this,
   * the highlight would go missing while the focus ring stayed put. Both paths
   * write the same value, so they cannot disagree.
   */
  public focus() {
    const element = this.rowElement?.nativeElement;

    // Guarded rather than assumed, and the highlight is recorded only once the
    // focus call has actually been made - a highlight on a row that could not
    // take focus would be describing focus that is somewhere else.
    if (!element) {
      return;
    }

    element.focus();

    this.onFocus();
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
   * The payload is the bare discriminator under `text/plain`, with no wrapper and no
   * encoding: `text/plain` is the transfer type every browser supports, and the bare
   * value is what the module registry resolves against when the canvas reads it back
   * in its drop callback. The grid engine itself never inspects the payload - while a
   * drag hovers it only decides, geometrically, whether a cell is free.
   *
   * `dataTransfer` is guarded rather than assumed, because the workspace compiles with
   * `strictNullChecks` disabled.
   */
  public onDragStart(event: DragEvent) {
    if (!event.dataTransfer) {
      return;
    }

    event.dataTransfer.effectAllowed = 'copy';
    event.dataTransfer.setData('text/plain', this.definition.moduleType);

    this.isDragging = true;

    this.changeDetectorRef.markForCheck();
  }

  /**
   * Records that this row holds focus, whatever moved it here.
   */
  public onFocus() {
    this.hasFocus = true;

    this.changeDetectorRef.markForCheck();
  }

  public removeFocus() {
    this.hasFocus = false;

    this.changeDetectorRef.markForCheck();
  }
}
