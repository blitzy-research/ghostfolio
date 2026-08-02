import type { DashboardModule } from '@ghostfolio/common/dashboard';

import type { Type } from '@angular/core';
import type { GridsterItemConfig } from 'angular-gridster2';

import type { DashboardModuleType } from '../enums/dashboard-module-type';

export interface DashboardLayoutItem extends GridsterItemConfig {
  moduleType: DashboardModuleType;
}

export interface DashboardModuleDefinition extends DashboardModule {
  loadComponent: () => Promise<Type<unknown>>;
}

export interface DashboardModuleRegistration {
  loadComponent: () => Promise<Type<unknown>>;
  moduleType: DashboardModuleType;
}
