export type MockDesignRequest = {
  creativeId: string;
  revisionId: string;
  revisionNumber: number;
  templateVersionId: string;
  templateName: string;
};

export type CanvaProviderMode = 'MOCK' | 'CANVA';

export type PreparedDesign = {
  externalDesignId: string;
  name: string;
  mode: CanvaProviderMode;
  status: 'SUCCEEDED';
};

export interface CanvaProvider {
  readonly mode: CanvaProviderMode;
  connect(): { accountLabel: string; mode: CanvaProviderMode };
  disconnect(): { mode: CanvaProviderMode };
  prepareDesign(request: MockDesignRequest): Promise<PreparedDesign>;
}

export const CANVA_PROVIDER = Symbol('CANVA_PROVIDER');
