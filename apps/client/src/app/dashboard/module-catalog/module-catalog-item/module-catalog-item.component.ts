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
import { MatButtonModule } from '@angular/material/button';
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
  imports: [MatButtonModule, MatCardModule],
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
   * twice. The button's own `tabindex` is bound from {@link isTabbable}, so the
   * rows share exactly one tab stop between them while all of them stay
   * programmatically focusable - the roving pattern the parent's key manager
   * drives.
   */
  @ViewChild('row', { read: ElementRef })
  public rowElement: ElementRef<HTMLElement>;

  /**
   * Whether the module this row offers is already on the canvas.
   *
   * Presentation only, and deliberately not layout state: it is a membership
   * answer about module TYPES, carries no coordinate or size, and is supplied by
   * the canvas - which owns the arrangement - rather than derived or cached here.
   * Its purpose is that a row whose click reveals an existing module no longer
   * looks identical to a row whose click adds one.
   */
  @Input() isPlaced = false;

  /**
   * Whether this row is the one the Tab key reaches.
   *
   * The rows share a single tab stop, which is what a roving-focus list is: the
   * parent decides which row holds it, and every other row stays reachable only
   * programmatically. Without one row answering `true` the entire result list is
   * unreachable from the keyboard.
   */
  @Input() isTabbable = false;

  /**
   * Whether the canvas has no room for the module this row offers.
   *
   * Presentation and naming only, on the same terms as {@link isPlaced}: a
   * membership answer about module TYPES, holding no coordinate and no size, and
   * supplied by the canvas because answering it needs the grid geometry this
   * component must never see.
   *
   * The row stays enabled while it is set, which is the accessible choice rather
   * than a lenient one. A `disabled` button cannot be focused, so a keyboard user
   * would find the row skipped with no explanation, and a pointer user would get
   * no response to a click; left enabled and marked with `aria-disabled`, the row
   * is still reachable, still announces why it is unavailable, and its activation
   * is what produces the canvas's explanation of what to do about it.
   */
  @Input() isUnavailable = false;

  public hasFocus = false;
  public isDragging = false;

  /**
   * Raised whenever this row takes focus, so the parent can adopt a focus move it
   * did not make itself - a Tab into the list, a click, or the browser restoring
   * focus after the panel reopens.
   *
   * Without it the key manager keeps measuring from wherever it last put focus,
   * and from its initial "nothing active" the first arrow press jumps to one end
   * of the list instead of stepping one row from where the viewer actually is.
   */
  protected readonly focused = output<void>();

  protected readonly moduleAdded = output<DashboardModuleType>();

  /**
   * Raised when a native drag of this row begins, carrying which module is being
   * dragged.
   *
   * It exists because the grid engine sizes its own drop indicator from a single
   * global default and knows nothing about per-module metadata: while a drag
   * hovers, the engine mints its preview as `{ cols: defaultItemCols, rows:
   * defaultItemRows }`, so the indicator described a 4x4 footprint for every
   * module while the item actually committed on drop carried the registry's own -
   * up to twelve columns. The viewer was shown one size and given another.
   *
   * Announcing the module type is all this row does about it. Deciding what to do
   * with the announcement belongs to the canvas, which is the only thing that owns
   * grid policy; this row still holds no geometry and reads nothing but `name` and
   * `moduleType` from its definition.
   */
  protected readonly dragStarted = output<DashboardModuleType>();

  /**
   * Raised when a native drag of this row ends, however it ended.
   *
   * Paired with {@link dragStarted} so that whatever was adjusted for the drag can
   * be put back. `dragend` is the only dependable place for it: a drag can finish
   * in a drop, a cancel, or a release outside the grid, and only this event is
   * raised in all three cases.
   */
  protected readonly dragEnded = output<void>();

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
    // Separate messages rather than one with conditional fragments, because the
    // rows genuinely offer different commands: an unplaced row adds the module, a
    // placed row scrolls the one already on the canvas into view, and a row the
    // grid has no room for can do neither. A single name for all three would
    // misdescribe two of them.
    //
    // Placement is tested first on purpose: a module already on the canvas is
    // revealed by its row no matter how full the grid is, so it is never reported
    // as having nowhere to go.
    if (this.isPlaced) {
      return $localize`Reveal ${this.qualifiedName}:moduleName: module`;
    }

    return this.isUnavailable
      ? $localize`Add ${this.qualifiedName}:moduleName: module, no room on the dashboard`
      : $localize`Add ${this.qualifiedName}:moduleName: module`;
  }

  /**
   * The module's name, followed by its qualifier where it has one.
   *
   * Two modules can legitimately share a name: the shared metadata reuses the
   * route registry's title verbatim, and that registry titles both market screens
   * `Markets` and both settings screens `Settings`. Behind a URL that was
   * harmless; in a flat list it leaves two rows that are indistinguishable both by
   * eye and to a screen reader, and this row's whole visible content is its name.
   *
   * Composed from the two already-translated values rather than from a new
   * message, so the qualifier costs no locale an untranslated string: the name and
   * the qualifier are interpolated data, and the sentence around them is still the
   * one message every locale already carries. That is also why the separator lives
   * here rather than in the metadata - the authoritative name must stay exactly the
   * registry's title.
   */
  public get qualifiedName() {
    return this.definition?.context
      ? `${this.definition.name} · ${this.definition.context}`
      : this.definition?.name;
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

    // Emitted unconditionally, including after a drag that dropped nothing: the
    // parent uses it to undo an adjustment it made for the drag, and leaving that
    // adjustment in place would size the NEXT module's drop indicator from this
    // module's metadata.
    this.dragEnded.emit();

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

    // `copyMove`, and the reason is a hard protocol requirement rather than a
    // preference. The browser only fires a drop when the effect the SOURCE allows
    // and the effect the TARGET requests intersect. The grid engine's own dragover
    // handler unconditionally sets `dropEffect = 'move'` over a free cell, so a
    // source allowing only `copy` leaves an empty intersection: the browser
    // resolves the operation to `none`, no drop event is ever dispatched, and the
    // gesture ends in `dragleave` -> `dragend` having added nothing at all.
    //
    // `copyMove` admits the engine's `move` while still describing what actually
    // happens - the row stays in the catalog - so the pointer keeps its copy
    // affordance over anything else that might accept it. Do not narrow this back
    // to `copy`: it compiles, lints and looks right, and silently breaks
    // drag-to-add.
    event.dataTransfer.effectAllowed = 'copyMove';
    event.dataTransfer.setData('text/plain', this.definition.moduleType);

    this.isDragging = true;

    // Announced here rather than from the drop, because the drop indicator is
    // drawn from the moment the drag enters the grid - by the time a drop happens
    // there is nothing left to preview. The payload above is what the canvas reads
    // on DROP; this is what it needs BEFORE one.
    this.dragStarted.emit(this.definition.moduleType);

    this.changeDetectorRef.markForCheck();
  }

  /**
   * Records that this row holds focus, whatever moved it here.
   */
  public onFocus() {
    this.hasFocus = true;

    this.focused.emit();

    this.changeDetectorRef.markForCheck();
  }

  public removeFocus() {
    this.hasFocus = false;

    this.changeDetectorRef.markForCheck();
  }
}
