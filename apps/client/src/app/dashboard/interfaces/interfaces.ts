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
 * One module's footprint and origin, as four cell counts.
 *
 * A description of a geometry rather than a place to keep one: grid state remains
 * the single authority for where a module sits and how big it is, and nothing holds
 * a value of this shape for longer than the statement that reads it. It exists so
 * that the canvas can talk ABOUT a geometry - the one that was asked for, the one a
 * module was last seen holding - without either of those being mistaken for the
 * arrangement itself, and so that the four names are spelled once.
 */
export interface DashboardModuleGeometry {
  cols: number;
  rows: number;
  x: number;
  y: number;
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
