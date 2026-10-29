import { z } from 'zod';
import {
  canvaEnvironmentShape,
  checkCanvaEnvironment,
  webOriginSchema,
} from '../canva/oauth/canva-oauth.config';

const environmentSchema = z
  .object({
    DATABASE_URL: z
      .string()
      .url()
      .refine(
        (value) =>
          value.startsWith('postgresql://') || value.startsWith('postgres://'),
        {
          message:
            'DATABASE_URL must use the postgresql:// or postgres:// protocol',
        },
      ),
    REDIS_URL: z
      .string()
      .url()
      .refine(
        (value) =>
          value.startsWith('redis://') || value.startsWith('rediss://'),
        { message: 'REDIS_URL must use the redis:// or rediss:// protocol' },
      ),
    API_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    API_HOST: z.string().min(1).default('127.0.0.1'),
    WEB_ORIGIN: webOriginSchema,
    JWT_ACCESS_SECRET: z.string().min(32),
    JWT_ACCESS_TTL_SECONDS: z.coerce
      .number()
      .int()
      .min(60)
      .max(3600)
      .default(900),
    // Canva mode defaults to mock; real-mode values are required and checked
    // only when CANVA_PROVIDER_MODE=canva. Messages never include values.
    ...canvaEnvironmentShape,
  })
  .superRefine(checkCanvaEnvironment);

export type ApiEnvironment = z.infer<typeof environmentSchema>;

export function validateEnvironment(source: NodeJS.ProcessEnv): ApiEnvironment {
  const result = environmentSchema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return result.data;
}
