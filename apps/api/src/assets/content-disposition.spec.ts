import { describe, expect, it } from 'vitest';
import {
  attachmentContentDisposition,
  inlineContentDisposition,
} from './content-disposition';

describe('inlineContentDisposition', () => {
  it.each([
    'logo.png',
    'banner.png',
    'creative-final.jpg',
    'Brand Kit (v2).webp',
  ])(
    'keeps the ordinary name %s unchanged, including the letters r and n',
    (name) => {
      expect(inlineContentDisposition(name)).toBe(
        'inline; filename="' + name + '"',
      );
    },
  );

  it('drops CR and LF so a name cannot inject another header', () => {
    const header = inlineContentDisposition(
      'creative-final\r\nSet-Cookie: session=stolen.jpg',
    );
    expect(header).toBe(
      'inline; filename="creative-finalSet-Cookie: session=stolen.jpg"',
    );
    expect(header).not.toMatch(/[\r\n]/);
  });

  it('drops every other control character, including NUL, tab, DEL, and C1', () => {
    expect(
      inlineContentDisposition('lo\u0000go\t\u007f\u001b\u0085\u009b.png'),
    ).toBe('inline; filename="logo.png"');
  });

  it('drops quotes and backslashes so the quoted filename cannot be closed early', () => {
    expect(inlineContentDisposition('a"; filename="evil.html\\.png')).toBe(
      'inline; filename="a; filename=evil.html.png"',
    );
  });

  it('falls back to "asset" when nothing printable remains', () => {
    expect(inlineContentDisposition('\r\n"\\  ')).toBe(
      'inline; filename="asset"',
    );
  });

  it('adds a UTF-8 filename* with an ASCII fallback for non-ASCII names', () => {
    expect(inlineContentDisposition("café 'menü'.png")).toBe(
      'inline; filename="caf_ \'men_\'.png"; ' +
        "filename*=UTF-8''caf%C3%A9%20%27men%C3%BC%27.png",
    );
    expect(inlineContentDisposition('ロゴ.png')).toBe(
      'inline; filename="__.png"; filename*=UTF-8\'\'%E3%83%AD%E3%82%B4.png',
    );
  });

  it('only produces characters Node accepts in a header value', () => {
    const names = [
      'creative-final\r\n.jpg',
      'ロゴ \u0085.png',
      '😀 banner.png',
    ];
    for (const name of names)
      expect(inlineContentDisposition(name)).toMatch(/^[\x20-\x7e]+$/);
  });
});

describe('attachmentContentDisposition', () => {
  it('marks a download as an attachment with the same sanitized name', () => {
    expect(attachmentContentDisposition('logo.png')).toBe(
      'attachment; filename="logo.png"',
    );
    expect(attachmentContentDisposition('banner\r\nSet-Cookie: x=1.png')).toBe(
      'attachment; filename="bannerSet-Cookie: x=1.png"',
    );
    expect(attachmentContentDisposition('ロゴ.png')).toBe(
      'attachment; filename="__.png"; filename*=UTF-8\'\'%E3%83%AD%E3%82%B4.png',
    );
  });
});
