import { GfUserAccountMembershipComponent } from '@ghostfolio/client/components/user-account-membership/user-account-membership.component';

import { ChangeDetectionStrategy, Component } from '@angular/core';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [GfUserAccountMembershipComponent],
  selector: 'gf-account-membership-module',
  templateUrl: './account-membership.module.html'
})
export class GfAccountMembershipModuleComponent {}
