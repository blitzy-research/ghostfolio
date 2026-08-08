import { publicRoutes } from '@ghostfolio/common/routes/routes';

import {
  CUSTOM_ELEMENTS_SCHEMA,
  ChangeDetectionStrategy,
  Component,
  Input
} from '@angular/core';
import { IonIcon } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { diamondOutline } from 'ionicons/icons';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  // `CommonModule` is deliberately absent: the badge chooses between an anchor
  // and a decorative span with built-in control flow, so it needs no `ngStyle` to
  // disable the anchor by taking its pointer events away.
  imports: [IonIcon],
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
  selector: 'gf-premium-indicator',
  styleUrls: ['./premium-indicator.component.scss'],
  templateUrl: './premium-indicator.component.html'
})
export class GfPremiumIndicatorComponent {
  @Input() enableLink = true;

  public pricingUrl = `https://ghostfol.io/${document.documentElement.lang}/${publicRoutes.pricing.path}`;

  public constructor() {
    addIcons({ diamondOutline });
  }
}
