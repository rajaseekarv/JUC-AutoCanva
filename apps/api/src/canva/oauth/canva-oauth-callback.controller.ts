import {
  Body,
  Controller,
  Get,
  Inject,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  CANVA_BINDING_COOKIE,
  CANVA_BINDING_COOKIE_PATH,
  CANVA_OAUTH_CONFIG,
  CANVA_OAUTH_STATE_TTL_MS,
  type CanvaOAuthConfig,
} from './canva-oauth.config';
import { CanvaOAuthService } from './canva-oauth.service';

// Reads one cookie without a cookie-parsing dependency. Values are opaque
// base64url tokens; anything else is ignored by the service's pattern check.
export function readCookie(
  header: string | undefined,
  name: string,
): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === name)
      return part.slice(separator + 1).trim();
  }
  return undefined;
}

// Both routes are top-level browser navigations without a Bearer token, so
// they have no JWT guard. The launch is authenticated by the one-time launch
// token; the callback by the single-use, server-stored state plus the
// browser-binding cookie, and the owner's session is re-checked before any
// token exchange (see CanvaOAuthService).
@Controller('integrations/canva/oauth')
export class CanvaOAuthCallbackController {
  constructor(
    private readonly oauth: CanvaOAuthService,
    @Inject(CANVA_OAUTH_CONFIG) private readonly config: CanvaOAuthConfig,
  ) {}

  // The binding cookie is Secure except on the loopback development host,
  // where Canva's guidance uses plain http://127.0.0.1.
  private cookieOptions() {
    const redirect =
      this.config.mode === 'canva' ? new URL(this.config.redirectUri) : null;
    return {
      httpOnly: true,
      sameSite: 'lax' as const,
      path: CANVA_BINDING_COOKIE_PATH,
      secure: redirect?.protocol === 'https:',
    };
  }

  @Post('launch')
  async launch(
    @Body() body: unknown,
    @Res() response: Response,
  ): Promise<void> {
    const { location, bindingCookie } = await this.oauth.launch(body);
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    if (bindingCookie)
      response.cookie(CANVA_BINDING_COOKIE, bindingCookie, {
        ...this.cookieOptions(),
        maxAge: CANVA_OAUTH_STATE_TTL_MS,
      });
    response.redirect(303, location);
  }

  @Get('callback')
  async callback(
    @Query() query: Record<string, unknown>,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    const destination = await this.oauth.completeAuthorization(
      query,
      readCookie(request.headers.cookie, CANVA_BINDING_COOKIE),
    );
    // The callback URL holds the authorization code: keep it out of caches
    // and Referer headers. The binding cookie is single-use.
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.clearCookie(CANVA_BINDING_COOKIE, this.cookieOptions());
    response.redirect(303, destination);
  }
}
