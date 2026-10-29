import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { AppModule } from '../app.module';

process.env.JWT_ACCESS_SECRET ??= 'test-only-secret-value-at-least-32-chars';

describe('GET /api/v1/health', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('rejects an unauthenticated branch request', async () => {
    await request(app.getHttpServer()).get('/api/v1/branches').expect(401);
  });
  it('returns the API health status', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/health')
      .expect(200);
    expect(response.body).toMatchObject({
      status: 'ok',
      service: 'adflow-api',
    });
    expect(Number.isNaN(Date.parse(response.body.timestamp))).toBe(false);
  });
});
