import { describe, expect, it } from 'vitest';
import { MockCanvaProvider } from './mock-canva.provider';

describe('MockCanvaProvider', () => {
  it('simulates connection and creates a stable, explicitly mock design reference', async () => {
    const provider = new MockCanvaProvider();
    expect(provider.connect()).toEqual({
      accountLabel: 'Mock Canva account',
      mode: 'MOCK',
    });
    const input = {
      creativeId: 'creative-1',
      revisionId: 'revision-2',
      revisionNumber: 2,
      templateVersionId: 'template-version-1',
      templateName: 'Social square',
    };
    const first = await provider.prepareDesign(input);
    expect(await provider.prepareDesign(input)).toEqual(first);
    expect(first).toMatchObject({
      externalDesignId: 'mock-design-revision-2',
      name: 'MOCK · Social square · revision 2',
      mode: 'MOCK',
      status: 'SUCCEEDED',
    });
    expect(provider.disconnect()).toEqual({ mode: 'MOCK' });
  });
});
