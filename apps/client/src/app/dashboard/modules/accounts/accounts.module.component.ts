import { GfAccountsComponent } from '@ghostfolio/client/components/accounts/accounts.component';

import { ChangeDetectionStrategy, Component } from '@angular/core';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [GfAccountsComponent],
  selector: 'gf-accounts-module',
  templateUrl: './accounts.module.html'
})
export class GfAccountsModuleComponent {}
