import type { Params } from '@angular/router';
import type { DataSource } from '@prisma/client';

export interface GfAppQueryParams extends Params {
  accessId?: string;
  dataSource?: DataSource;
  holdingDetailDialog?: string;
  jwt?: string;
  symbol?: string;
}
