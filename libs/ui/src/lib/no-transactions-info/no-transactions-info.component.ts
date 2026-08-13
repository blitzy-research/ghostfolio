import {
  CUSTOM_ELEMENTS_SCHEMA,
  ChangeDetectionStrategy,
  Component,
  EventEmitter,
  HostBinding,
  Input,
  Output
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';

import { GfLogoComponent } from '../logo';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [GfLogoComponent, MatButtonModule],
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
  selector: 'gf-no-transactions-info-indicator',
  styleUrls: ['./no-transactions-info.component.scss'],
  templateUrl: './no-transactions-info.component.html'
})
export class GfNoTransactionsInfoComponent {
  @HostBinding('class.has-border') @Input() hasBorder = true;

  @Output() createActivityClicked = new EventEmitter<void>();
}
