process.env.JWT_ACCESS_SECRET ??= 'test-only-secret-value-at-least-32-chars';

// API tests never use a real database. Anything that constructs a
// PrismaClient (such as the health e2e test booting AppModule) would
// otherwise pick up the development DATABASE_URL from the root .env; an
// already-set variable takes precedence over .env, and port 1 on loopback
// refuses connections.
export const blockedTestDatabaseUrl =
  'postgresql://api-tests-must-not-connect@127.0.0.1:1/blocked';
process.env.DATABASE_URL = blockedTestDatabaseUrl;
