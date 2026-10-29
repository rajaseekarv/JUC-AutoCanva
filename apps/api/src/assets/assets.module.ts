import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AssetsController } from './assets.controller';
import { AssetsService } from './assets.service';
import { ASSET_STORAGE, LocalAssetStorage } from './asset-storage';

@Module({
  imports: [AuthModule],
  controllers: [AssetsController],
  providers: [
    AssetsService,
    LocalAssetStorage,
    { provide: ASSET_STORAGE, useExisting: LocalAssetStorage },
  ],
  exports: [AssetsService],
})
export class AssetsModule {}
