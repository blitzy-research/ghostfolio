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
import { Params, RouterModule } from '@angular/router';

import { SearchMode } from '../enums/search-mode';
import {
  AssetSearchResultItem,
  SearchResultItem
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

  @HostBinding('class.has-focus')
  public get getHasFocus() {
    return this.hasFocus;
  }

  public ngOnChanges() {
    if (this.item?.mode === SearchMode.ACCOUNT) {
      this.queryParams = {
        accountDetailDialog: true,
        accountId: this.item.id
      };

      // The dialog is addressed by query parameter rather than by screen, so
      // the empty command array keeps the activation on the current URL instead
      // of navigating to a screen that no longer exists.
      this.routerLink = [];
    } else if (this.item?.mode === SearchMode.ASSET_PROFILE) {
      this.queryParams = {
        assetProfileDialog: true,
        dataSource: this.item.dataSource,
        symbol: this.item.symbol
      };

      // Same route-free dialog form as the account branch above: the asset
      // profile dialog is opened from wherever the assistant was invoked.
      this.routerLink = [];
    } else if (this.item?.mode === SearchMode.HOLDING) {
      this.queryParams = {
        dataSource: this.item.dataSource,
        holdingDetailDialog: true,
        symbol: this.item.symbol
      };

      this.routerLink = [];
    } else if (this.item?.mode === SearchMode.QUICK_LINK) {
      // A quick link is the one genuinely navigational mode, and the URL no
      // longer selects a screen. It therefore derives no router link at all:
      // revealing the module the item names is the consumer's responsibility
      // and travels through the `moduleSelected` output instead. The template
      // independently binds `null` for this mode, so leaving the field unset
      // cannot activate a stale route either.
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
    // `moduleType` is present on account and quick link results only, so the
    // property check narrows the result union and asset results fall through
    // without a module intent. The module intent is emitted before the click so
    // that a consumer which closes the assistant on click can never observe a
    // close ahead of the selection it belongs to.
    if (this.item && 'moduleType' in this.item) {
      this.moduleSelected.emit(this.item.moduleType);
    }

    this.clicked.emit();
  }

  public removeFocus() {
    this.hasFocus = false;

    this.changeDetectorRef.markForCheck();
  }
}
