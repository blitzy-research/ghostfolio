import { EntityLogoImageSourceService } from '@ghostfolio/ui/entity-logo/entity-logo-image-source.service';

import { CommonModule } from '@angular/common';
import {
  CUSTOM_ELEMENTS_SCHEMA,
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  Input,
  OnChanges,
  OnDestroy
} from '@angular/core';
import { DataSource } from '@prisma/client';

/**
 * What this session has found out about each logo address, or is finding out.
 *
 * `resolved` false means one instance is currently probing that address and the
 * answer is not in yet; `resolved` true means it is, and `available` says whether
 * there was a logo there.
 *
 * Module-scoped rather than per-instance, because the waste being prevented is
 * caused by *separate* instances asking for the same address and an instance
 * field could not see it. On a canvas holding both Holdings and Activities, the
 * two tables render one logo per row for the same twelve asset profiles: measured
 * 24 requests, 24 404s and 24 console errors on every load, and, since each
 * re-render repeated it, 115 to 228 over a session.
 *
 * The server answers 404 whenever an asset profile carries no `url`. The client
 * cannot know that in advance, so one instance has to find out - but only one,
 * and only once, which is what the pending state is for. Sharing only the settled
 * answer is not enough on a cold load: the two tables mount a few hundred
 * milliseconds apart, but an `<img>` `error` event arrives later still than its
 * 404 did, because the main thread is busy with the payload and chart
 * construction in between. The second table therefore issues its twelve requests
 * BEFORE the first error event fires, so an answer-only register is still empty at
 * the moment it is needed.
 *
 * Not keyed by user, because whether a logo exists is a property of the asset
 * profile rather than of the viewer, and discarded with the page, so editing a
 * profile to add a `url` and reloading picks the logo up. Bounded by the number of
 * distinct asset profiles a session displays.
 *
 * Kept here rather than on `EntityLogoImageSourceService` for two reasons. That
 * service composes addresses and never learns whether one resolves, so this is
 * not its knowledge to hold; and it is replaced in Storybook through a `useValue`
 * duck-type that TypeScript does not structurally check, so a method added to it
 * compiles cleanly and then fails at runtime inside `ui:build-storybook`, which
 * `build:production` runs.
 */
const logoAttempts = new Map<
  string,
  { available: boolean; resolved: boolean }
>();

/**
 * The instances currently waiting on somebody else's probe.
 *
 * One flat set rather than a waiter list per address: waking every waiting
 * instance on every settled address costs a handful of comparisons - each one
 * only re-reads its own address - and removes the bookkeeping that a per-address
 * list would need to keep correct while instances come and go.
 */
const pendingObservers = new Set<() => void>();

function notifyPendingObservers() {
  // Iterated over a copy: an observer that re-evaluates may join or leave the set
  // while this is running, and one of them joining is the normal case.
  for (const observe of [...pendingObservers]) {
    observe();
  }
}

/**
 * Publishes the answer for an address, once, to everyone waiting on it.
 */
function settleLogoAttempt(source: string, available: boolean) {
  const attempt = logoAttempts.get(source);

  if (!attempt || attempt.resolved) {
    return;
  }

  attempt.available = available;
  attempt.resolved = true;

  notifyPendingObservers();
}

/**
 * Gives an address back when the instance probing it goes away before answering.
 *
 * Without this, a module removed mid-flight would leave an address permanently
 * pending and every later instance waiting on an answer that can no longer come -
 * which is a worse failure than the duplicate request this avoids, because it is
 * silent and does not resolve itself.
 */
function releaseLogoAttempt(source: string) {
  const attempt = logoAttempts.get(source);

  if (!attempt || attempt.resolved) {
    return;
  }

  logoAttempts.delete(source);

  notifyPendingObservers();
}

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule],
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
  selector: 'gf-entity-logo',
  styleUrls: ['./entity-logo.component.scss'],
  templateUrl: './entity-logo.component.html'
})
export class GfEntityLogoComponent implements OnChanges, OnDestroy {
  @Input() dataSource: DataSource;
  @Input() size: 'large';
  @Input() symbol: string;
  @Input() tooltip: string;
  @Input() url: string;

