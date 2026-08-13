import { GfAdminSettingsComponent } from '@ghostfolio/client/components/admin-settings/admin-settings.component';

import { ChangeDetectionStrategy, Component } from '@angular/core';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [GfAdminSettingsComponent],
  selector: 'gf-admin-settings-module',
  styleUrls: ['./admin-settings.module.scss'],
  templateUrl: './admin-settings.module.html'
})
export class GfAdminSettingsModuleComponent {}
