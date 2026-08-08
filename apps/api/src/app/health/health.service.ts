import { RedisCacheService } from '@ghostfolio/api/app/redis-cache/redis-cache.service';
import { DataEnhancerService } from '@ghostfolio/api/services/data-provider/data-enhancer/data-enhancer.service';
import { DataProviderService } from '@ghostfolio/api/services/data-provider/data-provider.service';
import { PropertyService } from '@ghostfolio/api/services/property/property.service';
import { PROPERTY_CURRENCIES } from '@ghostfolio/common/config';

import { Injectable } from '@nestjs/common';
import { DataSource } from '@prisma/client';
import ms from 'ms';

/**
 * How long a deep probe's verdict stands before another outbound call is made.
 *
 * A deep probe is not a cheap read: it starts a fresh, deliberately uncached
 * request to a third-party provider with a request timeout of thirty seconds. Its
 * answer is a property of that provider rather than of this request, and it does
 * not change from one second to the next, so serving the same verdict for a short
 * window costs an operator nothing and is what turns "one outbound call per
 * caller" into "one outbound call per provider per minute".
 */
const DEEP_PROBE_VERDICT_TTL = ms('1 minute');

@Injectable()
export class HealthService {
  /**
   * The verdict most recently reached for each provider or enhancer, with the
   * moment it stops standing.
   *
   * Bounded by construction: a key only ever enters here after the underlying
   * service has recognised the name, and the set of recognised names is fixed at
   * build time - nine data sources and two enhancers. An unrecognised name is
   * refused before it can add anything, so this cannot be grown by a caller.
   */
  private readonly deepProbeVerdicts = new Map<
    string,
    { isHealthy: boolean; standsUntil: number }
  >();

  /**
   * The deep probes that are currently outstanding, keyed the same way.
   *
   * Concurrent callers asking about the same provider share one outbound call.
   * Together with the verdict window above, this is what caps the outbound work
   * this endpoint can cause: at most one request per recognised name per window,
   * however many callers arrive and however slowly the provider answers.
   */
  private readonly inFlightDeepProbes = new Map<string, Promise<boolean>>();

  public constructor(
    private readonly dataEnhancerService: DataEnhancerService,
    private readonly dataProviderService: DataProviderService,
    private readonly propertyService: PropertyService,
    private readonly redisCacheService: RedisCacheService
  ) {}

  public async hasResponseFromDataEnhancer(aName: string) {
    return this.probeOnce(`data-enhancer:${aName}`, () => {
      return this.dataEnhancerService.enhance(aName);
    });
  }

  public async hasResponseFromDataProvider(aDataSource: DataSource) {
    return this.probeOnce(`data-provider:${aDataSource}`, () => {
      return this.dataProviderService.checkQuote(aDataSource);
    });
  }

  public async isDatabaseHealthy() {
    try {
      await this.propertyService.getByKey(PROPERTY_CURRENCIES);

      return true;
    } catch {
      return false;
    }
  }

  public async isRedisCacheHealthy() {
    try {
      const isHealthy = await this.redisCacheService.isHealthy();

      return isHealthy;
    } catch {
      return false;
    }
  }

  /**
   * Runs a deep probe at most once per key per window.
   *
   * Three layers, in order: a verdict that still stands is returned without any
   * outbound call; otherwise an outstanding probe for the same key is joined; only
   * a key with neither starts a new one.
   *
   * A thrown probe is deliberately **not** recorded as a verdict and not treated as
   * unhealthy. `DataEnhancerService.enhance` raises a 404 for a name it does not
   * recognise, and that has to keep reaching the caller unchanged - it is how an
   * unknown name is refused before any outbound request is made, which is also what
   * keeps the two maps above from being grown by a caller. Recording it would
   * additionally mean a transient failure suppressed the next real probe for a
   * whole window.
   *
   * @param aKey the probe's identity: kind plus the recognised name.
   * @param aProbe the underlying call, invoked at most once per window.
   */
  private async probeOnce(
    aKey: string,
    aProbe: () => Promise<boolean>
  ): Promise<boolean> {
    const verdict = this.deepProbeVerdicts.get(aKey);

    if (verdict && verdict.standsUntil > Date.now()) {
      return verdict.isHealthy;
    }

    const inFlightProbe = this.inFlightDeepProbes.get(aKey);

    // Compared against `undefined` rather than tested for truthiness: a promise is
    // always truthy, and a bare conditional on one is the shape that silently
    // branches on the wrapper instead of on the value.
    if (inFlightProbe !== undefined) {
      return inFlightProbe;
    }

    const probe = aProbe()
      .then((isHealthy) => {
        this.deepProbeVerdicts.set(aKey, {
          isHealthy,
          standsUntil: Date.now() + DEEP_PROBE_VERDICT_TTL
        });

        return isHealthy;
      })
      .finally(() => {
        this.inFlightDeepProbes.delete(aKey);
      });

    this.inFlightDeepProbes.set(aKey, probe);

    return probe;
  }
}
