import { DATE_FORMAT, getYesterday } from '@ghostfolio/common/helper';

import { Test, TestingModule } from '@nestjs/testing';
import { format } from 'date-fns';
import { Response } from 'express';

import { SitemapController } from './sitemap.controller';
import { SitemapService } from './sitemap.service';

/**
 * The document a search engine actually receives.
 *
 * The service composes the entries and its own suite covers which ones survive the
 * removal of the public surface. What this suite covers is everything between that
 * fragment and the response: the template read from the built assets, the single
 * placeholder it carries, the date the entries are stamped with, and the content
 * type - none of which the service can be asked about.
 *
 * The date deserves the assertion it gets. The handler stamps every entry with
 * *yesterday*, which is deliberate rather than approximate: a sitemap claiming a
 * modification time in the reader's future is invalid, and the API and the reader
 * are in different time zones often enough that "today" is not safe. Asserting it
 * against `getYesterday()` rather than against a fixed string keeps the test true
 * on every day it runs while still pinning the intent.
 *
 * The response is a doubled `express` response rather than a real HTTP exchange,
 * because `@Res()` hands the handler the response object and returns nothing - so
 * what the handler did is observable only through that object. Both members it
 * touches are recorded.
 */
describe('SitemapController', () => {
  const publicRoutesFragment = [
    '  <url>',
    '    <loc>https://ghostfol.io/en</loc>',
    '    <lastmod>2026-08-07T00:00:00+00:00</lastmod>',
    '  </url>'
  ].join('\n');

  let getPublicRoutes: jest.Mock;
  let sitemapController: SitemapController;

  /** The two members of the response the handler is allowed to touch. */
  let response: Response;
  let sentBody: string;
  let setHeaders: Record<string, string>;

  const createController = async () => {
    getPublicRoutes = jest.fn().mockReturnValue(publicRoutesFragment);

    const module: TestingModule = await Test.createTestingModule({
      controllers: [SitemapController],
      providers: [{ provide: SitemapService, useValue: { getPublicRoutes } }]
    }).compile();

    return module.get(SitemapController);
  };

  beforeEach(async () => {
    sentBody = undefined;
    setHeaders = {};

    response = {
      send: (body: string) => {
        sentBody = body;
      },
      setHeader: (name: string, value: string) => {
        setHeaders[name] = value;
      }
    } as unknown as Response;

    sitemapController = await createController();

    // The template is read from the built assets directory, which does not exist
    // when the suite runs from sources - the constructor swallows that on purpose,
    // so a deployment missing the asset serves an empty document rather than
    // failing to start. Assigned here so the interpolation below is exercised
    // against the real template shape, which is the thing worth testing.
    sitemapController.sitemapXml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<urlset',
      '  xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
      '  ${publicRoutes}',
      '</urlset>'
    ].join('\n');
  });

  it('answers with the entries interpolated into the template', () => {
    sitemapController.getSitemapXml(response);

    expect(sentBody).toContain(publicRoutesFragment);
    expect(sentBody).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(sentBody).toContain('</urlset>');
    // The placeholder is consumed rather than left behind, which is the one
    // failure mode of a template-based document that still looks plausible.
    expect(sentBody).not.toContain('${publicRoutes}');
  });

  it('declares the document as XML', () => {
    sitemapController.getSitemapXml(response);

    // Without this a browser and a crawler both read the body as HTML, and the
    // document is silently useless.
    expect(setHeaders).toEqual({ 'content-type': 'application/xml' });
  });

  it('stamps the entries with yesterday, never with a date in the future', () => {
    sitemapController.getSitemapXml(response);

    const [{ currentDate }] = getPublicRoutes.mock.calls[0] as [
      { currentDate: string }
    ];

    expect(getPublicRoutes).toHaveBeenCalledTimes(1);
    expect(currentDate).toBe(format(getYesterday(), DATE_FORMAT));
    expect(new Date(`${currentDate}T00:00:00+00:00`).getTime()).toBeLessThan(
      Date.now()
    );
  });

  it('serves an empty document rather than failing when the template is absent', () => {
    // What the constructor's swallowed read leaves behind. The endpoint answering
    // with nothing is recoverable; the application refusing to start because an
    // asset was not copied is not.
    sitemapController.sitemapXml = '';

    sitemapController.getSitemapXml(response);

    expect(sentBody).toBe('');
    expect(setHeaders).toEqual({ 'content-type': 'application/xml' });
  });
});
