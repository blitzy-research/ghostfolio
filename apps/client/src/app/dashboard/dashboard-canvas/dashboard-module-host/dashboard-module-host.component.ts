import { reportSanitizedError } from '@ghostfolio/common/helper';

import { NgComponentOutlet } from '@angular/common';
import {
  AfterViewInit,
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  CUSTOM_ELEMENTS_SCHEMA,
  ElementRef,
  EventEmitter,
  Input,
  NgZone,
  OnChanges,
  OnDestroy,
  OnInit,
  Output,
  Type,
  ViewChild
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

// Frozen and declared once at module scope so the mapping cannot be mutated by
// a handler and is not rebuilt on every keystroke. A key absent from this map
// produces no step, which is how the handler decides to keep its hands off.
const GEOMETRY_STEPS_BY_KEY: Readonly<
  Record<string, DashboardModuleGeometryStep>
> = Object.freeze({
  ArrowDown: { deltaCols: 0, deltaRows: 1 },
  ArrowLeft: { deltaCols: -1, deltaRows: 0 },
  ArrowRight: { deltaCols: 1, deltaRows: 0 },
  ArrowUp: { deltaCols: 0, deltaRows: -1 }
});

// A one-pixel slack, because `scrollHeight`, `clientHeight` and `scrollTop` are
// rounded independently and a fractional layout otherwise reports a permanent
// overflow of well under a pixel.
const OVERFLOW_TOLERANCE = 1;

/**
 * The chrome around one module on the canvas: the drag handle the grid is
 * configured to drag from, the module's name, an overflow menu whose only
 * action removes it, and the scrolling body the resolved module is mounted
 * into.
 *
 * A module arrives as metadata rather than as a class. This host awaits the
 * definition's lazy loader and hands the result to `NgComponentOutlet`, so it
 * imports no module component and knows nothing about what any module renders.
 *
 * It holds no geometry. Keyboard move and resize are emitted as one-cell
 * *steps*, never as coordinates, and removal is emitted as a bare intent - the
 * canvas resolves all three against grid state, which stays the single
 * authority for placement. Nothing here writes a layout.
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
export class GfDashboardModuleHostComponent
  implements AfterViewInit, OnChanges, OnDestroy, OnInit
{
  @Input() definition: DashboardModuleDefinition;

  @Output() move = new EventEmitter<DashboardModuleGeometryStep>();

  @Output() remove = new EventEmitter<void>();

  @Output() resize = new EventEmitter<DashboardModuleGeometryStep>();

  // The element carrying `gf-dashboard-module-drag-handle`, which is a frozen
  // literal contract with the grid configuration's `draggable.dragHandleClass`
  // and with the global grid stylesheet. It is also where focus is placed after
  // a neighbouring module is removed by keyboard.
  @ViewChild('dragHandle') private dragHandle: ElementRef<HTMLElement>;

  @ViewChild('moduleContent') private moduleContent: ElementRef<HTMLElement>;

  public hasLoadError = false;

  // Whether the module's body is scrolled away from, or continues past, each
  // edge. The block and inline axes are tracked separately because a table can
  // continue sideways while fitting vertically, and a mark on the wrong edge
  // would send the reader looking in the wrong place.
  public hasOverflowAbove = false;

  public hasOverflowBelow = false;

  public hasOverflowEnd = false;

  public hasOverflowStart = false;

  public resolvedComponent: Type<unknown>;

  // Held only so the pending overflow check can be cancelled at teardown.
  private animationFrameHandle: number;

  // Together with `requestedDefinition` this makes resolution exactly-once per
  // definition. `hasRequestedLoad` separates "not asked yet" from "asked for
  // nothing", which a comparison against `undefined` alone cannot do, and
  // `requestedDefinition` is re-read after every await so a result that arrives
  // for a definition which has since been replaced is discarded instead of
  // painted.
  private hasRequestedLoad = false;

  private isOverflowCheckScheduled = false;

  private mutationObserver: MutationObserver;

  private observedContentChild: Element = null;

  private requestedDefinition: DashboardModuleDefinition;

  private resizeObserver: ResizeObserver;

  public constructor(
    private changeDetectorRef: ChangeDetectorRef,
    private zone: NgZone
  ) {
    addIcons({ ellipsisHorizontal, reorderTwoOutline, trashOutline });
  }

  // Two modules can legitimately share a display name, because the shared
  // metadata reuses the route registry's title verbatim and that registry
  // titles both market screens and both settings screens identically. On one
  // canvas both can be placed at once, so the qualifier is what tells the two
  // cards apart.
  public get qualifiedName(): string {
    return this.definition?.context
      ? `${this.definition.name} · ${this.definition.context}`
      : this.definition?.name;
  }

  public ngAfterViewInit() {
    const element = this.moduleContent?.nativeElement;

    if (!element) {
      return;
    }

    // Registered outside Angular, because a scroll listener and two observers
    // on module content would otherwise schedule a change-detection pass per
    // frame of every scroll. Re-entry is deliberately narrow: only {@link
    // applyOverflowState} steps back in, and only when an edge has actually
    // changed.
    this.zone.runOutsideAngular(() => {
      element.addEventListener('scroll', this.scheduleOverflowCheck, {
        passive: true
      });

      // Feature-detected because this component is also instantiated under a
      // DOM shim in tests. The marks simply do not appear where an observer is
      // absent.
      if (typeof ResizeObserver === 'function') {
        this.resizeObserver = new ResizeObserver(this.scheduleOverflowCheck);
        this.resizeObserver.observe(element);

        this.syncObservedContentChild();
      }

      if (typeof MutationObserver === 'function') {
        this.mutationObserver = new MutationObserver(
          this.scheduleOverflowCheck
        );
        this.mutationObserver.observe(element, {
          attributeFilter: ['class', 'height', 'style', 'width'],
          attributes: true,
          characterData: true,
          childList: true,
          subtree: true
        });
      }

      this.scheduleOverflowCheck();
    });
  }

  public ngOnChanges() {
    void this.resolveModule();
  }

  public ngOnDestroy() {
    const element = this.moduleContent?.nativeElement;

    element?.removeEventListener('scroll', this.scheduleOverflowCheck);

    this.mutationObserver?.disconnect();
    this.resizeObserver?.disconnect();
    this.observedContentChild = null;

    if (this.animationFrameHandle !== undefined) {
      cancelAnimationFrame(this.animationFrameHandle);
    }
  }

  public ngOnInit() {
    void this.resolveModule();
  }

  // Reports whether focus actually landed, because `focus()` on a detached or
  // hidden element is a silent no-op and the canvas needs to know whether to
  // fall back to its own trigger.
  public focusDragHandle(): boolean {
    const handle = this.dragHandle?.nativeElement;

    if (!handle) {
      return false;
    }

    handle.focus();

    return handle.ownerDocument?.activeElement === handle;
  }

  // Shift turns a move into a resize, so one handle serves both without a
  // second control. `preventDefault` is called only for a key that produced a
  // step, so an arrow key on the handle does not also scroll the canvas while
  // every other key keeps its native behaviour.
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

  /**
   * Re-mounts the module so it re-reads whatever it draws from, without this
   * host knowing what any module fetches.
   *
   * The outlet has to see the module gone before it is asked for again, hence
   * the synchronous `detectChanges` between the two halves: clearing and
   * re-resolving in one pass would leave the same component instance in place
   * and nothing would be re-created. Both resolution fields are then cleared so
   * the exactly-once guard admits the new request instead of treating it as the
   * one already served for this definition.
   *
   * No cell is moved, resized, added or removed, so no grid callback fires and
   * no layout write is scheduled.
   */
  public reload() {
    if (!this.definition) {
      return;
    }

    this.resolvedComponent = undefined;
    this.hasLoadError = false;

    this.changeDetectorRef.detectChanges();

    this.hasRequestedLoad = false;
    this.requestedDefinition = undefined;

    void this.resolveModule();
  }

  // Compared before anything is written, so a scroll that does not cross an
  // edge costs no change detection at all - which is what makes it safe to run
  // this from a per-frame scroll handler.
  private applyOverflowState() {
    const element = this.moduleContent?.nativeElement;

    if (!element) {
      return;
    }

    const hasOverflowAbove = element.scrollTop > OVERFLOW_TOLERANCE;
    const hasOverflowBelow =
      element.scrollHeight - element.clientHeight - element.scrollTop >
      OVERFLOW_TOLERANCE;

    const scrolledFromStart = Math.abs(element.scrollLeft);
    const hasOverflowStart = scrolledFromStart > OVERFLOW_TOLERANCE;
    const hasOverflowEnd =
      element.scrollWidth - element.clientWidth - scrolledFromStart >
      OVERFLOW_TOLERANCE;

    if (
      hasOverflowAbove === this.hasOverflowAbove &&
      hasOverflowBelow === this.hasOverflowBelow &&
      hasOverflowEnd === this.hasOverflowEnd &&
      hasOverflowStart === this.hasOverflowStart
    ) {
      return;
    }

    // The one re-entry into Angular, taken only for an actual change.
    this.zone.run(() => {
      this.hasOverflowAbove = hasOverflowAbove;
      this.hasOverflowBelow = hasOverflowBelow;
      this.hasOverflowEnd = hasOverflowEnd;
      this.hasOverflowStart = hasOverflowStart;

      this.changeDetectorRef.markForCheck();
    });
  }

  // An arrow function held as a field so the same reference can be added and
  // removed as an event listener, and coalesced to one measurement per frame
  // because the scroll listener and both observers can all fire within a single
  // frame.
  private scheduleOverflowCheck = () => {
    if (this.isOverflowCheckScheduled) {
      return;
    }

    this.isOverflowCheckScheduled = true;

    this.animationFrameHandle = requestAnimationFrame(() => {
      this.isOverflowCheckScheduled = false;

      this.syncObservedContentChild();
      this.applyOverflowState();
    });
  };

  // The body element's own box does not change when its content grows, because
  // it is the scrollport; the first child is what actually resizes. Re-pointed
  // rather than added to, so a re-mounted module does not leave the previous
  // child observed.
  private syncObservedContentChild() {
    if (!this.resizeObserver) {
      return;
    }

    const child = this.moduleContent?.nativeElement?.firstElementChild ?? null;

    if (child === this.observedContentChild) {
      return;
    }

    if (this.observedContentChild) {
      this.resizeObserver.unobserve(this.observedContentChild);
    }

    this.observedContentChild = child;

    if (child) {
      this.resizeObserver.observe(child);
    }
  }

  // The definition is captured once and re-checked after the await, so a
  // definition replaced while the chunk was in flight discards the late result
  // rather than painting it. A loader that resolves to nothing is treated as a
  // failure, because an outlet given `undefined` renders an empty card with no
  // explanation.
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
      const component = await definition.loadComponent();

      if (this.requestedDefinition !== definition) {
        return;
      }

      if (component) {
        this.resolvedComponent = component;
      } else {
        this.hasLoadError = true;
      }
    } catch (error: unknown) {
      if (this.requestedDefinition !== definition) {
        return;
      }

      // Reported before the state is set, and through the sanitized channel that
      // the rest of the application uses for a failed chunk. A rejected
      // `loadComponent()` is a network failure against a real build artefact - a
      // chunk that a deployment is missing, or that a stale service worker is
      // still asking for - and the card that replaces it says only "Oops!", so
      // without this the only signal an operator has is a viewer's report that a
      // module went blank.
      //
      // Sanitized rather than raw for the reason the whole vocabulary exists: the
      // caught value is whatever the module loader rejected with, which for a
      // chunk request carries the request url and a stack naming the deployment's
      // own paths, and the console is readable by every script on the page and
      // captured verbatim by session-replay tooling. A fixed event identifier and
      // the numeric status are what an operator can act on, and they are all that
      // is emitted.
      //
      // The identifier deliberately carries no module type. It would name which
      // arrangement the viewer had built, and one identifier per module would make
      // the class of failure - "a chunk is unreachable" - unsearchable as a single
      // thing. The superseded check above stays ahead of the report, because a
      // definition replaced mid-flight is a discarded request rather than a fault.
      reportSanitizedError('GF-DASHBOARD-MODULE-HOST-LOAD-FAILED', error);

      this.hasLoadError = true;
    }

    this.changeDetectorRef.markForCheck();
  }
}
