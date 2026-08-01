import { GfUserAccountAccessComponent } from '@ghostfolio/client/components/user-account-access/user-account-access.component';

import { ChangeDetectionStrategy, Component } from '@angular/core';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [GfUserAccountAccessComponent],
  selector: 'gf-account-access-module',
  templateUrl: './account-access.module.html'
})
export class GfAccountAccessModuleComponent {}
