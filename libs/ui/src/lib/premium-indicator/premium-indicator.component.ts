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
  // `CommonModule` is deliberately absent: the badge now chooses between an
  // anchor and a decorative span with built-in control flow, so the structural
  // directive it used to be imported for - `ngStyle`, which was what disabled
  // the anchor by taking its pointer events away - is gone with it.
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
