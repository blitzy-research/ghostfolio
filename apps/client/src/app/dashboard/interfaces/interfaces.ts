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

/**
 * A keyboard-issued request to change one module's geometry, expressed as a
 * step rather than a destination.
 *
 * Steps, not coordinates, because the requester is the module chrome and the
 * chrome holds no geometry - grid state is the single authority for where a
 * module is and how big it is - so the chrome can say "one column left" but
 * must never say "column 4". The canvas resolves the step against the
 * authoritative state and lets the grid engine accept or reject the result.
 */
export interface DashboardModuleGeometryStep {
  deltaCols: number;
  deltaRows: number;
}

export interface DashboardModuleRegistration {
  loadComponent: () => Promise<Type<unknown>>;
  moduleType: DashboardModuleType;
}
