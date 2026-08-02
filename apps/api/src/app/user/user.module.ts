import { ActivitiesModule } from '@ghostfolio/api/app/activities/activities.module';
import { SubscriptionModule } from '@ghostfolio/api/app/subscription/subscription.module';
import { PerformanceLoggingModule } from '@ghostfolio/api/interceptors/performance-logging/performance-logging.module';
import { RedactValuesInResponseModule } from '@ghostfolio/api/interceptors/redact-values-in-response/redact-values-in-response.module';
import { ConfigurationModule } from '@ghostfolio/api/services/configuration/configuration.module';
import { I18nModule } from '@ghostfolio/api/services/i18n/i18n.module';
import { ImpersonationModule } from '@ghostfolio/api/services/impersonation/impersonation.module';
import { PrismaModule } from '@ghostfolio/api/services/prisma/prisma.module';
import { PropertyModule } from '@ghostfolio/api/services/property/property.module';
import { TagModule } from '@ghostfolio/api/services/tag/tag.module';

import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';

import { UserDashboardLayoutController } from './user-dashboard-layout.controller';
import { UserDashboardLayoutService } from './user-dashboard-layout.service';
import { UserController } from './user.controller';
import { UserService } from './user.service';

@Module({
  controllers: [UserDashboardLayoutController, UserController],
  exports: [UserService],
  imports: [
    ActivitiesModule,
    ConfigurationModule,
    I18nModule,
    ImpersonationModule,
    JwtModule.register({
      secret: process.env.JWT_SECRET_KEY,
      signOptions: { expiresIn: '30 days' }
    }),
    PerformanceLoggingModule,
    PrismaModule,
    PropertyModule,
    RedactValuesInResponseModule,
    SubscriptionModule,
    TagModule
  ],
  providers: [UserDashboardLayoutService, UserService]
})
export class UserModule {}
