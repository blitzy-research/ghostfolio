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
 * Slack, in pixels, before a module counts as continuing past its edge.
 *
 * `scrollHeight` and `clientHeight` are integers while `scrollTop` is
 * fractional, and a fractional layout leaves a sub-pixel remainder at the very
 * end of a scroll. Without this tolerance a module scrolled fully to the bottom
 * would keep claiming there is more below, which is worse than saying nothing:
 * an indicator that is always on carries no information.
 */
const OVERFLOW_TOLERANCE = 1;

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
export class GfDashboardModuleHostComponent
  implements AfterViewInit, OnChanges, OnDestroy, OnInit
{
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
   * The drag handle, held so the canvas can move focus onto this module.
   *
   * Queried rather than reached for through the DOM because the handle is the one
   * element in this template whose identity the canvas depends on, and a query
   * fails loudly at compile time if the reference is ever dropped from the
   * markup, where a selector would silently start matching nothing.
   */
  @ViewChild('dragHandle') private dragHandle: ElementRef<HTMLElement>;

  /**
   * The scrolling body. Held as a reference rather than reached for with a query
   * so the overflow watcher observes exactly the element that scrolls, whatever
   * the module inside it renders.
   */
  @ViewChild('moduleContent') private moduleContent: ElementRef<HTMLElement>;

  /**
   * Set when the current definition could not be turned into a module class.
   * The template then renders a localized notice in place of the module: a
   * failure is contained in this one cell and leaves its siblings and the
   * surrounding canvas untouched.
   */
  public hasLoadError = false;

  /**
   * Whether the module's body continues above and below what is on screen.
   *
   * Read by the template to draw a hint in that direction, and kept as two
   * independent flags rather than one "is scrollable" flag so a hint only ever
   * points where there is genuinely something to find.
   */
  public hasOverflowAbove = false;

  public hasOverflowBelow = false;

  /**
   * The same question for the inline axis. Kept separate from the block axis
   * because a table can continue sideways while fitting vertically, and a mark on
   * the wrong edge would send the reader looking in the wrong place.
   */
  public hasOverflowEnd = false;

  public hasOverflowStart = false;

  public resolvedComponent: Type<unknown>;

  /**
   * Together these two fields make resolution exactly-once per definition.
   * `hasRequestedLoad` separates "not asked yet" from "asked for nothing", which
   * a comparison against `undefined` alone cannot do, and `requestedDefinition`
   * is re-read after every await so a result that arrives for a definition which
   * has since been replaced is discarded instead of painted.
   */
  private animationFrameHandle: number;

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

  /**
   * Starts watching the module's body for anything that could change what is
   * reachable inside it: the user scrolling, the cell being resized, and the
   * module's own content arriving or growing - a table that paginates in 50 rows
   * changes what is hidden without either the body or the cell changing size, so
   * watching geometry alone would miss the case that matters most.
   *
   * Everything is registered outside Angular and re-enters only when a flag
   * actually flips. Scroll fires at pointer rate, and a canvas holds many of
   * these at once, so letting each event drive a change-detection pass would put
   * avoidable work on the same main thread the grid needs for its sub-100ms drag
   * and resize budget. Coalescing through one animation frame collapses the burst
   * a single gesture produces into one measurement per painted frame.
   */
  public ngAfterViewInit() {
    const element = this.moduleContent?.nativeElement;

    if (!element) {
      return;
    }

    this.zone.runOutsideAngular(() => {
      element.addEventListener('scroll', this.scheduleOverflowCheck, {
        passive: true
      });

      // Guarded rather than assumed: this component is instantiated under a test
      // DOM that implements MutationObserver but not ResizeObserver, and a hard
      // reference would turn a missing observer into a constructor throw that
      // takes the whole module host down with it.
      if (typeof ResizeObserver === 'function') {
        this.resizeObserver = new ResizeObserver(this.scheduleOverflowCheck);
        this.resizeObserver.observe(element);

        // The scroller's own box is not a sufficient signal on its own. When the
        // grid cell narrows, the scroller resizes in one frame but content that
        // sizes itself imperatively - a chart canvas being the case measured here
        // - catches up a frame or more later. Observing what fills the body as
        // well means the reflow that follows is seen even though the scroller
        // settled at its new size on the first frame and will never report again.
        this.syncObservedContentChild();
      }

      if (typeof MutationObserver === 'function') {
        this.mutationObserver = new MutationObserver(
          this.scheduleOverflowCheck
        );
        this.mutationObserver.observe(element, {
          // `attributes` is load-bearing rather than defensive. A chart resizes
          // by rewriting its canvas `width`/`height` attributes, which changes
          // the scroller's `scrollWidth` without adding, removing or retyping a
          // single node. Without this filter a narrowing viewport left a hint
          // advertising overflow that the reflow had already removed, because
          // nothing observable had changed since the stale measurement. The
          // filter is narrow, and every notification still collapses into one
          // measurement per painted frame that returns early unless a flag
          // actually flips, so the extra signal costs nothing when idle.
          attributeFilter: ['class', 'height', 'style', 'width'],
          attributes: true,
          characterData: true,
          childList: true,
          subtree: true
        });
      }

      // The hints live OUTSIDE the observed element, so drawing one cannot
      // change what is observed and the measurement cannot feed itself.
      this.scheduleOverflowCheck();
    });
  }

  public ngOnChanges() {
    // `void` is deliberate: the resolution settles its own failures, so there is
    // no rejection to propagate and nothing for a caller to await.
    void this.resolveModule();
  }

  public ngOnDestroy() {
    const element = this.moduleContent?.nativeElement;

    element?.removeEventListener('scroll', this.scheduleOverflowCheck);

    this.mutationObserver?.disconnect();
    this.resizeObserver?.disconnect();
    this.observedContentChild = null;

    // A frame already booked would otherwise run against a destroyed view and
    // mark it for a check that will never come.
    if (this.animationFrameHandle !== undefined) {
      cancelAnimationFrame(this.animationFrameHandle);
    }
  }

  public ngOnInit() {
    // The guard inside makes this a no-op in the normal case, where the bound
    // input has already triggered resolution. It matters only when no definition
    // was ever bound, which would otherwise leave the loading placeholder up
    // forever with nothing on its way to replace it.
    void this.resolveModule();
  }

  /**
   * Puts keyboard focus on this module's drag handle, reporting whether it landed.
   *
   * Exists so the canvas can keep focus somewhere useful after a module is removed
   * by keyboard. It reports rather than assumes, because the caller walks a list of
   * candidates and needs to know when to try the next one: this host may be mid
   * teardown, or - while a `@ViewChild` is still unresolved - not yet have a handle
   * at all.
   *
   * The read-back is not defensive noise. `focus()` on a detached or hidden element
   * is a silent no-op in every browser, so the only honest way to answer the
   * question is to ask the document where focus actually ended up.
   */
  public focusDragHandle(): boolean {
    const handle = this.dragHandle?.nativeElement;

    if (!handle) {
      return false;
    }

    handle.focus();

    return handle.ownerDocument?.activeElement === handle;
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

  /**
   * Discards the mounted module and mounts it again, so it re-reads everything it
   * draws from.
   *
   * This is how a dashboard-wide refresh is actually delivered. The former
   * mechanism was a bare subject with a single subscriber inside one feature
   * component, so the control that claimed to refresh the dashboard refreshed
   * nothing at all for any arrangement that did not happen to include that one
   * module. Re-creating the mounted component instead makes the refresh a property
   * of the host rather than of the module: every module fetches on construction,
   * so every module refreshes, and none of them needs to know the control exists.
   *
   * Two phases, and they cannot be collapsed into one. `NgComponentOutlet`
   * re-creates its content when the bound component TYPE changes, and the type
   * resolved here is the same one on both sides of a reload - so the outlet has to
   * observe the absence in between. `detectChanges()` is what guarantees that:
   * marking the view and re-assigning within the same task would leave the outlet
   * seeing an unchanged type and nothing would be re-created. The synchronous form
   * is safe because every caller is an event handler, never a change-detection
   * pass.
   *
   * Nothing about the cell is touched - not its position, not its size, not the
   * grid item behind it - so a refresh produces no grid callback and therefore no
   * layout write.
   */
  public reload() {
    if (!this.definition) {
      return;
    }

    // Phase one: let the outlet see the module gone, and destroy it.
    this.resolvedComponent = undefined;
    this.hasLoadError = false;

    this.changeDetectorRef.detectChanges();

    // Phase two: ask the registry for it again. Both fields are cleared so the
    // exactly-once guard admits the request instead of treating it as the one
    // already served for this definition.
    this.hasRequestedLoad = false;
    this.requestedDefinition = undefined;

    // `void` for the same reason as in `ngOnChanges`: the resolution settles its
    // own failures, so there is no rejection to propagate.
    void this.resolveModule();
  }

  /**
   * Measures what is currently out of reach in the module's body and publishes
   * the result, re-entering Angular only on a change.
   *
   * The early return is what keeps this cheap: a scroll gesture produces a long
   * run of frames in which neither answer changes, and each of those would
   * otherwise cost a change-detection pass for nothing.
   */
  private applyOverflowState() {
    const element = this.moduleContent?.nativeElement;

    if (!element) {
      return;
    }

    const hasOverflowAbove = element.scrollTop > OVERFLOW_TOLERANCE;
    const hasOverflowBelow =
      element.scrollHeight - element.clientHeight - element.scrollTop >
      OVERFLOW_TOLERANCE;

    // Measured as a distance from the start edge rather than from the left, so
    // this reads correctly under a right-to-left locale as well: the browser
    // reports a negative offset there, and its magnitude is still how far the
    // reader has travelled from where the content begins.
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

    // Re-entry is required, not decorative: the measurement runs outside Angular,
    // where marking a view has nothing to schedule it.
    this.zone.run(() => {
      this.hasOverflowAbove = hasOverflowAbove;
      this.hasOverflowBelow = hasOverflowBelow;
      this.hasOverflowEnd = hasOverflowEnd;
      this.hasOverflowStart = hasOverflowStart;

      this.changeDetectorRef.markForCheck();
    });
  }

  /**
   * Collapses a burst of scroll, resize and mutation notifications into one
   * measurement on the next painted frame.
   *
   * An arrow property rather than a method so the same function identity is used
   * to add and to remove the scroll listener, and so `this` survives being called
   * back by an observer.
   */
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

  /**
   * Keeps the child half of the size observation pointed at whatever currently
   * fills the body.
   *
   * The body starts out holding a loading placeholder and only later holds the
   * resolved module, so the element observed at view init is usually not the one
   * whose reflow matters. An observer left on the replaced node is not an error,
   * it is worse: it stays silent forever, because a detached element never
   * reports a size change. Re-targeting on the same frame the swap is noticed
   * costs one comparison and keeps the signal attached across the swap.
   */
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
