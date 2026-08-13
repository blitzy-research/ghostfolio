import { GfUserAccountSettingsComponent } from '@ghostfolio/client/components/user-account-settings/user-account-settings.component';

import { ChangeDetectionStrategy, Component } from '@angular/core';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [GfUserAccountSettingsComponent],
  selector: 'gf-account-settings-module',
  templateUrl: './account-settings.module.html'
})
export class GfAccountSettingsModuleComponent {}
