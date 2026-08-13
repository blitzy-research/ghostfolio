import { ConfigurationService } from '@ghostfolio/api/services/configuration/configuration.service';
import { SymbolProfileService } from '@ghostfolio/api/services/symbol-profile/symbol-profile.service';

import { DataSource } from '@prisma/client';

import { LogoService } from './logo.service';

/**
 * Which answer a request for a logo deserves.
 *
 * Three outcomes are possible and only two of them used to be expressible. A profile that
 * carries an address gets a logo. A data source that does not exist gets `404`, because
 * that request names nothing. And a profile that exists but has no address to derive a
 * logo from - which is every manually created holding whose owner did not supply a link -
 * got `404` as well, saying the thing asked for could not be found when in fact it was
 * found and simply has no logo.
 *
 * That third case is answered as an absence of content instead, and the reason is not
 * pedantry: an `<img>` is what asks, so every such holding contributed a request that
 * failed by design, one per row and on every paint, leaving a log in which a genuine
 * failure had to be picked out by hand.
 */
describe('LogoService', () => {
  let logoService: LogoService;
  let getSymbolProfiles: jest.Mock;

  const createService = ({
    assetProfiles = [] as unknown[]
  }: { assetProfiles?: unknown[] } = {}) => {
    getSymbolProfiles = jest.fn(() => Promise.resolve(assetProfiles));

    return new LogoService(
      { get: () => 2000 } as unknown as ConfigurationService,
      { getSymbolProfiles } as unknown as SymbolProfileService
    );
  };

  describe('a profile with no address to derive a logo from', () => {
    it('answers with no logo rather than with a failure', async () => {
      logoService = createService({
        assetProfiles: [{ dataSource: DataSource.MANUAL, symbol: 'MY-ASSET' }]
      });

      await expect(
        logoService.getLogoByDataSourceAndSymbol({
          dataSource: DataSource.MANUAL,
          symbol: 'MY-ASSET'
        })
      ).resolves.toBeNull();
    });

    it('answers the same way when the profile does not exist at all', async () => {
      logoService = createService({ assetProfiles: [] });

      // Also not a failure: the caller asked whether there is a logo and the answer is
      // no. Answering it identically is deliberate - this endpoint carries no guard, so
      // telling "no such symbol" apart from "no logo for this symbol" would turn it into
      // an oracle for which symbols a deployment holds.
      await expect(
        logoService.getLogoByDataSourceAndSymbol({
          dataSource: DataSource.MANUAL,
          symbol: 'NOT-HERE'
        })
      ).resolves.toBeNull();
    });
  });

  describe('a data source that does not exist', () => {
    it('is refused, because the request names nothing', async () => {
      logoService = createService();

      await expect(
        logoService.getLogoByDataSourceAndSymbol({
          dataSource: 'NOT_A_PROVIDER' as DataSource,
          symbol: 'MY-ASSET'
        })
      ).rejects.toMatchObject({ status: 404 });
    });

    it('is refused before the store is asked', async () => {
      logoService = createService();

      await logoService
        .getLogoByDataSourceAndSymbol({
          dataSource: 'NOT_A_PROVIDER' as DataSource,
          symbol: 'MY-ASSET'
        })
        .catch(() => undefined);

      expect(getSymbolProfiles).not.toHaveBeenCalled();
    });
  });
});
