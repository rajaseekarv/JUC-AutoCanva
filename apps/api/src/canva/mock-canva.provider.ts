import type {
  CanvaProvider,
  MockDesignRequest,
  PreparedDesign,
} from './canva-provider';

/** Deterministic local adapter. It never calls Canva or claims a real design exists. */
export class MockCanvaProvider implements CanvaProvider {
  readonly mode = 'MOCK' as const;

  connect() {
    return { accountLabel: 'Mock Canva account', mode: this.mode } as const;
  }

  disconnect() {
    return { mode: this.mode } as const;
  }

  async prepareDesign(request: MockDesignRequest): Promise<PreparedDesign> {
    return {
      externalDesignId: `mock-design-${request.revisionId}`,
      name: `MOCK · ${request.templateName} · revision ${request.revisionNumber}`,
      mode: this.mode,
      status: 'SUCCEEDED',
    };
  }
}
