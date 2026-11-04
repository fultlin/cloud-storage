export function contentDisposition(name: string): string {
  const fallback = name.replace(/[^\x20-\x7e]|["\\]/gu, '_');
  const encoded = encodeURIComponent(name).replace(/['()*]/g, character =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
