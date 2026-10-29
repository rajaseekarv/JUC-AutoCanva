import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { AuthenticatedPrincipal } from './auth.types';
import { REQUIRED_PERMISSIONS } from './require-permissions.decorator';

interface AuthenticatedRequest extends Request {
  user?: AuthenticatedPrincipal;
}

@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<string[]>(
      REQUIRED_PERMISSIONS,
      [context.getHandler(), context.getClass()],
    );
    if (!required?.length) return true;

    const user = context.switchToHttp().getRequest<AuthenticatedRequest>().user;
    if (
      !user ||
      !required.every((permission) => user.permissions.includes(permission))
    ) {
      throw new ForbiddenException('Permission denied');
    }
    return true;
  }
}
