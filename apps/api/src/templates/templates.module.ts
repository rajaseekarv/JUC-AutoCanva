import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { BrandModule } from '../brand/brand.module';
import { AssetsModule } from '../assets/assets.module';
import { TemplatesController } from './templates.controller';
import { TemplatesService } from './templates.service';

@Module({
  imports: [AuthModule, BrandModule, AssetsModule],
  controllers: [TemplatesController],
  providers: [TemplatesService],
  exports: [TemplatesService],
})
export class TemplatesModule {}
