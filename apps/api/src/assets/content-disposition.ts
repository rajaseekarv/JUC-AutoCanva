// Builds the Content-Disposition header for a stored asset name: inline for
// image previews, attachment for downloads.
// C0 and C1 control characters (including CR and LF) are dropped so a name can never
// split or inject a header, and quotes and backslashes are dropped so it
// cannot end the quoted string early. Node rejects header characters above
// U+00FF, so names outside printable ASCII get an ASCII fallback plus an
// RFC 6266 / RFC 5987 UTF-8 filename* parameter.
function contentDisposition(
  type: 'inline' | 'attachment',
  originalName: string,
): string {
  const safeName = Array.from(originalName)
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return (
        code >= 32 &&
        (code < 127 || code > 159) &&
        character !== '"' &&
        character !== '\\'
      );
    })
    .join('')
    .trim();
  const name = safeName || 'asset';
  const asciiName = Array.from(name)
    .map((character) =>
      (character.codePointAt(0) ?? 0) > 126 ? '_' : character,
    )
    .join('');
  if (asciiName === name) return type + '; filename="' + name + '"';
  const encodedName = encodeURIComponent(name).replace(
    /['()*]/g,
    (character) => '%' + character.charCodeAt(0).toString(16).toUpperCase(),
  );
  return (
    type + '; filename="' + asciiName + "\"; filename*=UTF-8''" + encodedName
  );
}

export function inlineContentDisposition(originalName: string): string {
  return contentDisposition('inline', originalName);
}

export function attachmentContentDisposition(originalName: string): string {
  return contentDisposition('attachment', originalName);
}
