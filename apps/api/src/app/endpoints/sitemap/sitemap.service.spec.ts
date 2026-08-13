import { ConfigurationService } from '@ghostfolio/api/services/configuration/configuration.service';
import { SUPPORTED_LANGUAGE_CODES } from '@ghostfolio/common/config';

import { Test, TestingModule } from '@nestjs/testing';

import { SitemapService } from './sitemap.service';

/**
 * What the sitemap is still allowed to advertise.
 *
 * This service used to enumerate the public surface of the application: a landing
 * page, pricing, features, a FAQ, an about tree, open-startup, a resources tree and
 * roughly nineteen dated blog posts, each in the languages it existed in. That
 * surface no longer exists - the single-canvas dashboard removed it - so the
 * service was reduced to one entry per language, addressing the locale root.
 *
 * A sitemap is the one artefact whose whole purpose is to be read by somebody who
 * is not looking at the code, which makes an unpruned entry expensive in a way a
 * dead `routerLink` is not: a search engine follows it, gets a redirect to the
 * canvas, and reports the discrepancy for as long as the entry survives. Nothing
 * verified the pruning, so these tests assert the *absence* of the removed paths by
 * name rather than only the presence of what remains - an absence that a
 * count-based assertion would not have noticed if one path came back.
 *
 * The date is passed in rather than read from a clock, so every assertion here is
 * exact and none of them depends on when the suite runs.
 */
describe('SitemapService', () => {
  const currentDate = '2026-08-07';
  const rootUrl = 'https://ghostfol.io';

  /**
   * Paths this service used to advertise and must not any more.
   *
   * Each one is a page the refactor deleted. `p/` is the public share link, which
   * survives as a query parameter on the canvas rather than as a path, and which was
   * excluded from the sitemap even before that.
   */
  const REMOVED_PATHS = [
    'about',
    'blog',
    'demo',
    'faq',
    'features',
    'markets',
    'open',
    'p/',
    'pricing',
    'register',
    'resources',
    'start'
  ];

  let sitemapService: SitemapService;

  const createService = async (get = jest.fn().mockReturnValue(rootUrl)) => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SitemapService,
        { provide: ConfigurationService, useValue: { get } }
      ]
    }).compile();

    return { get, sitemapService: module.get(SitemapService) };
  };

  /** The `<loc>` value of every entry, in the order the service emitted them. */
  const locationsOf = (fragment: string) => {
    return [...fragment.matchAll(/<loc>([^<]+)<\/loc>/g)].map(
      (match) => match[1]
    );
  };

  beforeEach(async () => {
    ({ sitemapService } = await createService());
  });

  it('advertises exactly one address per supported language, and nothing else', () => {
    const fragment = sitemapService.getPublicRoutes({ currentDate });

    // Asserted as an exact ordered list rather than as a count, so a language
    // added to the shared configuration shows up here as a failing expectation
    // that names it rather than as a silently missing entry.
    expect(locationsOf(fragment)).toEqual(
      SUPPORTED_LANGUAGE_CODES.map(
        (languageCode) => `${rootUrl}/${languageCode}`
      )
    );
    expect(SUPPORTED_LANGUAGE_CODES).toHaveLength(13);
  });

  it.each(REMOVED_PATHS)('advertises no address under %s', (removedPath) => {
    // The pruning, asserted per removed page. The locale roots that remain end at
    // the language code, so any occurrence of one of these names would be an entry
    // that came back.
    expect(sitemapService.getPublicRoutes({ currentDate })).not.toContain(
      removedPath
    );
  });

  it('dates every entry with the date it was given, at midnight UTC', () => {
    const fragment = sitemapService.getPublicRoutes({ currentDate });

    const modificationDates = [
      ...fragment.matchAll(/<lastmod>([^<]+)<\/lastmod>/g)
    ].map((match) => match[1]);

    expect(modificationDates).toHaveLength(SUPPORTED_LANGUAGE_CODES.length);
    expect(new Set(modificationDates)).toEqual(
      new Set([`${currentDate}T00:00:00+00:00`])
    );
  });

  it('emits one well-formed url element per entry', () => {
    const fragment = sitemapService.getPublicRoutes({ currentDate });

    // Opened and closed the same number of times, and every entry carrying both
    // members the schema requires. A fragment is interpolated into a document
    // whose validity depends on it, so a stray tag here is a broken sitemap
    // rather than a cosmetic defect.
    expect(fragment.match(/<url>/g)).toHaveLength(
      SUPPORTED_LANGUAGE_CODES.length
    );
    expect(fragment.match(/<\/url>/g)).toHaveLength(
      SUPPORTED_LANGUAGE_CODES.length
    );
    expect(fragment).not.toContain('${');

    expect(fragment).toContain(
      [
        '  <url>',
        `    <loc>${rootUrl}/en</loc>`,
        `    <lastmod>${currentDate}T00:00:00+00:00</lastmod>`,
        '  </url>'
      ].join('\n')
    );
  });

  it('reads the deployment address through the configuration service', async () => {
    // Read rather than hardcoded, because a self-hosted deployment answers on its
    // own address and a sitemap naming ghostfol.io there would advertise somebody
    // else's application.
    const { get, sitemapService: service } = await createService(
      jest.fn().mockReturnValue('https://ghostfolio.example.com')
    );

    const fragment = service.getPublicRoutes({ currentDate });

    expect(get).toHaveBeenCalledWith('ROOT_URL');
    expect(locationsOf(fragment)).toContain(
      'https://ghostfolio.example.com/en'
    );
    expect(fragment).not.toContain('ghostfol.io');
  });
});
