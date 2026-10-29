import { PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { blockedTestDatabaseUrl } from './test-setup';

describe('API test database guard', () => {
  it('points DATABASE_URL at a closed loopback port for every API test', () => {
    expect(process.env.DATABASE_URL).toBe(blockedTestDatabaseUrl);
    const url = new URL(blockedTestDatabaseUrl);
    expect(url.hostname).toBe('127.0.0.1');
    expect(url.port).toBe('1');
  });

  it('keeps the blocked URL after Prisma loads the root .env', () => {
    // Constructing the client loads .env but does not connect; no query or
    // $connect is issued here.
    new PrismaClient();
    expect(process.env.DATABASE_URL).toBe(blockedTestDatabaseUrl);
  });
});
