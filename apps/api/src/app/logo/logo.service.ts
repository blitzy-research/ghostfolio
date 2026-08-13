import { ConfigurationService } from '@ghostfolio/api/services/configuration/configuration.service';
import { SymbolProfileService } from '@ghostfolio/api/services/symbol-profile/symbol-profile.service';
import { AssetProfileIdentifier } from '@ghostfolio/common/interfaces';

import { HttpException, Injectable } from '@nestjs/common';
import { DataSource } from '@prisma/client';
import { StatusCodes, getReasonPhrase } from 'http-status-codes';

@Injectable()
export class LogoService {
  public constructor(
    private readonly configurationService: ConfigurationService,
    private readonly symbolProfileService: SymbolProfileService
  ) {}

  /**
   * The logo for an asset profile, or `null` when it simply has not got one.
   *
   * The distinction between those two answers is the point of the `null`. A profile with
   * no address to derive a logo from is an ordinary, permanent, entirely correct state -
   * every manually created holding is in it unless its owner supplied a link - and
   * answering `404` said instead that the thing asked for could not be found. The
   * difference is not academic, because an `<img>` is what asks: every such holding
   * contributed a request that failed by design, one per row and on every paint, and a
   * log full of them is a log in which a real failure has to be picked out by hand.
   *
   * A data source that does not exist keeps its `404`, because that request names
   * nothing this deployment could ever hold - it is refused from the enum before the
   * store is consulted.
   *
   * A symbol no profile has been stored for is deliberately answered the SAME way as a
   * profile with no address, and that is a security decision rather than an oversight:
   * this endpoint carries no guard, so telling the two apart would turn it into an
   * oracle for which symbols a deployment holds. Both are absences of a logo, both are
   * permanent, and the only caller is an `<img>` that treats them identically.
   */
  public async getLogoByDataSourceAndSymbol({
    dataSource,
    symbol
  }: AssetProfileIdentifier) {
    if (!DataSource[dataSource]) {
      throw new HttpException(
        getReasonPhrase(StatusCodes.NOT_FOUND),
        StatusCodes.NOT_FOUND
      );
    }

    const [assetProfile] = await this.symbolProfileService.getSymbolProfiles([
      { dataSource, symbol }
    ]);

    if (!assetProfile?.url) {
      return null;
    }

    return this.getBuffer(assetProfile.url);
  }

  public getLogoByUrl(aUrl: string) {
    return this.getBuffer(aUrl);
  }

  private async getBuffer(aUrl: string) {
    const blob = await fetch(
      `https://t0.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=${aUrl}&size=64`,
      {
        headers: { 'User-Agent': 'request' },
        signal: AbortSignal.timeout(
          this.configurationService.get('REQUEST_TIMEOUT')
        )
      }
    ).then((res) => res.blob());

    return {
      buffer: await blob.arrayBuffer().then((arrayBuffer) => {
        return Buffer.from(arrayBuffer);
      }),
      type: blob.type
    };
  }
}
