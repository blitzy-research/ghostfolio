import { GfAdminUsersComponent } from '@ghostfolio/client/components/admin-users/admin-users.component';

import { ChangeDetectionStrategy, Component } from '@angular/core';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [GfAdminUsersComponent],
  selector: 'gf-admin-users-module',
  templateUrl: './admin-users.module.html'
})
export class GfAdminUsersModuleComponent {}
