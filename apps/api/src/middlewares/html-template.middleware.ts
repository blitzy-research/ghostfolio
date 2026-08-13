import { environment } from '@ghostfolio/api/environments/environment';
import { I18nService } from '@ghostfolio/api/services/i18n/i18n.service';
import {
  DEFAULT_LANGUAGE_CODE,
  STORYBOOK_PATH,
  SUPPORTED_LANGUAGE_CODES
} from '@ghostfolio/common/config';
import { DATE_FORMAT, interpolate } from '@ghostfolio/common/helper';

import { Injectable, Logger, NestMiddleware } from '@nestjs/common';
import { format } from 'date-fns';
import { NextFunction, Request, Response } from 'express';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const title = 'Ghostfolio';

const locales = {
  '/de/blog/2023/01/ghostfolio-auf-sackgeld-vorgestellt': {
    featureGraphicPath: 'assets/images/blog/ghostfolio-x-sackgeld.png',
    title: `Ghostfolio auf Sackgeld.com vorgestellt - ${title}`
  },
  '/en/blog/2022/08/500-stars-on-github': {
    featureGraphicPath: 'assets/images/blog/500-stars-on-github.jpg',
    title: `500 Stars - ${title}`
  },
  '/en/blog/2022/10/hacktoberfest-2022': {
    featureGraphicPath: 'assets/images/blog/hacktoberfest-2022.png',
    title: `Hacktoberfest 2022 - ${title}`
  },
  '/en/blog/2022/12/the-importance-of-tracking-your-personal-finances': {
    featureGraphicPath: 'assets/images/blog/20221226.jpg',
    title: `The importance of tracking your personal finances - ${title}`
  },
  '/en/blog/2023/02/ghostfolio-meets-umbrel': {
    featureGraphicPath: 'assets/images/blog/ghostfolio-x-umbrel.png',
    title: `Ghostfolio meets Umbrel - ${title}`
  },
  '/en/blog/2023/03/ghostfolio-reaches-1000-stars-on-github': {
    featureGraphicPath: 'assets/images/blog/1000-stars-on-github.jpg',
    title: `Ghostfolio reaches 1’000 Stars on GitHub - ${title}`
  },
  '/en/blog/2023/05/unlock-your-financial-potential-with-ghostfolio': {
    featureGraphicPath: 'assets/images/blog/20230520.jpg',
    title: `Unlock your Financial Potential with Ghostfolio - ${title}`
  },
  '/en/blog/2023/07/exploring-the-path-to-fire': {
    featureGraphicPath: 'assets/images/blog/20230701.jpg',
    title: `Exploring the Path to FIRE - ${title}`
  },
  '/en/blog/2023/08/ghostfolio-joins-oss-friends': {
    featureGraphicPath: 'assets/images/blog/ghostfolio-joins-oss-friends.png',
    title: `Ghostfolio joins OSS Friends - ${title}`
  },
  '/en/blog/2023/09/ghostfolio-2': {
    featureGraphicPath: 'assets/images/blog/ghostfolio-2.jpg',
    title: `Announcing Ghostfolio 2.0 - ${title}`
  },
  '/en/blog/2023/09/hacktoberfest-2023': {
    featureGraphicPath: 'assets/images/blog/hacktoberfest-2023.png',
    title: `Hacktoberfest 2023 - ${title}`
  },
  '/en/blog/2023/11/black-week-2023': {
    featureGraphicPath: 'assets/images/blog/black-week-2023.jpg',
    title: `Black Week 2023 - ${title}`
  },
  '/en/blog/2023/11/hacktoberfest-2023-debriefing': {
    featureGraphicPath: 'assets/images/blog/hacktoberfest-2023.png',
    title: `Hacktoberfest 2023 Debriefing - ${title}`
  },
  '/en/blog/2024/09/hacktoberfest-2024': {
    featureGraphicPath: 'assets/images/blog/hacktoberfest-2024.png',
    title: `Hacktoberfest 2024 - ${title}`
  },
  '/en/blog/2024/11/black-weeks-2024': {
    featureGraphicPath: 'assets/images/blog/black-weeks-2024.jpg',
    title: `Black Weeks 2024 - ${title}`
  },
  '/en/blog/2025/09/hacktoberfest-2025': {
    featureGraphicPath: 'assets/images/blog/hacktoberfest-2025.png',
    title: `Hacktoberfest 2025 - ${title}`
  },
  '/en/blog/2025/11/black-weeks-2025': {
    featureGraphicPath: 'assets/images/blog/black-weeks-2025.jpg',
    title: `Black Weeks 2025 - ${title}`
  },
  '/en/blog/2026/04/ghostfolio-3': {
    featureGraphicPath: 'assets/images/blog/ghostfolio-3.jpg',
    title: `Announcing Ghostfolio 3.0 - ${title}`
  }
};

