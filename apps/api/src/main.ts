import dotenv from 'dotenv';
import { resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { validateEnvironment } from './config/environment';

dotenv.config({ path: resolve(__dirname, '../../../.env') });

async function bootstrap(): Promise<void> {
  const environment = validateEnvironment(process.env);
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('api/v1');
  const allowedOrigins = [environment.WEB_ORIGIN];
  if (process.env.NODE_ENV !== 'production') {
    const configuredOrigin = new URL(environment.WEB_ORIGIN);
    const loopbackAlias =
      configuredOrigin.hostname === 'localhost'
        ? '127.0.0.1'
        : configuredOrigin.hostname === '127.0.0.1'
          ? 'localhost'
          : undefined;
    if (loopbackAlias) {
      configuredOrigin.hostname = loopbackAlias;
      allowedOrigins.push(configuredOrigin.origin);
    }
  }
  app.enableCors({ origin: allowedOrigins });
  if (process.env.NODE_ENV === 'production') {
    await app.listen(environment.API_PORT);
  } else {
    await app.listen(environment.API_PORT, environment.API_HOST);
  }
}

void bootstrap();
