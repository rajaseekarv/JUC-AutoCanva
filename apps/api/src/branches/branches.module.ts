import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { BranchAccessGuard } from './branch-access.guard';
import { BranchesController } from './branches.controller';
import { BranchesService } from './branches.service';

@Module({
  imports: [AuthModule],
  controllers: [BranchesController],
  providers: [BranchesService, BranchAccessGuard],
})
export class BranchesModule {}
