import { ConfigurationService } from '@ghostfolio/api/services/configuration/configuration.service';
import { I18nService } from '@ghostfolio/api/services/i18n/i18n.service';
import { SUPPORTED_LANGUAGE_CODES } from '@ghostfolio/common/config';
import { PublicRoute } from '@ghostfolio/common/routes/interfaces/public-route.interface';

import { Injectable } from '@nestjs/common';

@Injectable()
export class SitemapService {
  private static readonly TRANSLATION_TAGGED_MESSAGE_REGEX =
    /:.*@@(?<id>[a-zA-Z0-9.]+):(?<message>.+)/;

  public constructor(
    private readonly configurationService: ConfigurationService,
    private readonly i18nService: I18nService
  ) {}

  // The public blog surface has been removed from the client, which now serves
  // a single root route per locale, so no blog post URLs are advertised any
  // more. The method is deliberately retained: apps/api/src/assets/sitemap.xml
  // interpolates this method's placeholder token unconditionally, and the
  // interpolation helper renders the literal text "undefined" for a missing
  // value, so an empty string must be returned rather than nothing at all.
  public getBlogPosts({ currentDate }: { currentDate: string }): string {
    // The argument is kept for call compatibility with the sitemap controller
    // and is intentionally unused now that no URLs are emitted.
    void currentDate;

    return '';
  }

  // The public personal finance tools resource pages have been removed from the
  // client along with the rest of the public route tree, so no product URLs are
  // advertised any more. The method is deliberately retained for the same
  // reason as getBlogPosts: this method's placeholder token is interpolated
  // unconditionally and must never resolve to `undefined`.
  public getPersonalFinanceTools({
    currentDate
  }: {
    currentDate: string;
  }): string {
    // The argument is kept for call compatibility with the sitemap controller
    // and is intentionally unused now that no URLs are emitted.
    void currentDate;

    return '';
  }

  // Every public marketing page has been removed from the client, which now
  // serves a single root route per locale. Only those per-locale roots are
  // advertised; the nested public route tree is no longer walked, so the
  // sitemap can never point at a URL that has ceased to exist.
  public getPublicRoutes({ currentDate }: { currentDate: string }): string {
    const rootUrl = this.configurationService.get('ROOT_URL');

    return SUPPORTED_LANGUAGE_CODES.flatMap((languageCode) => {
      const params = {
        currentDate,
        languageCode,
        rootUrl
      };

      return [this.createRouteSitemapUrl(params)];
    }).join('\n');
  }

  private createRouteSitemapUrl({
    currentDate,
    languageCode,
    rootUrl,
    route
  }: {
    currentDate: string;
    languageCode: string;
    rootUrl: string;
    route?: PublicRoute;
  }): string {
    const segments =
      route?.routerLink.map((link) => {
        const match = link.match(
          SitemapService.TRANSLATION_TAGGED_MESSAGE_REGEX
        );

        const segment = match
          ? (this.i18nService.getTranslation({
              languageCode,
              id: match.groups.id
            }) ?? match.groups.message)
          : link;

        return segment.replace(/^\/+|\/+$/, '');
      }) ?? [];

    const location = [rootUrl, languageCode, ...segments].join('/');

    return [
      '  <url>',
      `    <loc>${location}</loc>`,
      `    <lastmod>${currentDate}T00:00:00+00:00</lastmod>`,
      '  </url>'
    ].join('\n');
  }
}
