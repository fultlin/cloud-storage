import { describe, expect, it } from 'vitest';
import { folderPathFromUrl, folderUrl } from './paths.js';

describe('folder URL conversion', () => {
  it.each(['', 'Документы/', '100% #1?/', '%2E%2E/', 'a/b/', 'Папка/Отчёт 2026/'])
    ('round-trips %s exactly once', path => {
      expect(folderPathFromUrl(folderUrl(path))).toBe(path);
    });

  it('encodes each segment, preserving hierarchy', () => {
    expect(folderUrl('a/100% #1?/')).toBe('/files/a/100%25%20%231%3F/');
  });

  it.each(['/files/%2E%2E/', '/files/a%2Fb/', '/files/%ZZ/', '/files/a//', '/elsewhere/'])
    ('rejects invalid URL %s', path => { expect(() => folderPathFromUrl(path)).toThrow(); });
});
