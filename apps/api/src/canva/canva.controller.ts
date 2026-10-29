import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthenticatedPrincipal } from '../auth/auth.types';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CanvaService } from './canva.service';
import { CanvaOAuthService } from './oauth/canva-oauth.service';

const jobSchema = z
  .object({ creativeId: z.string().trim().min(1).max(128) })
  .strict();

@Controller('integrations/canva')
@UseGuards(JwtAuthGuard)
export class CanvaController {
  constructor(
    private readonly canva: CanvaService,
    private readonly oauth: CanvaOAuthService,
  ) {}

  // Records an OAuth attempt and returns a one-time launch token as JSON:
  // the web app must send its Bearer token, which a plain navigation cannot.
  // The browser then posts the token to launchUrl in a top-level form.
  @Post('oauth/authorize')
  @HttpCode(HttpStatus.OK)
  authorize(@CurrentUser() user: AuthenticatedPrincipal) {
    return this.oauth.beginAuthorization(user);
  }

  // The pending Canva account, for the same administrator and session.
  @Get('oauth/candidate')
  candidate(@CurrentUser() user: AuthenticatedPrincipal) {
    return this.oauth.getCandidate(user);
  }

  @Post('oauth/candidate/confirm')
  @HttpCode(HttpStatus.OK)
  confirmCandidate(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Body() body: unknown,
  ) {
    return this.oauth.confirmCandidate(user, body);
  }

  @Post('oauth/candidate/reject')
  @HttpCode(HttpStatus.OK)
  rejectCandidate(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Body() body: unknown,
  ) {
    return this.oauth.rejectCandidate(user, body);
  }

  // Exhausted revocations awaiting an administrator's retry or dismissal.
  @Get('revocations')
  revocations(@CurrentUser() user: AuthenticatedPrincipal) {
    return this.oauth.listExhaustedRevocations(user);
  }

  @Post('revocations/:revocationId/retry')
  @HttpCode(HttpStatus.OK)
  retryRevocation(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('revocationId') revocationId: string,
  ) {
    return this.oauth.retryRevocation(user, revocationId);
  }

  @Post('revocations/:revocationId/dismiss')
  @HttpCode(HttpStatus.OK)
  dismissRevocation(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('revocationId') revocationId: string,
  ) {
    return this.oauth.dismissRevocation(user, revocationId);
  }

  @Get('status')
  status(@CurrentUser() user: AuthenticatedPrincipal) {
    return this.canva.status(user);
  }

  @Post('connect')
  connect(@CurrentUser() user: AuthenticatedPrincipal) {
    return this.canva.connect(user);
  }

  @Post('disconnect')
  disconnect(@CurrentUser() user: AuthenticatedPrincipal) {
    return this.canva.disconnect(user);
  }

  @Get('jobs')
  listJobs(@CurrentUser() user: AuthenticatedPrincipal) {
    return this.canva.listJobs(user);
  }

  @Post('jobs')
  createJob(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ) {
    const parsed = jobSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Invalid Canva job');
    if (!idempotencyKey || !/^[\w.:/-]{8,128}$/.test(idempotencyKey))
      throw new BadRequestException('A valid Idempotency-Key is required');
    return this.canva.createJob(user, parsed.data.creativeId, idempotencyKey);
  }

  @Get('jobs/:jobId')
  getJob(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('jobId') jobId: string,
  ) {
    return this.canva.getJob(user, jobId);
  }
}
