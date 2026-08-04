import { NgComponentOutlet } from '@angular/common';
import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  CUSTOM_ELEMENTS_SCHEMA,
  EventEmitter,
  Input,
  OnChanges,
  OnInit,
  Output,
  Type
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatMenuModule } from '@angular/material/menu';
import { IonIcon } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import {
  ellipsisHorizontal,
  reorderTwoOutline,
  trashOutline
} from 'ionicons/icons';
import { NgxSkeletonLoaderModule } from 'ngx-skeleton-loader';

import type {
  DashboardModuleDefinition,
  DashboardModuleGeometryStep
} from '../../interfaces/interfaces';

/**
 * One-cell geometry steps keyed by arrow key.
 *
 * Frozen and declared once at module scope so the mapping cannot be mutated by a
 * handler and is not rebuilt on every keystroke. A key absent from this map
 * produces no step, which is how the handler decides to keep its hands off.
 */
const GEOMETRY_STEPS_BY_KEY: Readonly<
  Record<string, DashboardModuleGeometryStep>
> = Object.freeze({
  ArrowDown: { deltaCols: 0, deltaRows: 1 },
  ArrowLeft: { deltaCols: -1, deltaRows: 0 },
  ArrowRight: { deltaCols: 1, deltaRows: 0 },
  ArrowUp: { deltaCols: 0, deltaRows: -1 }
});

/**
 * Chrome for one module placed on the dashboard: the card, its header and the
 * region the module itself is mounted into.
 *
 * No module class is imported here. It arrives as a lazy thunk on the definition
 * handed in by the canvas, is awaited at runtime and is instantiated by
 * `NgComponentOutlet`, so every module receives identical chrome, none can be
 * special-cased, a module never learns it is drawn inside a grid cell, and its code
 * is fetched only when it is placed.
 *
 * It holds no placement state - the grid owns where a module sits and how large it
 * is - and reaches no persistence API: removal emits an output and stops there,
 * leaving the canvas the only origin of a saved change.
 */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    IonIcon,
    MatButtonModule,
    MatCardModule,
    MatMenuModule,
    NgComponentOutlet,
    NgxSkeletonLoaderModule
  ],
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
  selector: 'gf-dashboard-module-host',
  styleUrls: ['./dashboard-module-host.scss'],
  templateUrl: './dashboard-module-host.html'
})
export class GfDashboardModuleHostComponent implements OnChanges, OnInit {
  @Input() definition: DashboardModuleDefinition;

  /**
   * Emitted once per keyboard move request, as a one-cell step.
   *
   * The canvas resolves the step against grid state and asks the grid engine to
   * commit it, so this host neither knows nor decides where the module ends up -
   * and a step that would collide, leave the grid or break the module's declared
   * minimum is simply refused there.
   */
  @Output() move = new EventEmitter<DashboardModuleGeometryStep>();

  /**
   * Emitted once per removal request. The canvas owns the placement array and
   * the write that follows it, so nothing is discarded or stored from here.
   */
  @Output() remove = new EventEmitter<void>();

  /**
   * Emitted once per keyboard resize request, as a one-cell step. Resolved the
   * same way, and against the same limits, as {@link move}.
   */
  @Output() resize = new EventEmitter<DashboardModuleGeometryStep>();

  /**
   * Set when the current definition could not be turned into a module class.
   * The template then renders a localized notice in place of the module: a
   * failure is contained in this one cell and leaves its siblings and the
   * surrounding canvas untouched.
   */
  public hasLoadError = false;

  public resolvedComponent: Type<unknown>;

  /**
   * Together these two fields make resolution exactly-once per definition.
   * `hasRequestedLoad` separates "not asked yet" from "asked for nothing", which
   * a comparison against `undefined` alone cannot do, and `requestedDefinition`
   * is re-read after every await so a result that arrives for a definition which
   * has since been replaced is discarded instead of painted.
   */
  private hasRequestedLoad = false;

  private requestedDefinition: DashboardModuleDefinition;

  public constructor(private changeDetectorRef: ChangeDetectorRef) {
    addIcons({ ellipsisHorizontal, reorderTwoOutline, trashOutline });
  }

  public ngOnChanges() {
    // `void` is deliberate: the resolution settles its own failures, so there is
    // no rejection to propagate and nothing for a caller to await.
    void this.resolveModule();
  }

  public ngOnInit() {
    // The guard inside makes this a no-op in the normal case, where the bound
    // input has already triggered resolution. It matters only when no definition
    // was ever bound, which would otherwise leave the loading placeholder up
    // forever with nothing on its way to replace it.
    void this.resolveModule();
  }

  /**
   * Turns the arrow keys on the drag handle into geometry steps: bare arrows move
   * the module, Shift with an arrow resizes it from its bottom-right, which is
   * the pair of edges the pointer handles expose.
   *
   * This is what makes the handle honest. It was already focusable, so keyboard
   * users could reach it, but repositioning was a pointer-only gesture - the stop
   * led nowhere. Rather than remove the stop and leave keyboard users with no way
   * to arrange their dashboard at all, the handle now does what its focusability
   * advertises.
   *
   * The default action is suppressed only for keys that produce a step, so the
   * arrow keys still scroll the canvas everywhere else, and every other key -
   * Tab, Escape, activation - is left alone.
   */
  public onDragHandleKeydown(event: KeyboardEvent) {
    const step = GEOMETRY_STEPS_BY_KEY[event.key];

    if (!step) {
      return;
    }

    event.preventDefault();

    if (event.shiftKey) {
      this.resize.emit(step);
    } else {
      this.move.emit(step);
    }
  }

  public onRemove() {
    this.remove.emit();
  }

  private async resolveModule() {
    const definition = this.definition;

    if (this.hasRequestedLoad && definition === this.requestedDefinition) {
      return;
    }

    this.hasRequestedLoad = true;
    this.requestedDefinition = definition;
    this.hasLoadError = false;
    this.resolvedComponent = undefined;

    if (!definition) {
      this.hasLoadError = true;
      this.changeDetectorRef.markForCheck();

      return;
    }

    try {
      // Awaiting inside the try covers both a thunk that rejects and a thunk
      // that throws before it ever returns a promise.
      const component = await definition.loadComponent();

      if (this.requestedDefinition !== definition) {
        return;
      }

      if (component) {
        this.resolvedComponent = component;
      } else {
        // A thunk that resolves with nothing - a renamed or removed export -
        // resolves successfully and would otherwise leave the placeholder up.
        this.hasLoadError = true;
      }
    } catch {
      if (this.requestedDefinition !== definition) {
        return;
      }

      this.hasLoadError = true;
    }

    // Required rather than defensive: the promise settles outside any input
    // change, and this view is only checked when it is marked.
    this.changeDetectorRef.markForCheck();
  }
}
