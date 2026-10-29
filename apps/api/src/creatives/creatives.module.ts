import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { TemplatesModule } from '../templates/templates.module';
import { CreativesController } from './creatives.controller';
import { CreativesService } from './creatives.service';

@Module({
  imports: [AuthModule, TemplatesModule],
  controllers: [CreativesController],
  providers: [CreativesService],
})
export class CreativesModule {}
