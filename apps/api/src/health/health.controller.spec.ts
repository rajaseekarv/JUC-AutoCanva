import { describe, expect, it } from 'vitest';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';

describe('GET /api/v1/health', () => {
  it('returns an API health response', () => {
    const response = new HealthController(new HealthService()).getHealth();
    expect(response.status).toBe('ok');
    expect(response.service).toBe('adflow-api');
    expect(Number.isNaN(Date.parse(response.timestamp))).toBe(false);
  });
});
