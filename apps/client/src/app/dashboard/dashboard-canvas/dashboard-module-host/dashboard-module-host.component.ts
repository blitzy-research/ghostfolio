import { getQualifiedDashboardModuleName } from '@ghostfolio/common/dashboard';
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

// How much has to be hidden past an edge before that edge is marked, in CSS
// pixels.
//
// It subsumes the sub-pixel slack the previous value of one pixel existed for -
// `scrollHeight`, `clientHeight` and `scrollTop` are rounded independently, so a
// fractional layout reports a permanent overflow of well under a pixel - but the
// value is set by a second and larger concern. A mark is itself 0.75rem of the
// module's own edge, so where LESS than its own extent is hidden the mark covers
// more than it could ever reveal: modules were being marked over a seven-pixel
// residue with exactly the same affordance a genuinely truncated table gets,
// which spends the reader's attention on nothing and devalues the mark where it
// matters. Tying the threshold to the mark's own size keeps the two in step: if
// the strip is ever resized, the smallest overflow worth advertising moves with
// it.
//
// Deliberately applied on all four edges, including the two that compare against
// `scrollTop`/`scrollLeft` rather than against a remainder, so the marks appear
// and disappear symmetrically as a module is scrolled.
const OVERFLOW_HINT_THRESHOLD = 12;

