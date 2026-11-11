import { vi } from 'vitest';

// jsdom has no object URLs. Each image reply's blob is labelled with the
// asset it came from, so a test can tell which asset an <img> shows.
const blobLabels = new WeakMap<Blob, string>();

export function imageReply(label: string, type = 'image/png') {
  const image = new Blob([new Uint8Array([137, 80, 78, 71])], { type });
  blobLabels.set(image, label);
  return {
    ok: true,
    status: 200,
    json: async () => ({}),
    blob: async () => image,
  };
}

export function stubObjectUrls() {
  const created: string[] = [];
  const revoked: string[] = [];
  const createDescriptor = Object.getOwnPropertyDescriptor(
    URL,
    'createObjectURL',
  );
  const revokeDescriptor = Object.getOwnPropertyDescriptor(
    URL,
    'revokeObjectURL',
  );
  let sequence = 0;
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    writable: true,
    value: vi.fn((image: Blob) => {
      const url =
        'blob:test/' +
        (blobLabels.get(image) ?? 'unlabelled') +
        '/' +
        ++sequence;
      created.push(url);
      return url;
    }),
  });
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    writable: true,
    value: vi.fn((url: string) => {
      revoked.push(url);
    }),
  });
  return {
    created,
    revoked,
    restore() {
      for (const [name, descriptor] of [
        ['createObjectURL', createDescriptor],
        ['revokeObjectURL', revokeDescriptor],
      ] as const) {
        if (descriptor) Object.defineProperty(URL, name, descriptor);
        else delete (URL as unknown as Record<string, unknown>)[name];
      }
    },
  };
}

export const statusReply = (status: number, body: unknown = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});
