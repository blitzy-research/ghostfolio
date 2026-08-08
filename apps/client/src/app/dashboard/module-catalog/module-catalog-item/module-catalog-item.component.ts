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
// is a spec-compilation error (TS1272).
import type { DashboardModuleDefinition } from '../../interfaces/interfaces';

/**
 * A single row of the dashboard module catalog, drawing whatever definition the
 * parent hands it - already narrowed by permission and by the active search
 * term.
 *
 * It is three things at once: a click target that emits an add-module intent; a
 * native HTML5 drag source whose payload the canvas reads when the row is
 * dropped onto an empty grid cell; and a `FocusableOption`, so the parent's
 * `FocusKeyManager` can move a roving focus across the rows with wraparound.
 * That focus is real DOM focus on the row's button, which is what a key manager
 * assumes - it calls `focus()` on the option it moves to and does nothing else,
 * so an option that only painted a highlight would leave keyboard focus
 * stranded.
 *
 * The row holds no layout geometry, resolves no module component, checks no
 * permission and persists nothing; its only outward signals are the
 * `moduleAdded` output and the drag payload.
 */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatButtonModule, MatCardModule],
  selector: 'gf-module-catalog-item',
  styleUrls: ['./module-catalog-item.scss'],
  templateUrl: './module-catalog-item.html'
})
export class GfModuleCatalogItemComponent implements FocusableOption {
  // Complements the `role="list"` the parent sets on its results container.
  @HostBinding('attr.role') role = 'listitem';

  @Input() definition: DashboardModuleDefinition;

  @ViewChild('row', { read: ElementRef })
  public rowElement: ElementRef<HTMLElement>;

  @Input() isPlaced = false;

  @Input() isTabbable = false;

  @Input() isUnavailable = false;

  public hasFocus = false;
  public isDragging = false;

  protected readonly focused = output<void>();

  protected readonly moduleAdded = output<DashboardModuleType>();

  protected readonly dragStarted = output<DashboardModuleType>();

  protected readonly dragEnded = output<void>();

  private readonly changeDetectorRef = inject(ChangeDetectorRef);

  @HostBinding('class.has-focus')
  public get getHasFocus() {
    return this.hasFocus;
  }

  public get ariaLabel() {
    if (this.isPlaced) {
      return $localize`Reveal ${this.qualifiedName}:moduleName: module`;
    }

    return this.isUnavailable
      ? $localize`Add ${this.qualifiedName}:moduleName: module, no room on the dashboard`
      : $localize`Add ${this.qualifiedName}:moduleName: module`;
  }

  public get qualifiedName() {
    return this.definition?.context
      ? `${this.definition.name} · ${this.definition.context}`
      : this.definition?.name;
  }

  // Focus is placed on the row's button rather than on the host, and the local
  // highlight is raised through the same path a pointer focus takes, so
  // keyboard and pointer focus cannot disagree about which row is current.
  public focus() {
    const element = this.rowElement?.nativeElement;

    if (!element) {
      return;
    }

    element.focus();

    this.onFocus();
  }

  public onClick() {
    this.moduleAdded.emit(this.definition.moduleType);
  }

  public onDragEnd() {
    this.isDragging = false;

    this.dragEnded.emit();

    this.changeDetectorRef.markForCheck();
  }

  // The native drag payload contract the canvas reads on drop: the raw
  // kebab-case discriminator under the `text/plain` key, with no JSON, no
  // wrapper object, no prefix and no custom MIME type. `dataTransfer` is absent
  // for a synthetic event, so a drag that carries nothing is abandoned rather
  // than half-started.
  public onDragStart(event: DragEvent) {
    if (!event.dataTransfer) {
      return;
    }

    event.dataTransfer.effectAllowed = 'copyMove';
    event.dataTransfer.setData('text/plain', this.definition.moduleType);

    this.isDragging = true;

    this.dragStarted.emit(this.definition.moduleType);

    this.changeDetectorRef.markForCheck();
  }

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
