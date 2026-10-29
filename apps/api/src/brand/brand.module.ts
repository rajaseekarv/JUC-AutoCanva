import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { BranchAccessGuard } from '../branches/branch-access.guard';
import { BrandController } from './brand.controller';
import { BrandService } from './brand.service';

@Module({
  imports: [AuthModule],
  controllers: [BrandController],
  providers: [BrandService, BranchAccessGuard],
  exports: [BrandService],
})
export class BrandModule {}