// The element every CDK overlay - dialog, menu, tooltip, select - is attached
// inside. Focus sitting anywhere within it is what distinguishes "an overlay is
// holding focus and will hand it back" from "the viewer moved focus themselves",
// and it is a structural fact of the CDK rather than a class this application
// applies, so it cannot drift out of step with a component's own markup.
const OVERLAY_CONTAINER_SELECTOR = '.cdk-overlay-container';

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

  // How many times resolution has failed in a row for this host, reset by the
  // first success. Two is the threshold that distinguishes a failure worth
  // retrying in place from one that cannot be, because the second failure is the
  // evidence: see `hasExhaustedInPlaceRecovery`.
  public loadFailureCount = 0;

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

  // Non-null only between focus leaving this module and focus settling
  // somewhere - the window in which something this module opened might hand
  // focus back. `ancestors` is where each scrollable ancestor stands right now,
  // kept current for as long as the window is open, and
  // `isOverlayHoldingFocus` records whether an overlay took focus in the
  // meantime, which is what makes a return a hand-back rather than an arrival.
  private pendingFocusHandback: {
    ancestors: { element: Element; scrollLeft: number; scrollTop: number }[];
    isOverlayHoldingFocus: boolean;
  } = null;

  public constructor(
    private changeDetectorRef: ChangeDetectorRef,
    private elementRef: ElementRef<HTMLElement>,
    private zone: NgZone
  ) {
    addIcons({ ellipsisHorizontal, reorderTwoOutline, trashOutline });
  }

  // Two modules can legitimately share a display name, because the shared
  // metadata reuses the route registry's title verbatim and that registry
  // titles both market screens and both settings screens identically. On one
  // canvas both can be placed at once, so the qualifier is what tells the two
  // cards apart.
  //
  // Composed by the shared helper rather than here, so this card's title, this
  // card's region name, the catalog row for the same module and every
  // announcement the canvas makes about it are the same string by construction
  // instead of by four authors agreeing.
  public get qualifiedName(): string | undefined {
    return getQualifiedDashboardModuleName(this.definition);
  }

  /**
   * Whether retrying this module in place has been shown not to work.
   *
   * A failed dynamic import cannot be retried within the same document. The module
   * map records the failure against the chunk's url and every later `import()` of
   * that url rejects from the record instead of asking the network again - measured
   * as an instant rejection with zero requests, while a plain `fetch()` of the same
   * url returned 200. Removing the module and adding it back does not help either,
   * because the map belongs to the document rather than to anything Angular owns.
   *
   * So the first failure is worth a retry and the second is not. A retry is still
   * offered first, because it costs nothing and genuinely recovers the failures
   * that are not chunk failures - a loader that resolved to nothing, a definition
   * that was missing while the registry was still settling - and because the only
   * way to tell those apart from the outside is to try. Once a retry has failed,
   * this becomes true and the module offers the recovery that does work.
   */
  public get hasExhaustedInPlaceRecovery() {
    return this.loadFailureCount >= 2;
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

    this.monitorModuleFocus();
  }

  public ngOnChanges() {
    void this.resolveModule();
  }

  public ngOnDestroy() {
    const element = this.moduleContent?.nativeElement;

    element?.removeEventListener('scroll', this.scheduleOverflowCheck);

    const host = this.elementRef.nativeElement;

    host.removeEventListener('focusout', this.recordScrollOnFocusOut);

    document.removeEventListener('focusin', this.trackFocusHandback, true);
    document.removeEventListener('scroll', this.refreshRecordedScroll, true);

    this.pendingFocusHandback = null;

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

  /**
   * Takes focus when the handle is pressed, which the browser otherwise will not
   * do here.
   *
   * The grid starts a drag on `mousedown` and `touchstart` and calls
   * `preventDefault` on both, and that is what suppresses the focus a press
   * normally confers. The consequence is worse than untidy: this handle advertises
   * eight arrow-key shortcuts, and after a press focus is still on the document
   * body, so the next arrow key does nothing at all - a viewer who nudges a module
   * with the pointer and then reaches for the keyboard to line it up finds the
   * keyboard inert with nothing to explain why.
   *
   * `pointerdown` fires before both of the events the grid listens on, so focus is
   * already here by the time either `preventDefault` runs - and `preventDefault`
   * suppresses a focus that has not happened yet, it does not undo one that has.
   * Nothing about the drag changes.
   *
   * The handle does end up drawing its focus ring after a press, and that is left
   * as it is rather than suppressed. Chrome treats a scripted `focus()` as
   * warranting a visible indicator, and it is the right answer here: this control
   * has just become the target of eight arrow-key shortcuts, and a viewer who
   * nudges a module with the pointer and then reaches for the keyboard is exactly
   * the person who needs to see which module the keys will act on. Measured in a
   * browser rather than assumed - `:focus-visible` matches, and the ring paints.
   */
  public onDragHandlePointerDown() {
    this.focusDragHandle();
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
   * Reloads the document, which is the only thing that clears a recorded module
   * map failure.
   *
   * Offered from inside the failed module rather than left for the viewer to
   * discover, and only after a retry has failed, so it is never the first thing
   * asked of them. Nothing is lost by it: the arrangement is held on the server and
   * was written when it changed, so the canvas comes back as it was, with the
   * module resolved.
   */
  public onReloadDocument() {
    window.location.reload();
  }

  /**
   * Asks for the module again after a failure.
   *
   * Distinct from {@link reload}, which the canvas calls on every module when the
   * viewer refreshes the whole arrangement: this is the viewer acting on one failed
   * module, and it is counted, because whether a retry has already been spent is
   * what decides which recovery the module offers next.
   */
  public onRetryLoad() {
    this.reload();
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

  /**
   * Keeps the canvas where the viewer left it when something opened from inside
   * this module hands focus back.
   *
   * Two flows produce the same defect. A dialog opened from within the module
   * restores focus to the scrolling body, which is focusable because a scrolling
   * region that cannot be focused cannot be scrolled from the keyboard. A menu -
   * the module's own actions menu, or one belonging to a table inside it - restores
   * focus to its trigger. In both cases a module is routinely taller than the
   * grid's viewport, so the element focus returns to is often not fully in view,
   * and restoring focus to an element that is not fully in view makes the browser
   * scroll it in. What moves is the GRID, not the module: the viewer opened
   * something, dismissed it, and came back to a different part of their dashboard
   * hundreds of pixels from where they were, having scrolled nothing themselves.
   *
   * `preventScroll` is not available as a remedy. The `focus()` call belongs to
   * whatever is handing focus back - Material's dialog or its menu trigger -
   * neither of which takes focus options on restore, and the dialogs in question
   * are opened by the feature components mounted inside modules rather than by
   * anything here. So the offsets are recorded as focus leaves, kept current
   * while the overlay is up, and put back when focus comes home.
   *
   * Only a return FROM AN OVERLAY is corrected. A viewer who tabs into this module
   * or clicks into it is asking to be taken there, and the browser scrolling it
   * into view is the right answer; undoing that would leave the thing they just
   * focused off screen. The discriminator is where focus sat in the meantime, not
   * the origin label the CDK reports: Material stamps its restore with the
   * interaction that DISMISSED the overlay, so Escape on a dialog arrives as
   * `keyboard` and a menu opened by click arrives as `mouse`. Neither is ever
   * `program`, so an origin test would decline exactly the two cases that need
   * correcting.
   *
   * Focus is watched on the document rather than on this host, because half of
   * what has to be seen happens outside it - the overlay taking focus. The host's
   * own `focusout` is what opens the window, since it is the only place the element
   * losing focus, and therefore the ancestors to record, is available.
   */
  private monitorModuleFocus() {
    const host = this.elementRef.nativeElement;

    // Feature-detected against the DOM shim used in tests, where there is no
    // layout, nothing scrolls, and this correction has nothing to correct.
    if (typeof host.contains !== 'function') {
      return;
    }

    // Registered outside Angular: focus crossing this boundary says nothing about
    // what is rendered, and a change-detection pass per focus move would be paid on
    // every Tab through a module's content. The document listeners are in the
    // capture phase - `focusin` so this sees the overlay take focus before anything
    // else acts on it, and `scroll` because scroll events do not bubble at all, so
    // capture is the only phase in which a document listener sees the grid move.
    this.zone.runOutsideAngular(() => {
      host.addEventListener('focusout', this.recordScrollOnFocusOut);

      document.addEventListener('focusin', this.trackFocusHandback, true);
      document.addEventListener('scroll', this.refreshRecordedScroll, {
        capture: true,
        passive: true
      });
    });
  }

  /**
   * Decides, for every focus arrival anywhere in the document, whether this
   * module is owed its scroll position back.
   *
   * Focus landing inside this module closes the window: it is corrected if an
   * overlay held focus in between, and left alone otherwise. Focus landing inside
   * an overlay marks the window as one that will be handed back. Focus landing
   * anywhere else abandons the window, because nothing is coming back and a record
   * kept past that point would correct a later, deliberate arrival with offsets the
   * viewer has long since moved past.
   */
  private trackFocusHandback = (aEvent: FocusEvent) => {
    if (!this.pendingFocusHandback) {
      return;
    }

    const host = this.elementRef.nativeElement;
    const target = aEvent.target as Element;

    if (!target) {
      return;
    }

    if (host.contains(target)) {
      if (this.pendingFocusHandback.isOverlayHoldingFocus) {
        this.restoreAncestorScroll();
      }

      this.pendingFocusHandback = null;

      return;
    }

    if (target.closest?.(OVERLAY_CONTAINER_SELECTOR)) {
      this.pendingFocusHandback.isOverlayHoldingFocus = true;

      return;
    }

    this.pendingFocusHandback = null;
  };

  /**
   * Keeps the recorded offsets current for as long as focus is away.
   *
   * Without this the correction would restore where the canvas stood when the
   * overlay OPENED, which is wrong the moment a viewer scrolls while it is up -
   * a perfectly ordinary thing to do with a menu or a non-modal panel open, and
   * it would be answered by throwing the canvas back to a position the viewer
   * had already left.
   *
   * Safe to run from a scroll handler: it reads two numbers per recorded
   * ancestor and only while a hand-back is actually pending, which is a narrow
   * window, and it never touches change detection.
   */
  private refreshRecordedScroll = () => {
    if (!this.pendingFocusHandback) {
      return;
    }

    for (const record of this.pendingFocusHandback.ancestors) {
      if (!record.element.isConnected) {
        continue;
      }

      record.scrollLeft = record.element.scrollLeft;
      record.scrollTop = record.element.scrollTop;
    }
  };

  /**
   * Records where every scrollable ancestor stood as focus left the module.
   *
   * A bound property rather than a method so the same reference can be removed at
   * teardown, matching the scroll listener beside it.
   *
   * `relatedTarget` is the element about to receive focus, and a move that stays
   * inside this module is not a departure - Tab between two of its own controls
   * must not arm a correction. A null `relatedTarget` IS treated as a departure,
   * because that is what a dialog opening looks like: focus leaves before the
   * dialog's own focus trap has claimed it.
   */
  private recordScrollOnFocusOut = (aEvent: FocusEvent) => {
    const host = this.elementRef.nativeElement;
    const nextFocus = aEvent.relatedTarget as Node;

    if (nextFocus && host.contains(nextFocus)) {
      return;
    }

    this.pendingFocusHandback = {
      ancestors: this.readAncestorScroll(aEvent.target as HTMLElement),
      isOverlayHoldingFocus: false
    };
  };

  // Every scrollable ancestor of the element losing focus, not just the grid's
  // scroller: the module's own body scrolls too, and a control deep inside it can
  // need both boxes moved to be brought into view. Walked from the element rather
  // than from the host so the body is included, and recording all of them costs one
  // pass up a shallow tree and removes the guesswork about which one moved.
  private readAncestorScroll(aElement: HTMLElement) {
    const recorded: {
      element: Element;
      scrollLeft: number;
      scrollTop: number;
    }[] = [];

    let ancestor: Element = aElement?.parentElement;

    while (ancestor) {
      if (
        ancestor.scrollHeight > ancestor.clientHeight ||
        ancestor.scrollWidth > ancestor.clientWidth
      ) {
        recorded.push({
          element: ancestor,
          scrollLeft: ancestor.scrollLeft,
          scrollTop: ancestor.scrollTop
        });
      }

      ancestor = ancestor.parentElement;
    }

    return recorded;
  }

  // Written back synchronously, in the same task as the focus event, so the
  // browser's own scroll-into-view is already applied and this is the last word on
  // the offsets rather than a value the browser then overwrites.
  private restoreAncestorScroll() {
    for (const { element, scrollLeft, scrollTop } of this.pendingFocusHandback
      .ancestors) {
      // Guarded on being connected: a module can be removed while something it
      // opened is still up, and writing to a detached element would be silent but
      // pointless work.
      if (!element.isConnected) {
        continue;
      }

      if (element.scrollTop !== scrollTop) {
        element.scrollTop = scrollTop;
      }

      if (element.scrollLeft !== scrollLeft) {
        element.scrollLeft = scrollLeft;
      }
    }
  }

  // Compared before anything is written, so a scroll that does not cross an
  // edge costs no change detection at all - which is what makes it safe to run
  // this from a per-frame scroll handler.
  private applyOverflowState() {
    const element = this.moduleContent?.nativeElement;

    if (!element) {
      return;
    }

    const hasOverflowAbove = element.scrollTop > OVERFLOW_HINT_THRESHOLD;
    const hasOverflowBelow =
      element.scrollHeight - element.clientHeight - element.scrollTop >
      OVERFLOW_HINT_THRESHOLD;

    const scrolledFromStart = Math.abs(element.scrollLeft);
    const hasOverflowStart = scrolledFromStart > OVERFLOW_HINT_THRESHOLD;
    const hasOverflowEnd =
      element.scrollWidth - element.clientWidth - scrolledFromStart >
      OVERFLOW_HINT_THRESHOLD;

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
      this.recordLoadFailure();
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
        this.loadFailureCount = 0;
      } else {
        this.recordLoadFailure();
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

      this.recordLoadFailure();
    }

    this.changeDetectorRef.markForCheck();
  }

  // Counted rather than merely flagged, because the count is what the escalation
  // reads: one failure is retryable in place, a second one proves it is not. Kept
  // in one place so the three failure paths cannot disagree about it.
  private recordLoadFailure() {
    this.hasLoadError = true;
    this.loadFailureCount += 1;
  }
}
