import { ConfigurationService } from '@ghostfolio/api/services/configuration/configuration.service';
import {
  DEFAULT_LANGUAGE_CODE,
  SUPPORTED_LANGUAGE_CODES
} from '@ghostfolio/common/config';
import { interpolate } from '@ghostfolio/common/helper';

import {
  Controller,
  Get,
  OnModuleInit,
  Param,
  Res,
  Version,
  VERSION_NEUTRAL
} from '@nestjs/common';
import { Response } from 'express';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

@Controller('assets')
export class AssetsController implements OnModuleInit {
  private webManifest = '';

  public constructor(
    public readonly configurationService: ConfigurationService
  ) {}

  public onModuleInit() {
    try {
      this.webManifest = readFileSync(
        join(__dirname, 'assets', 'site.webmanifest'),
        'utf8'
      );
    } catch {}
  }

  /**
   * The language code is checked against the supported set and replaced by the
   * default when it is not one of them, rather than being interpolated as it
   * arrives.
   *
   * Two things made that necessary. The manifest's `start_url` is built from this
   * segment, so an unrecognised value produced a manifest that installs and then
   * launches to a path that does not exist - and the value genuinely arrives
   * unrecognised in ordinary use: the service worker serves the shell it cached at
   * build time, in which the document's own `${languageCode}` placeholder has not
   * been interpolated, so the browser requests
   * `/api/assets/${languageCode}/site.webmanifest` literally. The second reason is
   * independent of that: this segment was being written straight into a JSON
   * document, so a crafted path could add members to the manifest the server
   * serves. Answering only with codes this deployment ships closes both, and a
   * fallback rather than a 404 is deliberate - a viewer whose shell is a version
   * behind should still get an installable application.
   */
  @Get('/:languageCode/site.webmanifest')
  @Version(VERSION_NEUTRAL)
  public getWebManifest(
    @Param('languageCode') languageCode: string,
    @Res() response: Response
  ): void {
    const rootUrl = this.configurationService.get('ROOT_URL');
    const webManifest = interpolate(this.webManifest, {
      languageCode: SUPPORTED_LANGUAGE_CODES.includes(languageCode)
        ? languageCode
        : DEFAULT_LANGUAGE_CODE,
      rootUrl
    });

    response.setHeader('Content-Type', 'application/json');
    response.send(webManifest);
  }
}
