import { Injectable } from '@nestjs/common';
import type { HealthResponse } from '@adflow/shared-types';

@Injectable()
export class HealthService {
  getHealth(): HealthResponse {
    return {
      status: 'ok',
      service: 'adflow-api',
      timestamp: new Date().toISOString(),
    };
  }
}
