import {
  BadRequestException,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthenticatedPrincipal } from '../auth/auth.types';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { NotificationsService } from './notifications.service';

@Controller('notifications')
@UseGuards(JwtAuthGuard)
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  list(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Query('page') page = '1',
    @Query('limit') limit = '25',
  ) {
    const p = Number(page),
      l = Number(limit);
    if (
      !Number.isInteger(p) ||
      p < 1 ||
      p > 100000 ||
      !Number.isInteger(l) ||
      l < 1 ||
      l > 100
    )
      throw new BadRequestException('Invalid pagination');
    return this.notifications.list(user, p, l);
  }
  @Get('unread-count') unread(@CurrentUser() user: AuthenticatedPrincipal) {
    return this.notifications.unreadCount(user);
  }
  @Get(':id') get(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('id') id: string,
  ) {
    return this.notifications.get(user, id);
  }
  @Post(':id/read') read(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('id') id: string,
  ) {
    return this.notifications.markRead(user, id);
  }
  @Post('read-all') readAll(@CurrentUser() user: AuthenticatedPrincipal) {
    return this.notifications.markAllRead(user);
  }
}