  /**
   * The address being rendered, wrapped and held in a list so the template can
   * track it by key.
   *
   * A list of at most one, which is what makes the `<img>` element's identity
   * follow the address it is loading. Shown with `@if` instead, one element is
   * reused across a change of address - and a reused element is exactly what let
   * a `load` or `error` the browser had already queued for the PREVIOUS address
   * arrive after the swap and be taken for an answer about the new one. Tracked by
   * `source`, the old element is destroyed with its listeners and a new one takes
   * its place, so each handler is told which address it is answering for by its
   * own view rather than by state that has since moved on.
   *
   * Tracked by the `source` key rather than by the wrapper's identity, and that
   * distinction is load-bearing twice over: the wrapper is a new object whenever
   * the address changes, so its identity is not a stable key to begin with; and
   * `track` on the bare item is the one form Angular treats as a mis-tracking
   * smell, warning NG0956 every time a keyed view is legitimately re-created.
   * Written back to identity tracking, this would put a console warning on every
   * sorted or paged table row - the very noise this component exists to remove.
   */
  public probes: { source: string }[] = [];

  // Nullable by declaration, because "no logo to show" is a state this component
  // has to be able to express: an address whose probe came back unavailable, and
  // an address another instance is still probing, both render nothing at all.
  // Read by consumers and by tests; written only through `show`, which keeps
  // `probes` in step with it.
  public src: string | undefined;

  private isObserving = false;

  // The address this instance is itself probing, if any. Distinguishes the one
  // instance that must report an outcome from the ones merely waiting for it.
  private probedSource: string | null = null;

  public constructor(
    private readonly changeDetectorRef: ChangeDetectorRef,
    private readonly imageSourceService: EntityLogoImageSourceService
  ) {}

  public ngOnChanges() {
    this.evaluate();
  }

  public ngOnDestroy() {
    this.stopObserving();

    this.releaseProbe();
  }

  /**
   * @param aSource the address this image element was created for, handed over by
   * the template's own view context rather than read back from the element - which
   * would report whatever `src` has become by the time the event is dispatched.
   */
  public onImageError(aSource: string) {
    this.settle(aSource, false);
  }

  /** Companion of {@link onImageError}; see it for why the source is a parameter. */
  public onImageLoad(aSource: string) {
    this.settle(aSource, true);
  }

  /**
   * Decides what this instance should show, and whether it is the one asking.
   *
   * Re-entered both when inputs change and when any address settles, so it has to
   * be idempotent for a given state - hence the early return for the instance
   * that is already probing this very address, which must not reset its own
   * `src` and start again.
   */
  private evaluate() {
    const source = this.resolveSource();

    if (!source) {
      // Nothing identifies a logo any more, so anything still rendered describes
      // inputs that have since been cleared. Note this branch is reached only when
      // the asset profile identifier AND the explicit url are all absent - not
      // merely when some unrelated input like `size` or `tooltip` changed - so a
      // rendered address here is stale by definition rather than possibly still
      // correct.
      this.releaseProbe();
      this.stopObserving();

      if (this.src !== undefined) {
        this.show(undefined);

        this.changeDetectorRef.markForCheck();
      }

      return;
    }

    if (this.probedSource === source) {
      return;
    }

    // Handed back before it is forgotten. This instance is about to stop being the
    // one probing its previous address, and an unresolved attempt left in the
    // register is worse than the duplicate request the register exists to prevent:
    // every later instance that wants that address waits on an answer which can no
    // longer come, silently and without resolving itself.
    this.releaseProbe();

    const attempt = logoAttempts.get(source);

    if (attempt?.resolved) {
      this.stopObserving();

      this.show(attempt.available ? source : undefined);

      this.changeDetectorRef.markForCheck();

      return;
    }

    if (attempt) {
      // Another instance is already finding out. Waiting costs this row's logo a
      // frame in the case where there IS one, and saves a request in the case
      // where there is not.
      this.startObserving();

      this.show(undefined);

      this.changeDetectorRef.markForCheck();

      return;
    }

    // Nobody has asked yet, so this instance asks - once, on everyone's behalf.
    this.stopObserving();

    logoAttempts.set(source, { available: false, resolved: false });

    this.probedSource = source;

    this.show(source);

    this.changeDetectorRef.markForCheck();
  }

