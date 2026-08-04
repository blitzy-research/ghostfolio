import { DashboardModuleType } from '@ghostfolio/common/dashboard';
import { GfSymbolPipe } from '@ghostfolio/common/pipes';

import { FocusableOption } from '@angular/cdk/a11y';
import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  ElementRef,
  HostBinding,
  Input,
  OnChanges,
  ViewChild,
  inject,
  output
} from '@angular/core';
import { Params, Router, RouterModule } from '@angular/router';

import { SearchMode } from '../enums/search-mode';
import {
  AssetSearchResultItem,
  type SearchResultItem
} from '../interfaces/interfaces';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [GfSymbolPipe, RouterModule],
  selector: 'gf-assistant-list-item',
  styleUrls: ['./assistant-list-item.scss'],
  templateUrl: './assistant-list-item.html'
})
export class GfAssistantListItemComponent
  implements FocusableOption, OnChanges
{
  @HostBinding('attr.tabindex') tabindex = -1;

  @Input() item: SearchResultItem;

  @ViewChild('link') public linkElement: ElementRef<HTMLAnchorElement>;

  public hasFocus = false;

  /**
   * Whether the row applies its query parameters through the router link the
   * template binds.
   *
   * False for an asset profile, which applies them from {@link onClick} instead
   * so that they land after the module that reads them has been asked for, and
   * false for a quick link, which has no parameters to apply at all. Expressed
   * as a flag rather than as a mode comparison in the template so that the
   * template carries no mode literals and the rule lives in one place.
   */
  public hasRouterLink = false;

  public queryParams: Params;
  public routerLink: string[];

  protected readonly clicked = output<void>();

  /**
   * Names the dashboard module the activated result stands for. Emitted for the
   * result kinds that carry a module discriminator, so the consumer can surface
   * that module without this library knowing how modules are hosted. This
   * output is the only channel through which an app-directed intent leaves the
   * component; the shared module vocabulary keeps it framework- and
   * application-agnostic.
   */
  protected readonly moduleSelected = output<DashboardModuleType>();

  private readonly changeDetectorRef = inject(ChangeDetectorRef);
  private readonly router = inject(Router);

  @HostBinding('class.has-focus')
  public get getHasFocus() {
    return this.hasFocus;
  }

  public ngOnChanges() {
    this.hasRouterLink = false;

    if (this.item?.mode === SearchMode.ACCOUNT) {
      this.queryParams = {
        accountDetailDialog: true,
        accountId: this.item.id,
        // More than one module knows how to open this dialog, so the result
        // names the one it stands for. The discriminator travels on the result
        // itself, which keeps this library free of any knowledge of how the
        // application composes its modules while still leaving exactly one of
        // them to react.
        dialogModule: this.item.moduleType
      };

      // The dialog is addressed by query parameter rather than by screen, so
      // the empty command array keeps the activation on the current URL instead
      // of navigating to a screen that no longer exists.
      this.routerLink = [];
      this.hasRouterLink = true;
    } else if (this.item?.mode === SearchMode.ASSET_PROFILE) {
      this.queryParams = {
        assetProfileDialog: true,
        dataSource: this.item.dataSource,
        symbol: this.item.symbol
      };

      // Same route-free dialog form as the account branch above, but applied by
      // `onClick` rather than by a router link, because these parameters have
      // to land after the module that reads them has been asked for.
    } else if (this.item?.mode === SearchMode.HOLDING) {
      this.queryParams = {
        dataSource: this.item.dataSource,
        holdingDetailDialog: true,
        symbol: this.item.symbol
      };

      // Kept on the router link: the holding detail dialog is opened by the
      // application shell, which is mounted for the whole session, so these
      // parameters always have a reader and need no module surfaced first.
      this.routerLink = [];
      this.hasRouterLink = true;
    } else if (this.item?.mode === SearchMode.QUICK_LINK) {
      // A quick link is the one genuinely navigational mode, and the URL no
      // longer selects a screen. It therefore derives no router link at all:
      // revealing the module the item names is the consumer's responsibility
      // and travels through the `moduleSelected` output instead.
      this.queryParams = {};
    }
  }

  public focus() {
    this.hasFocus = true;

    this.changeDetectorRef.markForCheck();
  }

  public isAsset(item: SearchResultItem): item is AssetSearchResultItem {
    return (
      (item.mode === SearchMode.ASSET_PROFILE ||
        item.mode === SearchMode.HOLDING) &&
      !!item.dataSource &&
      !!item.symbol
    );
  }

  public onClick() {
    // Every result kind that names a module asks for it here. Holding results
    // are the one kind that names none, because the dialog they open belongs to
    // the shell rather than to a module; the property check narrows the union
    // and lets them fall through. The intent is emitted before the click so that
    // a consumer which closes the assistant on click can never observe a close
    // ahead of the selection it belongs to.
    if (this.item && 'moduleType' in this.item) {
      this.moduleSelected.emit(this.item.moduleType);
    }

    // Applied here, and only after the intent above, because the asset profile
    // dialog is opened by the market data administration module: asking for the
    // module first means the parameters arrive at a canvas that already hosts
    // their reader, instead of at one where nothing is listening yet. Every
    // other kind either has a shell-owned reader or no parameters at all, and
    // keeps applying them through the template's router link.
    if (this.item?.mode === SearchMode.ASSET_PROFILE) {
      void this.router.navigate([], { queryParams: this.queryParams });
    }

    this.clicked.emit();
  }

  public removeFocus() {
    this.hasFocus = false;

    this.changeDetectorRef.markForCheck();
  }
}
