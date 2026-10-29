import { describe, expect, it } from 'vitest';
import { validateEnvironment } from './environment';

describe('validateEnvironment', () => {
  it('validates required service URLs and applies defaults', () => {
    expect(
      validateEnvironment({
        DATABASE_URL: 'postgresql://adflow:adflow@localhost:5432/adflow',
        REDIS_URL: 'redis://localhost:6379',
        JWT_ACCESS_SECRET: 'test-only-secret-value-at-least-32-chars',
      }),
    ).toEqual({
      DATABASE_URL: 'postgresql://adflow:adflow@localhost:5432/adflow',
      REDIS_URL: 'redis://localhost:6379',
      API_PORT: 3000,
      API_HOST: '127.0.0.1',
      WEB_ORIGIN: 'http://localhost:5173',
      JWT_ACCESS_SECRET: 'test-only-secret-value-at-least-32-chars',
      JWT_ACCESS_TTL_SECONDS: 900,
      // Real Canva stays disabled unless explicitly configured.
      CANVA_PROVIDER_MODE: 'mock',
      CANVA_TOKEN_ENCRYPTION_KEY_VERSION: 1,
      // Durable OAuth storage and the revocation worker are opt-in.
      CANVA_OAUTH_PERSISTENCE_ENABLED: false,
      CANVA_REVOCATION_WORKER_ENABLED: false,
    });
  });
  it('requires every Canva setting in canva mode and names them without values', () => {
    const secretLike = 'test-only-client-secret-do-not-echo';
    let message = '';
    try {
      validateEnvironment({
        DATABASE_URL: 'postgresql://adflow:adflow@localhost:5432/adflow',
        REDIS_URL: 'redis://localhost:6379',
        JWT_ACCESS_SECRET: 'test-only-secret-value-at-least-32-chars',
        CANVA_PROVIDER_MODE: 'canva',
        CANVA_CLIENT_SECRET: secretLike,
        CANVA_REDIRECT_URI:
          'http://localhost:3000/api/v1/integrations/canva/oauth/callback',
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/CANVA_CLIENT_ID/);
    expect(message).toMatch(/CANVA_REDIRECT_URI/);
    expect(message).toMatch(/CANVA_TOKEN_ENCRYPTION_KEY/);
    expect(message).not.toContain(secretLike);
    expect(message).not.toContain('localhost:3000');
  });
  it('reports invalid configuration with the field name', () => {
    expect(() =>
      validateEnvironment({
        DATABASE_URL: 'not-a-database-url',
        REDIS_URL: 'http://localhost:6379',
        JWT_ACCESS_SECRET: 'short',
      }),
    ).toThrow(/DATABASE_URL/);
  });
});
