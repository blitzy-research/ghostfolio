import { DashboardModuleLayoutItem } from './dashboard-module-layout-item.interface';

export interface UserDashboardLayout {
  modules: DashboardModuleLayoutItem[];
  version?: number;
}
