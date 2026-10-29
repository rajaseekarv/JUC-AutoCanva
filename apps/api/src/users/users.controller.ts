import {
  Controller,
  Delete,
  Get,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthenticatedPrincipal } from '../auth/auth.types';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PermissionGuard } from '../auth/permission.guard';
import { PERMISSIONS } from '../auth/permissions';
import { RequirePermissions } from '../auth/require-permissions.decorator';
import { UsersService } from './users.service';

@Controller('users')
@UseGuards(JwtAuthGuard, PermissionGuard)
@RequirePermissions(PERMISSIONS.USER_BRANCH_ACCESS_MANAGE)
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedPrincipal) {
    return this.usersService.listInOrganization(user);
  }

  @Get(':userId/branches')
  listBranchAccess(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('userId') userId: string,
  ) {
    return this.usersService.listBranchAccess(user, userId);
  }

  @Post(':userId/branches/:branchId')
  grantBranchAccess(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('userId') userId: string,
    @Param('branchId') branchId: string,
  ) {
    return this.usersService.grantBranchAccess(user, userId, branchId);
  }

  @Delete(':userId/branches/:branchId')
  revokeBranchAccess(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('userId') userId: string,
    @Param('branchId') branchId: string,
  ) {
    return this.usersService.revokeBranchAccess(user, userId, branchId);
  }
}
