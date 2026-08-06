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
 * answer is not enough on a cold load, and that is measured rather than assumed:
 * the two tables mount roughly 300ms apart, but an `<img>` `error` event arrives
 * 220-320ms after its 404 actually landed, because the main thread is busy with a
 * 177kB payload and chart construction in between. The second table therefore
 * issued its twelve requests 7-50ms BEFORE the first error event fired, so an
 * answer-only register was still empty at the moment it was needed.
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

  // Nullable by declaration, because "no logo to show" is a state this component
  // has to be able to express: an address whose probe came back unavailable, and
  // an address another instance is still probing, both render nothing at all.
  public src: string | undefined;

  private isObserving = false;

  // The address this instance is itself probing, if any. Distinguishes the one
  // instance that must report an outcome from the ones merely waiting for it.
  private probedSource: string | null = null;

  private readonly observeAttempts = () => {
    this.evaluate();
  };

  public constructor(
    private readonly changeDetectorRef: ChangeDetectorRef,
    private readonly imageSourceService: EntityLogoImageSourceService
  ) {}

  public ngOnChanges() {
    this.evaluate();
  }

  public ngOnDestroy() {
    this.stopObserving();

    if (this.probedSource) {
      releaseLogoAttempt(this.probedSource);

      this.probedSource = null;
    }
  }

  public onImageError() {
    this.settle(false);
  }

  public onImageLoad() {
    this.settle(true);
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
      // Left exactly as before: with nothing to resolve, `src` is not written at
      // all. `ngOnChanges` fires for every input, including `size` and `tooltip`
      // on their own, so assigning here would clear a logo that is still correct.
      return;
    }

    if (this.probedSource === source) {
      return;
    }

    const attempt = logoAttempts.get(source);

    if (attempt?.resolved) {
      this.stopObserving();

      this.src = attempt.available ? source : undefined;

      this.changeDetectorRef.markForCheck();

      return;
    }

    if (attempt) {
      // Another instance is already finding out. Waiting costs this row's logo a
      // frame in the case where there IS one, and saves a request in the case
      // where there is not.
      this.startObserving();

      this.src = undefined;

      this.changeDetectorRef.markForCheck();

      return;
    }

    // Nobody has asked yet, so this instance asks - once, on everyone's behalf.
    this.stopObserving();

    logoAttempts.set(source, { available: false, resolved: false });

    this.probedSource = source;
    this.src = source;

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
  private settle(available: boolean) {
    if (!this.probedSource) {
      return;
    }

    const source = this.probedSource;

    this.probedSource = null;

    settleLogoAttempt(source, available);

    if (!available) {
      this.src = undefined;

      this.changeDetectorRef.markForCheck();
    }
  }

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
