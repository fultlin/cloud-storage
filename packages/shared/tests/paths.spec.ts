import { describe, expect, it } from 'vitest';
import {
  directoryOrRootPathSchema,
  directoryPathSchema,
  filePathSchema,
  normalizeAndValidatePath,
  resourceNameSchema,
  resourcePathSchema,
} from '../src/paths.js';

describe('shared path validation', () => {
  it.each([
    'file.txt', 'docs/', 'docs/nested/file.txt', 'Папка/Отчёт 2026.txt',
    '100% #1?/file & +.txt', '%2E%2E', '%2E%2E%2Fsecret', '.hidden',
    'a..b/file.txt', 'emoji/😀.txt', 'é/e\u0301.txt',
  ])('preserves valid relative path %j unchanged', path => {
    expect(resourcePathSchema.parse(path)).toBe(path);
    expect(normalizeAndValidatePath(path)).toBe(path);
  });

  it.each([
    '.', '..', './file', '../file', 'a/../b', 'a/./b', 'a/..', 'a/./',
    '/file', '/', '//', 'a//b', 'a//', '\\file', 'a\\b',
    ' file', 'file ', 'a/ file', 'a/file /', 'a/ /b',
    'a\u0000b', 'a\u001fb', 'a\u007fb', 'a\nb', 'a\rb', 'a\tb',
    'a'.repeat(256), 'a/' + 'b'.repeat(256), '\ud800', '\udc00',
  ])('rejects forbidden path %j instead of correcting it', path => {
    expect(resourcePathSchema.safeParse(path).success).toBe(false);
    expect(() => normalizeAndValidatePath(path)).toThrow();
  });

  it('distinguishes file, directory and resource name', () => {
    expect(filePathSchema.parse('a')).toBe('a');
    expect(directoryPathSchema.parse('a/')).toBe('a/');
    expect(filePathSchema.safeParse('a/').success).toBe(false);
    expect(directoryPathSchema.safeParse('a').success).toBe(false);
    expect(resourceNameSchema.parse('Отчёт #1?.pdf')).toBe('Отчёт #1?.pdf');
    expect(resourceNameSchema.safeParse('a/b').success).toBe(false);
    expect(resourceNameSchema.safeParse('a/').success).toBe(false);
    expect(normalizeAndValidatePath('a/', { kind: 'directory' })).toBe('a/');
    expect(() => normalizeAndValidatePath('a/', { kind: 'file' })).toThrow();
  });

  it('allows root only when explicitly requested as a directory or root', () => {
    expect(directoryOrRootPathSchema.parse('')).toBe('');
    expect(normalizeAndValidatePath('', { kind: 'directory-or-root' })).toBe('');
    for (const schema of [resourcePathSchema, filePathSchema, directoryPathSchema, resourceNameSchema]) {
      expect(schema.safeParse('').success).toBe(false);
    }
    expect(() => normalizeAndValidatePath('')).toThrow();
  });

  it.each([undefined, null, 42, {}, []])('rejects missing paths and non-string values', input => {
    expect(directoryOrRootPathSchema.safeParse(input).success).toBe(false);
    expect(() => normalizeAndValidatePath(input)).toThrow();
  });

  it('accepts 255 Unicode code points in a segment', () => {
    expect(resourceNameSchema.parse('a'.repeat(255))).toHaveLength(255);
    const emojiName = '😀'.repeat(255);
    expect(resourceNameSchema.parse(emojiName)).toBe(emojiName);
  });

  it('enforces the 1024-byte path boundary', () => {
    const path = ['a'.repeat(255), 'b'.repeat(255), 'c'.repeat(255), 'd'.repeat(254), 'e'].join('/');
    expect(new TextEncoder().encode(path).byteLength).toBe(1024);
    expect(normalizeAndValidatePath(path)).toBe(path);
    expect(() => normalizeAndValidatePath(path + 'f')).toThrow();
  });

  it('includes the server prefix in the key byte limit without returning it', () => {
    const prefix = 'user-1-files/';
    const path = ['a'.repeat(255), 'b'.repeat(255), 'c'.repeat(255), 'd'.repeat(243)].join('/');
    expect(new TextEncoder().encode(prefix + path).byteLength).toBe(1024);
    expect(normalizeAndValidatePath(path, { keyPrefix: prefix })).toBe(path);
    expect(() => normalizeAndValidatePath(path + 'e', { keyPrefix: prefix })).toThrow();
  });

  it('counts UTF-8 bytes rather than string length', () => {
    const path = ['я'.repeat(255), 'я'.repeat(255)].join('/');
    expect(path.length).toBe(511);
    expect(new TextEncoder().encode(path).byteLength).toBe(1021);
    expect(normalizeAndValidatePath(path)).toBe(path);
    expect(() => normalizeAndValidatePath(path, { keyPrefix: 'user-1-files/' })).toThrow();
  });

  it('does not perform a second URL decoding', () => {
    // Здесь моделируем единственное декодирование, которое выполняет Express.
    const traversal = decodeURIComponent('%2E%2E%2Fsecret');
    expect(() => normalizeAndValidatePath(traversal)).toThrow();
    const literalName = decodeURIComponent('%252E%252E%252Fsecret');
    expect(normalizeAndValidatePath(literalName)).toBe('%2E%2E%2Fsecret');
  });
});