@Injectable()
export class HtmlTemplateMiddleware implements NestMiddleware {
  private indexHtmlMap: { [languageCode: string]: string } = {};

  public constructor(private readonly i18nService: I18nService) {
    try {
      this.indexHtmlMap = SUPPORTED_LANGUAGE_CODES.reduce(
        (map, languageCode) => ({
          ...map,
          [languageCode]: readFileSync(
            join(__dirname, '..', 'client', languageCode, 'index.html'),
            'utf8'
          )
        }),
        {}
      );
    } catch (error) {
      Logger.error(
        'Failed to initialize index HTML map',
        error,
        'HTMLTemplateMiddleware'
      );
    }
  }

  public use(request: Request, response: Response, next: NextFunction) {
    // The PATH alone, never `originalUrl`. `originalUrl` carries the query string,
    // and every decision below is made by inspecting the string for a dot: a
    // single query parameter containing one - `?jwt=<header>.<payload>.<signature>`
    // is the everyday case, and any `?symbol=BRK.B` or `?utm_source=a.b` will do -
    // made `isFileRequest` answer yes for a document request, so the response
    // bypassed interpolation and the visitor was served the template with its
    // `${title}`, `${description}` and `${rootUrl}` placeholders unsubstituted.
    // That reaches crawlers, link unfurlers and the service worker's cached copy
    // of the shell, so it outlives the request that produced it.
    //
    // The pathname is taken from `originalUrl` with the query removed, rather than
    // from `request.path`. That is not interchangeable here: this middleware is
    // mounted on a wildcard route, so Express strips the matched prefix from
    // `request.url` and `request.path` reads `/` for every request - which would
    // send `/api/...` and every locale-prefixed asset down the interpolation
    // branch. `originalUrl` is the one member Express never rewrites.
    //
    // The result is also what belongs in the two places it is used below: the
    // `locales` lookup is keyed by pathname, and the `path` interpolated into the
    // document becomes a canonical URL, which must not carry a one-off credential
    // or campaign parameter.
    const path = this.getPathname(request).replace(/\/$/, '');
    let languageCode = path.substr(1, 2);

    if (!SUPPORTED_LANGUAGE_CODES.includes(languageCode)) {
      languageCode = DEFAULT_LANGUAGE_CODE;
    }

    const currentDate = format(new Date(), DATE_FORMAT);
    const rootUrl = process.env.ROOT_URL || environment.rootUrl;

    if (
      path.startsWith('/api/') ||
      path.startsWith(STORYBOOK_PATH) ||
      this.isFileRequest(path) ||
      !environment.production
    ) {
      // Skip
      next();
    } else {
      const indexHtml = interpolate(this.indexHtmlMap[languageCode], {
        currentDate,
        languageCode,
        path,
        rootUrl,
        description: this.i18nService.getTranslation({
          languageCode,
          id: 'metaDescription'
        }),
        featureGraphicPath:
          locales[path]?.featureGraphicPath ?? 'assets/cover.png',
        keywords: this.i18nService.getTranslation({
          languageCode,
          id: 'metaKeywords'
        }),
        title:
          locales[path]?.title ??
          `${title} – ${this.i18nService.getTranslation({
            languageCode,
            id: 'slogan'
          })}`
      });

      return response.send(indexHtml);
    }
  }

  /**
   * The requested pathname: the original request target with the query string and
   * fragment removed.
   *
   * Split rather than parsed with `URL`. A request target is not required to be a
   * valid URL - a client may send a percent-encoding this application has no say
   * over - and a throw inside a middleware that every document request passes
   * through would turn a malformed address into a 500. Splitting on the two
   * delimiters cannot fail, and the delimiters are unambiguous: neither `?` nor `#`
   * may appear unencoded in a path.
   */
  private getPathname(request: Request): string {
    const url = request.originalUrl ?? request.url ?? '';

    return url.split(/[?#]/)[0];
  }

  private isFileRequest(filename: string) {
    if (filename === '/assets/LICENSE') {
      return true;
    } else if (
      filename.endsWith('-de.fi') ||
      filename.endsWith('-markets.sh') ||
      filename.includes('auth/ey')
    ) {
      return false;
    }

    return filename.split('.').pop() !== filename;
  }
}
