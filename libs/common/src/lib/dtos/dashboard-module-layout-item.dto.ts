import { IsInt, IsString, Max, Min } from 'class-validator';

export class DashboardModuleLayoutItemDto {
  @IsInt()
  @Max(12)
  @Min(2)
  cols: number;

  @IsString()
  moduleType: string;

  @IsInt()
  @Min(2)
  rows: number;

  @IsInt()
  @Max(11)
  @Min(0)
  x: number;

  @IsInt()
  @Min(0)
  y: number;
}
