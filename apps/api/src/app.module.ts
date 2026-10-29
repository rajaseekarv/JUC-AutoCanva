import { Module } from '@nestjs/common';
import { HealthController } from './health/health.controller';
import { HealthService } from './health/health.service';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { BranchesModule } from './branches/branches.module';
import { OrganizationModule } from './organization/organization.module';
import { UsersModule } from './users/users.module';
import { BrandModule } from './brand/brand.module';
import { AssetsModule } from './assets/assets.module';
import { TemplatesModule } from './templates/templates.module';
import { CreativesModule } from './creatives/creatives.module';
import { WorkflowsModule } from './workflows/workflows.module';
import { ApprovalsModule } from './approvals/approvals.module';
import { AuditModule } from './audit/audit.module';
import { NotificationsModule } from './notifications/notifications.module';
import { CanvaModule } from './canva/canva.module';

@Module({
  imports: [
    PrismaModule,
    AuthModule,
    BranchesModule,
    OrganizationModule,
    UsersModule,
    BrandModule,
    AssetsModule,
    TemplatesModule,
    CreativesModule,
    WorkflowsModule,
    ApprovalsModule,
    AuditModule,
    NotificationsModule,
    CanvaModule,
  ],
  controllers: [HealthController],
  providers: [HealthService],
})
export class AppModule {}