  private resolveSource() {
    if (this.dataSource && this.symbol) {
      return this.imageSourceService.getLogoUrlByAssetProfileIdentifier({
        dataSource: this.dataSource,
        symbol: this.symbol
      });
    }

    if (this.url) {
      return this.imageSourceService.getLogoUrlByUrl(this.url);
    }

    return undefined;
  }

  /**
   * Reports the outcome of this instance's own probe.
   *
   * Replaces an inline `onerror` attribute that hid the element in place. Three
   * things change, all deliberately. The outcome is published, which is the
   * point. A failure removes the image from the document rather than leaving it
   * hidden, so nothing remains for assistive technology to reach. And a success
   * is reported too, so a row waiting on this probe can show the logo instead of
   * waiting forever.
   */
  private settle(aSource: string, available: boolean) {
    // Two conditions, and the second is the one that matters. An event only ever
    // answers the address its own element was loading, so an event whose source is
    // not the one this instance is currently probing belongs to a superseded render
    // - and publishing it would answer the CURRENT address with the previous
    // address's outcome, which for a 404 means hiding a logo that exists and
    // poisoning the register for the rest of the session.
    if (!this.probedSource || aSource !== this.probedSource) {
      return;
    }

    this.probedSource = null;

    settleLogoAttempt(aSource, available);

    if (!available) {
      this.show(undefined);

      this.changeDetectorRef.markForCheck();
    }
  }

  /**
   * The one writer of what is rendered.
   *
   * `src` and `probes` describe the same single fact and are only correct while
   * they agree, so they are never assigned apart. A fresh wrapper is built only
   * when the address actually changes, which keeps the tracked key stable - and
   * therefore the element, and its pending request, untouched - when something
   * that does not identify a logo, such as the tooltip, changes instead.
   */
  private show(source: string | undefined) {
    if (this.src === source) {
      return;
    }

    this.src = source;
    this.probes = source ? [{ source }] : [];
  }

  /**
   * Hands this instance's unresolved probe back to the register, if it holds one.
   *
   * Called wherever `probedSource` stops describing what is rendered - a change of
   * inputs, inputs cleared, or destruction - so that an address is never left
   * pending with nobody probing it.
   */
  private releaseProbe() {
    if (!this.probedSource) {
      return;
    }

    releaseLogoAttempt(this.probedSource);

    this.probedSource = null;
  }

  /**
   * The callback this instance registers with the shared probe registry.
   *
   * Held as one bound property rather than created per call, because it is handed
   * to `add` and later to `delete`: a fresh closure each time would register a
   * listener that could never be removed, and the registry would keep this
   * component alive after it was destroyed.
   *
   * Declared among the private methods rather than beside the fields above, because
   * an arrow-function property is a method as far as the lint configuration is
   * concerned - sitting before the constructor it pushed the constructor and all
   * four public methods out of order. Position is safe: a field initializer runs at
   * construction wherever it appears among the methods, so the property is bound
   * long before `startObserving` can read it.
   */
  private readonly observeAttempts = () => {
    this.evaluate();
  };

  private startObserving() {
    if (this.isObserving) {
      return;
    }

    pendingObservers.add(this.observeAttempts);

    this.isObserving = true;
  }

  private stopObserving() {
    if (!this.isObserving) {
      return;
    }

    pendingObservers.delete(this.observeAttempts);

    this.isObserving = false;
  }
}
