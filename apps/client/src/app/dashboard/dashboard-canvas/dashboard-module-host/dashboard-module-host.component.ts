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

import type { DashboardModuleDefinition } from '../../interfaces/interfaces';

/**
 * Chrome for one module placed on the dashboard: the card, its header and the
 * region the module itself is mounted into.
 *
 * No module class is imported here. It arrives as a lazy thunk on the definition
 * handed in by the canvas, is awaited at runtime and is instantiated by
 * `NgComponentOutlet`. Every registered module therefore receives identical
 * chrome, none can be special-cased, and a module never learns that it is drawn
 * inside a grid cell. That inversion is also what keeps code splitting intact
 * now that the lazy route boundaries are gone: a module's code is fetched when,
 * and only when, that module is placed.
 *
 * What this component deliberately cannot do. It holds no placement state, so it
 * neither reads nor writes where a module sits or how large it is - the grid owns
 * both, and the grid's own item validation enforces the declared floor. It
 * reaches no persistence API: removal emits an output and stops there, leaving
 * the canvas as the only origin of a saved change. It resolves no metadata of its
 * own beyond the two members it renders, so visibility filtering stays in the
 * layers that already perform it. And it navigates nowhere, because the URL no
 * longer selects a screen.
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
  /**
   * Metadata for the module this host draws. Exactly two of its members are
   * consumed: `name`, which is already translated where the shared metadata
   * declares it and is therefore rendered verbatim, and `loadComponent`, the
   * lazy thunk that is the only way to obtain a module class.
   */
  @Input() definition: DashboardModuleDefinition;

  /**
   * Emitted once per removal request. The canvas owns the placement array and
   * the write that follows it, so nothing is discarded or stored from here.
   */
  @Output() remove = new EventEmitter<void>();

  /**
   * Set when the current definition could not be turned into a module class.
   * The template then renders a localized notice in place of the module: a
   * failure is contained in this one cell and leaves its siblings and the
   * surrounding canvas untouched.
   */
  public hasLoadError = false;

  /**
   * The resolved module class, left undefined while resolution is in flight so
   * that the template shows its loading placeholder.
   */
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
