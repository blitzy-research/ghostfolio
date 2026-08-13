import { DEFAULT_CURRENCY } from '@ghostfolio/common/config';
import { InfoResponse } from '@ghostfolio/common/interfaces';
import { filterGlobalPermissions } from '@ghostfolio/common/permissions';
import { GF_ENVIRONMENT } from '@ghostfolio/ui/environment';
import { GfNotificationModule } from '@ghostfolio/ui/notifications';

import { Platform } from '@angular/cdk/platform';
import {
  provideHttpClient,
  withInterceptorsFromDi
} from '@angular/common/http';
import {
  enableProdMode,
  importProvidersFrom,
  provideZoneChangeDetection
} from '@angular/core';
import {
  DateAdapter,
  MAT_DATE_FORMATS,
  MAT_DATE_LOCALE,
  MatNativeDateModule
} from '@angular/material/core';
import { MatSnackBarModule } from '@angular/material/snack-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { bootstrapApplication } from '@angular/platform-browser';
import { provideAnimations } from '@angular/platform-browser/animations';
import { RouterModule, TitleStrategy } from '@angular/router';
import { ServiceWorkerModule } from '@angular/service-worker';
import { provideIonicAngular } from '@ionic/angular/standalone';
import { provideMarkdown } from 'ngx-markdown';
import { provideNgxSkeletonLoader } from 'ngx-skeleton-loader';

import { CustomDateAdapter } from './app/adapter/custom-date-adapter';
import { DateFormats } from './app/adapter/date-formats';
import { GfAppComponent } from './app/app.component';
import { routes } from './app/app.routes';
import { authInterceptorProviders } from './app/core/auth.interceptor';
import { httpResponseInterceptorProviders } from './app/core/http-response.interceptor';
import { LanguageService } from './app/core/language.service';
import { ModulePreloadService } from './app/core/module-preload.service';
import { PageTitleStrategy } from './app/services/page-title.strategy';
import { environment } from './environments/environment';

/**
 * The public configuration to run with when the server cannot be asked for it.
 *
 * Every member the interface declares as required is present, because the whole
 * point is that nothing downstream has to test for absence: a consumer reaching
 * into `benchmarks` or `currencies` on a boot that had no answer would fail in
 * exactly the place this fallback exists to keep working.
 *
 * The values are the neutral ones rather than plausible ones. `globalPermissions`
 * is empty because a permission this client cannot confirm must not be assumed -
 * the affordances it gates are the ones that would fail against the server
 * anyway - and `demoAuthToken` is empty because signing in as the demo user is
 * not possible while the server is unreachable. `baseCurrency` is the only
 * member with a real value, because it is used for formatting rather than for
 * authorisation and a missing currency code renders as broken text.
 *
 * `statistics` is stated in full rather than left partial: the interface requires
 * all eight counters, and zero is the honest answer for a figure that could not be
 * read. Nothing in the dashboard renders them today - they belonged to the public
 * pages this canvas replaced - so the members exist to satisfy the contract rather
 * than to be displayed.
 */
const createUnavailableInfo = (): InfoResponse => ({
  baseCurrency: DEFAULT_CURRENCY,
  benchmarks: [],
  currencies: [],
  demoAuthToken: '',
  globalPermissions: [],
  statistics: {
    activeUsers1d: 0,
    activeUsers30d: 0,
    dockerHubPulls: 0,
    gitHubContributors: 0,
    gitHubStargazers: 0,
    newUsers30d: 0,
    slackCommunityUsers: 0,
    uptime: 0
  }
});

/**
 * Reads the public configuration, and answers with the fallback rather than
 * throwing.
 *
 * This runs BEFORE `bootstrapApplication`, which is what made its failure so
 * severe: a rejected promise here meant Angular was never started at all, so
 * `<gf-root>` stayed empty and the viewer got a white screen with nothing to read
 * and nothing to press. Under the service worker that was reachable with the
 * network merely unavailable - the cached shell and all 52 assets were served
 * from cache, and then the one request that had to reach the network sank the
 * boot. A non-ok response did it too, so an API that was up but unhealthy looked
 * identical.
 *
 * Answering with a fallback is what turns that into a running application whose
 * individual surfaces can then say what is wrong: the dashboard already reports a
 * layout it could not read and offers to try again, and the shell says plainly
 * that some features are unavailable. The outcome is reported so a boot that ran
 * degraded is visible in a console rather than inferred from missing affordances,
 * and it is reported under a fixed identifier so it is searchable.
 */
const loadPublicInfo = async (): Promise<{
  info: InfoResponse;
  isAvailable: boolean;
}> => {
  try {
    const response = await fetch('/api/v1/info');

    if (!response.ok) {
      throw new Error(`status ${response.status}`);
    }

    return { info: (await response.json()) as InfoResponse, isAvailable: true };
  } catch (error) {
    // The reason, never the response body: this runs before anything has been
    // rendered, so what is emitted here is the only account of the boot, and a
    // body from an unhealthy endpoint can carry anything.
    console.error(
      `GF-PUBLIC-INFO-UNAVAILABLE (${
        error instanceof Error ? error.message : 'request failed'
      })`
    );

    return { info: createUnavailableInfo(), isAvailable: false };
  }
};

(async () => {
  const { info, isAvailable } = await loadPublicInfo();
  const utmSource = window.localStorage.getItem('utm_source') as
    | 'ios'
    | 'trusted-web-activity';

  info.globalPermissions = filterGlobalPermissions(
    info.globalPermissions,
    utmSource
  );

  (window as any).info = info;

  // Published on the same channel the configuration itself travels on, because it
  // is a property OF that configuration: it says whether what follows came from
  // the server or from the fallback above. The data facade owns the read side -
  // see `DataService.isPublicInfoUnavailable` - and clears it the moment a later
  // read succeeds, which is what makes the degraded state recoverable without a
  // reload.
  (window as any).isPublicInfoUnavailable = !isAvailable;

  if (environment.production) {
    enableProdMode();
  }

  await bootstrapApplication(GfAppComponent, {
    providers: [
      authInterceptorProviders,
      httpResponseInterceptorProviders,
      importProvidersFrom(
        GfNotificationModule,
        MatNativeDateModule,
        MatSnackBarModule,
        MatTooltipModule,
        RouterModule.forRoot(routes, {
          anchorScrolling: 'enabled',
          preloadingStrategy: ModulePreloadService,
          scrollPositionRestoration: 'top'
        }),
        ServiceWorkerModule.register('ngsw-worker.js', {
          enabled: environment.production,
          registrationStrategy: 'registerImmediately'
        })
      ),
      LanguageService,
      ModulePreloadService,
      provideAnimations(),
      provideHttpClient(withInterceptorsFromDi()),
      provideIonicAngular(),
      provideMarkdown(),
      provideNgxSkeletonLoader(),
      provideZoneChangeDetection(),
      {
        deps: [LanguageService, MAT_DATE_LOCALE, Platform],
        provide: DateAdapter,
        useClass: CustomDateAdapter
      },
      {
        provide: GF_ENVIRONMENT,
        useValue: environment
      },
      {
        provide: MAT_DATE_FORMATS,
        useValue: DateFormats
      },
      {
        provide: TitleStrategy,
        useClass: PageTitleStrategy
      }
    ]
  });
})();
