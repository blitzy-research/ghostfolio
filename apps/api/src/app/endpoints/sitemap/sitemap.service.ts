import { ConfigurationService } from '@ghostfolio/api/services/configuration/configuration.service';
import { SUPPORTED_LANGUAGE_CODES } from '@ghostfolio/common/config';

import { Injectable } from '@nestjs/common';

@Injectable()
export class SitemapService {
  public constructor(
    private readonly configurationService: ConfigurationService
  ) {}

  // The sitemap template interpolates this value unconditionally; return an
  // empty string so a missing section never renders as "undefined".
  public getBlogPosts({ currentDate }: { currentDate: string }): string {
    // Preserve the controller call signature while this section emits no URLs.
    void currentDate;

    return '';
  }

  // The sitemap template interpolates this value unconditionally; return an
  // empty string so a missing section never renders as "undefined".
  public getPersonalFinanceTools({
    currentDate
  }: {
    currentDate: string;
  }): string {
    // Preserve the controller call signature while this section emits no URLs.
    void currentDate;

    return '';
  }

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
