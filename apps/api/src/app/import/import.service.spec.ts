import { AccountService } from '@ghostfolio/api/app/account/account.service';
import { ActivitiesService } from '@ghostfolio/api/app/activities/activities.service';
import { PlatformService } from '@ghostfolio/api/app/platform/platform.service';
import { PortfolioService } from '@ghostfolio/api/app/portfolio/portfolio.service';
import { ApiService } from '@ghostfolio/api/services/api/api.service';
import { DataProviderService } from '@ghostfolio/api/services/data-provider/data-provider.service';
import { ExchangeRateDataService } from '@ghostfolio/api/services/exchange-rate-data/exchange-rate-data.service';
import { MarketDataService } from '@ghostfolio/api/services/market-data/market-data.service';
import { DataGatheringService } from '@ghostfolio/api/services/queues/data-gathering/data-gathering.service';
import { SymbolProfileService } from '@ghostfolio/api/services/symbol-profile/symbol-profile.service';
import { TagService } from '@ghostfolio/api/services/tag/tag.service';
import type { UserWithSettings } from '@ghostfolio/common/types';

import { Logger } from '@nestjs/common';
import { DataSource } from '@prisma/client';

import { ImportService } from './import.service';

/**
 * What an import leaves behind when it cannot finish.
 *
 * An import is not one statement and cannot be made into one: accounts come from one
 * service, tags from another, market data from a third and every activity from a fourth,
 * with provider validation and exchange-rate lookups interleaved. So a failure halfway
 * through leaves whatever preceded it committed, and for most of what it writes that is
 * untidy but recoverable - a half-imported set of activities is visible in the interface
 * and can be deleted there.
 *
 * Asset profiles are the exception, and they are what these tests are about. A `MANUAL`
 * profile is brought into existence as a side effect of creating an activity that
 * references it, or directly when the file carries market data for it. If the import then
 * throws, that profile survives with nothing pointing at it - and there is no screen
 * outside the administration area where its owner could remove it. It is permanent litter
 * in their own data that they can neither see nor reach.
 *
 * The three conditions the cleanup insists on are each a way it could otherwise destroy
 * something it should not, so there is a case per condition below.
 */
