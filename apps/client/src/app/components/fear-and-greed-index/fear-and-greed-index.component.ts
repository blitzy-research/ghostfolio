import { resolveFearAndGreedIndex } from '@ghostfolio/common/helper';
import { translate } from '@ghostfolio/ui/i18n';

import {
  ChangeDetectionStrategy,
  Component,
  Input,
  OnChanges
} from '@angular/core';
import { NgxSkeletonLoaderModule } from 'ngx-skeleton-loader';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgxSkeletonLoaderModule],
  selector: 'gf-fear-and-greed-index',
  styleUrls: ['./fear-and-greed-index.component.scss'],
  templateUrl: './fear-and-greed-index.component.html'
})
export class GfFearAndGreedIndexComponent implements OnChanges {
  @Input() fearAndGreedIndex: number;

  /**
   * Whether the figure is still being fetched.
   *
   * Required from every host, and the reason is that this component cannot answer
   * it. The absence of an index means one of two opposite things - not yet
   * arrived, or arrived and empty because the provider has none - and only the
   * host that issued the request knows which. Standing in for the answer with the
   * index itself is what left this tile pulsing a skeleton over a response that
   * had already come back empty.
   *
   * Defaults to `false`, so a host that forgets to bind it shows an honest empty
   * state rather than an indefinite loading one.
   */
  @Input() isLoading = false;

  public fearAndGreedIndexEmoji: string;
  public fearAndGreedIndexText: string;

  /**
   * Whether there is a figure to draw.
   *
   * A number, specifically: the index legitimately reaches zero at the extreme
   * fear end of its scale, so truthiness is the wrong test.
   */
  public get hasIndex(): boolean {
    return Number.isFinite(this.fearAndGreedIndex);
  }

  public ngOnChanges() {
    const { emoji, key } = resolveFearAndGreedIndex(this.fearAndGreedIndex);

    this.fearAndGreedIndexEmoji = emoji;
    this.fearAndGreedIndexText = translate(key);
  }
}
