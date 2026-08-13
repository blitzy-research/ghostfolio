import { ConfigurationService } from '@ghostfolio/api/services/configuration/configuration.service';
import { SUPPORTED_LANGUAGE_CODES } from '@ghostfolio/common/config';

import { Injectable } from '@nestjs/common';

@Injectable()
export class SitemapService {
  public constructor(
    private readonly configurationService: ConfigurationService
  ) {}

  public getPublicRoutes({ currentDate }: { currentDate: string }): string {
    const rootUrl = this.configurationService.get('ROOT_URL');

    return SUPPORTED_LANGUAGE_CODES.map((languageCode) =>
      this.createLocaleRootSitemapUrl({ currentDate, languageCode, rootUrl })
    ).join('\n');
  }

  private createLocaleRootSitemapUrl({
    currentDate,
    languageCode,
    rootUrl
  }: {
    currentDate: string;
    languageCode: string;
    rootUrl: string;
  }): string {
    const location = [rootUrl, languageCode].join('/');

    return [
      '  <url>',
      `    <loc>${location}</loc>`,
      `    <lastmod>${currentDate}T00:00:00+00:00</lastmod>`,
      '  </url>'
    ].join('\n');
  }
}
