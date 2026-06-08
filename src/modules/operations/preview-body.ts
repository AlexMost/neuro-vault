export const PREVIEW_CHAR_CAP = 500;
export const PREVIEW_MARKER = '…';

export function previewBody(body: string): { content: string; truncated: boolean } {
  if (body.length <= PREVIEW_CHAR_CAP) {
    return { content: body, truncated: false };
  }

  // Find the last whitespace (space or newline) at index <= PREVIEW_CHAR_CAP
  const segment = body.slice(0, PREVIEW_CHAR_CAP + 1);
  const lastWs = Math.max(segment.lastIndexOf(' '), segment.lastIndexOf('\n'));

  const cutAt = lastWs !== -1 ? lastWs : PREVIEW_CHAR_CAP;
  const slice = body.slice(0, cutAt).trimEnd();

  return { content: slice + PREVIEW_MARKER, truncated: true };
}