describe('ImportService', () => {
  let importService: ImportService;
  let deleteById: jest.Mock;
  let getSymbolProfiles: jest.Mock;

  /** The profiles the store answers with, per successive call. */
  let symbolProfileResponses: unknown[][];

  const user = {
    id: 'user-a',
    permissions: [],
    settings: { settings: { baseCurrency: 'USD' } }
  } as unknown as UserWithSettings;

  const createAssetProfile = ({
    activitiesCount = 0,
    dataSource = DataSource.MANUAL,
    id = 'profile-id',
    symbol = 'MY-ASSET',
    userId = 'user-a'
  }: {
    activitiesCount?: number;
    dataSource?: DataSource;
    id?: string;
    symbol?: string;
    userId?: string;
  } = {}) => {
    return { activitiesCount, dataSource, id, symbol, userId };
  };

  /**
   * Builds the service with every collaborator refused.
   *
   * `DataProviderService.validateActivities` is the throw site on purpose: it is the
   * first thing the import does after the profiles it was handed have been created, which
   * is precisely the window in which an orphan is produced.
   */
  const createService = ({ succeeds = false }: { succeeds?: boolean } = {}) => {
    deleteById = jest.fn(() => Promise.resolve(undefined));

    getSymbolProfiles = jest.fn(() => {
      return Promise.resolve(symbolProfileResponses.shift() ?? []);
    });

    return new ImportService(
      {
        accounts: () => Promise.resolve([]),
        // Reached only on the success path, where the import names the accounts an
        // activity may be attached to.
        getAccounts: () => Promise.resolve([])
      } as unknown as AccountService,
      {
        // Reached only on the success path, where the import goes on to compare what it
        // was handed against what the viewer already has.
        getActivities: () => Promise.resolve({ activities: [] })
      } as unknown as ActivitiesService,
      {} as unknown as ApiService,
      {
        // Reached only on the success path, where the import asks for market data to be
        // gathered in the background for whatever it just created.
        gatherSymbols: () => Promise.resolve(undefined)
      } as unknown as DataGatheringService,
      {
        getDataSourceForImport: () => DataSource.MANUAL,
        validateActivities: () => {
          return succeeds
            ? Promise.resolve({})
            : Promise.reject(new Error('validation failed'));
        }
      } as unknown as DataProviderService,
      {} as unknown as ExchangeRateDataService,
      { updateMany: () => Promise.resolve([]) } as unknown as MarketDataService,
      { getPlatforms: () => Promise.resolve([]) } as unknown as PlatformService,
      {} as unknown as PortfolioService,
      {
        add: () => Promise.resolve(undefined),
        deleteById,
        getSymbolProfiles
      } as unknown as SymbolProfileService,
      { getTagsForUser: () => Promise.resolve([]) } as unknown as TagService
    );
  };

  const runFailingImport = async ({
    isDryRun = false
  }: { isDryRun?: boolean } = {}) => {
    const promise = importService.import({
      isDryRun,
      accountsWithBalancesDto: [],
      activitiesDto: [
        {
          currency: 'USD',
          dataSource: DataSource.MANUAL,
          date: '2026-01-01',
          fee: 0,
          quantity: 1,
          symbol: 'MY-ASSET',
          type: 'BUY',
          unitPrice: 1
        }
      ] as never,
      assetProfilesWithMarketDataDto: [],
      maxActivitiesToImport: 100,
      tagsDto: [],
      user
    });

    await expect(promise).rejects.toThrow('validation failed');
  };

  beforeEach(() => {
    symbolProfileResponses = [];

    jest.spyOn(Logger, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('an import that fails', () => {
    it('re-raises the failure the caller needs to see', async () => {
      importService = createService();

      // The cleanup changes what is left behind, not what is reported.
      await runFailingImport();
    });

    it('removes a profile it created and left pointing at nothing', async () => {
      importService = createService();

      symbolProfileResponses = [
        // Nothing existed beforehand ...
        [],
        // ... and afterwards there is a profile with no activities.
        [createAssetProfile({ id: 'orphan-id' })]
      ];

      await runFailingImport();

      expect(deleteById).toHaveBeenCalledTimes(1);
      expect(deleteById).toHaveBeenCalledWith('orphan-id');
    });

    it('keeps a profile that already existed', async () => {
      importService = createService();

      symbolProfileResponses = [
        // Already here before the import ran, and unused - which is an ordinary state
        // for a profile its owner created earlier and has not traded yet.
        [createAssetProfile()],
        [createAssetProfile()]
      ];

      await runFailingImport();

      expect(deleteById).not.toHaveBeenCalled();
    });

    it('keeps a profile something now references', async () => {
      importService = createService();

      symbolProfileResponses = [
        [],
        [createAssetProfile({ activitiesCount: 1 })]
      ];

      await runFailingImport();

      // A partially successful import keeps every profile its committed activities
      // depend on. Removing this would delete data the viewer can see.
      expect(deleteById).not.toHaveBeenCalled();
    });

    it('keeps a profile that is not sourced manually', async () => {
      importService = createService();

      symbolProfileResponses = [
        [],
        [createAssetProfile({ dataSource: DataSource.YAHOO })]
      ];

      await runFailingImport();

      // A provider-sourced profile is shared: other people's activities rely on it, and
      // it is not this user's to remove.
      expect(deleteById).not.toHaveBeenCalled();
    });

    it('keeps a profile belonging to somebody else', async () => {
      importService = createService();

      symbolProfileResponses = [[], [createAssetProfile({ userId: 'user-b' })]];

      await runFailingImport();

      expect(deleteById).not.toHaveBeenCalled();
    });

    it('reports a cleanup that itself fails rather than replacing the import failure', async () => {
      importService = createService();

      symbolProfileResponses = [[], [createAssetProfile()]];

      deleteById = jest.fn(() => Promise.reject(new Error('delete refused')));

      (
        importService as unknown as {
          symbolProfileService: { deleteById: jest.Mock };
        }
      ).symbolProfileService.deleteById = deleteById;

      // The caller still learns why their import failed. Surfacing the cleanup error
      // instead would hide the thing they can act on.
      await runFailingImport();

      expect(Logger.error).toHaveBeenCalled();
    });
  });

  describe('a dry run', () => {
    it('looks at no profiles at all, because it writes none', async () => {
      importService = createService();

      await runFailingImport({ isDryRun: true });

      // Passed straight through: a dry run cannot leave an orphan, so reading the store
      // twice to prove it would cost two queries per validation.
      expect(getSymbolProfiles).not.toHaveBeenCalled();
      expect(deleteById).not.toHaveBeenCalled();
    });
  });

  describe('an import that succeeds', () => {
    it('removes nothing', async () => {
      importService = createService({ succeeds: true });

      symbolProfileResponses = [[]];

      await importService.import({
        accountsWithBalancesDto: [],
        activitiesDto: [] as never,
        assetProfilesWithMarketDataDto: [],
        isDryRun: false,
        maxActivitiesToImport: 100,
        tagsDto: [],
        user
      });

      expect(deleteById).not.toHaveBeenCalled();
    });
  });
});
