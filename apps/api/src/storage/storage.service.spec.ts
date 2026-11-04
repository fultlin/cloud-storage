import { DeleteObjectCommand, DeleteObjectsCommand, HeadBucketCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client, S3ServiceException } from '@aws-sdk/client-s3';
import { BadRequestException, ConflictException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { envSchema } from '../config/env.schema.js';
import { StorageService } from './storage.service.js';

const example = parseEnv(readFileSync(new URL('../../../../.env.example', import.meta.url), 'utf8'));

function s3Error(status: number): S3ServiceException {
  return new S3ServiceException({
    name: status === 404 ? 'NotFound' : 'AccessDenied',
    message: 'Simulated provider detail',
    $fault: 'client',
    $metadata: { httpStatusCode: status },
  });
}

describe('StorageService', () => {
  const send = vi.spyOn(S3Client.prototype, 'send');
  const destroy = vi.spyOn(S3Client.prototype, 'destroy');
  let storage: StorageService;

  beforeEach(() => {
    send.mockReset().mockResolvedValue(undefined);
    destroy.mockClear();
    storage = new StorageService(new ConfigService(envSchema.parse(example)));
  });

  afterEach(() => {
    storage.onModuleDestroy();
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  it('checks the configured bucket without creating it', async () => {
    await storage.onModuleInit();
    expect(send).toHaveBeenCalledExactlyOnceWith(expect.any(HeadBucketCommand));
    expect(send.mock.calls[0][0]).toMatchObject({ input: { Bucket: 'user-files' } });
  });

  it('accepts the explicit root upload destination without touching S3', async () => {
    await expect(storage.validateUploadDestination(1, '')).resolves.toBe('');
    expect(send).not.toHaveBeenCalled();
  });

  it.each([['a', 'a'], ['a', 'b/'], ['a/', 'a/b/a/'], ['a/file', 'b/renamed']])
    ('rejects invalid moves from %s to %s before contacting S3', async (from, to) => {
      await expect(storage.moveResource(1, from, to)).rejects.toThrow(BadRequestException);
      expect(send).not.toHaveBeenCalled();
    });

  it('never deletes source objects when a child copy fails', async () => {
    const failure = new Error('copy failed');
    send.mockImplementationOnce(vi.fn().mockResolvedValue({ ContentLength: 0 }))
      .mockRejectedValueOnce(s3Error(404))
      .mockImplementationOnce(vi.fn().mockResolvedValue({}))
      .mockImplementationOnce(vi.fn().mockResolvedValue({ Contents: [{ Key: 'user-1-files/a/child' }] }))
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(failure);
    await expect(storage.moveResource(1, 'a/', 'b/')).rejects.toBe(failure);
    expect(send).toHaveBeenCalledTimes(6);
    expect(send.mock.calls.some(([command]) => command instanceof DeleteObjectCommand || command instanceof DeleteObjectsCommand)).toBe(false);
  });

  it('rejects a missing upload destination with 400 under the current user prefix', async () => {
    send.mockRejectedValueOnce(s3Error(404));
    await expect(storage.validateUploadDestination(2, 'docs/')).rejects.toThrow(BadRequestException);
    expect(send.mock.calls[0][0].input).toMatchObject({ Key: 'user-2-files/docs/' });
  });

  it.each([undefined, 'docs', '../docs/'])('rejects invalid upload destination %s before S3', async path => {
    await expect(storage.validateUploadDestination(1, path)).rejects.toThrow(BadRequestException);
    expect(send).not.toHaveBeenCalled();
  });

  it('preserves a nested Unicode multipart filename without decoding percent sequences', () => {
    expect(storage.planUploadFile(1, 'docs/', 'Папка/Год/Отчёт %2F.txt')).toEqual({
      path: 'docs/Папка/Год/Отчёт %2F.txt', parent: 'docs/Папка/Год/', name: 'Отчёт %2F.txt',
      directories: ['docs/Папка/', 'docs/Папка/Год/'],
    });
    expect(send).not.toHaveBeenCalled();
  });

  it.each(['', '/file', '../file', 'folder/', 'a\\b'])('rejects invalid multipart filename %s', filename => {
    expect(() => storage.planUploadFile(1, 'docs/', filename)).toThrow(BadRequestException);
  });

  it('checks the full upload key length after joining the destination and filename', () => {
    const directory = ['a', 'b', 'c'].map(letter => letter.repeat(255)).join('/') + '/';
    const filename = 'x'.repeat(255);
    expect(() => storage.planUploadFile(1, directory, filename)).toThrow(BadRequestException);
  });

  it('returns file metadata without downloading its body or exposing the user prefix', async () => {
    send.mockImplementationOnce(vi.fn().mockResolvedValue({ ContentLength: 123 }));
    await expect(storage.getResource(1, 'Документы/Отчёт.txt')).resolves.toEqual({
      path: 'Документы/', name: 'Отчёт.txt', size: 123, type: 'FILE',
    });
    expect(send.mock.calls[0][0]).toBeInstanceOf(HeadObjectCommand);
    expect(send.mock.calls[0][0]).toMatchObject({ input: { Key: 'user-1-files/Документы/Отчёт.txt' } });
  });

  it('returns an empty file size of zero', async () => {
    send.mockImplementationOnce(vi.fn().mockResolvedValue({ ContentLength: 0 }));
    await expect(storage.getResource(2, 'empty')).resolves.toEqual({ path: '', name: 'empty', size: 0, type: 'FILE' });
  });

  it('deletes only the exact key for a file', async () => {
    await storage.deleteResource(1, 'docs');
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][0]).toBeInstanceOf(DeleteObjectCommand);
    expect(send.mock.calls[1][0].input).toMatchObject({ Key: 'user-1-files/docs' });
  });

  it('deletes a large directory page by page and removes its marker last', async () => {
    const prefix = 'user-1-files/docs/';
    const first = Array.from({ length: 1000 }, (_, index) => ({ Key: `${prefix}file-${index}` }));
    const last = { Key: `${prefix}nested/last` };
    send.mockResolvedValueOnce(undefined)
      .mockImplementationOnce(vi.fn((command: unknown) => {
        expect(command).toMatchObject({ input: { Bucket: 'user-files', Prefix: prefix, MaxKeys: 1000, ContinuationToken: undefined } });
        return Promise.resolve({ Contents: first, NextContinuationToken: 'next' });
      }))
      .mockImplementationOnce(vi.fn().mockResolvedValue({}))
      .mockImplementationOnce(vi.fn().mockResolvedValue({ Contents: [{ Key: prefix }, last] }))
      .mockImplementationOnce(vi.fn().mockResolvedValue({}));
    await storage.deleteResource(1, 'docs/');
    expect(send.mock.calls[2][0]).toBeInstanceOf(DeleteObjectsCommand);
    expect(send.mock.calls[2][0].input).toMatchObject({ Delete: { Objects: first } });
    expect(send.mock.calls[3][0].input).toMatchObject({ ContinuationToken: 'next' });
    expect(send.mock.calls[4][0].input).toMatchObject({ Delete: { Objects: [last] } });
    expect(send.mock.calls[5][0]).toBeInstanceOf(DeleteObjectCommand);
    expect(send.mock.calls[5][0].input).toMatchObject({ Key: prefix });
  });

  it('preserves the folder marker when S3 reports a per-key failure', async () => {
    send.mockResolvedValueOnce(undefined)
      .mockImplementationOnce(vi.fn().mockResolvedValue({ Contents: [{ Key: 'user-1-files/docs/file' }] }))
      .mockImplementationOnce(vi.fn().mockResolvedValue({ Errors: [{ Code: 'AccessDenied' }] }));
    await expect(storage.deleteResource(1, 'docs/')).rejects.toThrow('failed to delete');
    expect(send).toHaveBeenCalledTimes(3);
  });

  it('lists every S3 page and keeps a file and directory of the same name', async () => {
    send.mockResolvedValueOnce(undefined)
      .mockImplementationOnce(vi.fn().mockResolvedValue({
        Contents: [{ Key: 'user-1-files/docs/', Size: 0 }, { Key: 'user-1-files/docs/Отчёт', Size: 0 }],
        NextContinuationToken: 'next-page',
      })).mockImplementationOnce(vi.fn().mockResolvedValue({
        CommonPrefixes: [{ Prefix: 'user-1-files/docs/Отчёт/' }],
      }));
    await expect(storage.listDirectory(1, 'docs/')).resolves.toEqual([
      { path: 'docs/', name: 'Отчёт', size: 0, type: 'FILE' },
      { path: 'docs/', name: 'Отчёт', type: 'DIRECTORY' },
    ]);
    expect(send.mock.calls[1][0]).toBeInstanceOf(ListObjectsV2Command);
    expect(send.mock.calls[1][0].input).toMatchObject({ Prefix: 'user-1-files/docs/', Delimiter: '/' });
    expect(send.mock.calls[2][0].input).toMatchObject({ ContinuationToken: 'next-page' });
  });

  it('hides the directory marker size', async () => {
    send.mockImplementationOnce(vi.fn().mockResolvedValue({ ContentLength: 0 }));
    await expect(storage.getResource(1, 'docs/reports/')).resolves.toEqual({
      path: 'docs/', name: 'reports', type: 'DIRECTORY',
    });
  });

  it('maps missing metadata to a public 404', async () => {
    send.mockRejectedValueOnce(s3Error(404));
    await expect(storage.getResource(1, 'missing')).rejects.toMatchObject({
      response: { statusCode: 404, error: 'Not Found', message: 'Resource not found' },
    });
  });

  it('does not disguise access errors as missing resources', async () => {
    const error = s3Error(403);
    send.mockRejectedValueOnce(error);
    await expect(storage.getResource(1, 'secret')).rejects.toBe(error);
  });

  it('rejects invalid metadata rather than inventing a file size', async () => {
    send.mockImplementationOnce(vi.fn().mockResolvedValue({}));
    await expect(storage.getResource(1, 'file')).rejects.toThrow('invalid object size');
  });

  it('blocks startup when the bucket is missing and closes the client', async () => {
    send.mockRejectedValueOnce(s3Error(404));
    await expect(storage.onModuleInit()).rejects.toThrow('Configured S3 bucket does not exist');
    expect(destroy).toHaveBeenCalledOnce();
  });

  it('blocks startup when the bucket cannot be accessed', async () => {
    send.mockRejectedValueOnce(s3Error(403));
    await expect(storage.onModuleInit()).rejects.toThrow('Configured S3 bucket is unavailable');
  });

  it('isolates the same relative path under each user prefix', async () => {
    await expect(storage.resourceExists(1, 'docs/report.txt')).resolves.toBe(true);
    await expect(storage.resourceExists(2, 'docs/report.txt')).resolves.toBe(true);
    expect(send).toHaveBeenNthCalledWith(1, expect.any(HeadObjectCommand));
    expect(send.mock.calls[0][0]).toMatchObject({
      input: { Bucket: 'user-files', Key: 'user-1-files/docs/report.txt' },
    });
    expect(send.mock.calls[1][0]).toMatchObject({
      input: { Bucket: 'user-files', Key: 'user-2-files/docs/report.txt' },
    });
  });

  it.each(['Папка/Отчёт 2026.txt', '100% #1?.txt', '%2E%2E', 'docs/'])
    ('preserves path characters and performs no URL decoding', async path => {
      await storage.resourceExists(42, path);
      expect(send.mock.calls[0][0]).toMatchObject({ input: { Key: `user-42-files/${path}` } });
    });

  it('does not let a supplied prefix replace the current user prefix', async () => {
    await storage.resourceExists(1, 'user-2-files/report.txt');
    expect(send.mock.calls[0][0]).toMatchObject({
      input: { Key: 'user-1-files/user-2-files/report.txt' },
    });
  });

  it.each(['../secret', 'a/../b', '/secret', 'a//b', 'a\\b', '', undefined])
    ('rejects invalid paths before contacting S3', async path => {
      await expect(storage.resourceExists(1, path)).rejects.toThrow(BadRequestException);
      expect(send).not.toHaveBeenCalled();
    });

  it('checks the UTF-8 key limit including the user prefix without leaking it', async () => {
    const path = ['a'.repeat(255), 'b'.repeat(255), 'c'.repeat(255), 'd'.repeat(244)].join('/');
    await expect(storage.resourceExists(1, path)).rejects.toMatchObject({
      response: { statusCode: 400, error: 'Bad Request', message: 'Invalid resource path' },
    });
    expect(send).not.toHaveBeenCalled();
  });

  it.each([0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])
    ('rejects invalid user ids before contacting S3', async userId => {
      await expect(storage.resourceExists(userId, 'report.txt')).rejects.toThrow(UnauthorizedException);
      expect(send).not.toHaveBeenCalled();
    });

  it('returns false only for an S3 404', async () => {
    send.mockRejectedValueOnce(s3Error(404));
    await expect(storage.resourceExists(1, 'missing.txt')).resolves.toBe(false);
  });

  it('does not mistake access denial or a network failure for a missing file', async () => {
    const denied = s3Error(403);
    const networkError = new Error('Connection failed');
    send.mockRejectedValueOnce(denied).mockRejectedValueOnce(networkError);
    await expect(storage.resourceExists(1, 'report.txt')).rejects.toBe(denied);
    await expect(storage.resourceExists(1, 'report.txt')).rejects.toBe(networkError);
  });

  it('creates a zero-byte directory marker under the current user prefix', async () => {
    await storage.createDirectory(42, 'Документы/');
    expect(send).toHaveBeenCalledExactlyOnceWith(expect.any(PutObjectCommand));
    expect(send.mock.calls[0][0]).toMatchObject({ input: {
      Bucket: 'user-files', Key: 'user-42-files/Документы/',
      Body: '', ContentLength: 0, IfNoneMatch: '*',
    } });
  });

  it('maps a concurrent conditional write conflict to 409', async () => {
    send.mockRejectedValueOnce(s3Error(412));
    await expect(storage.createDirectory(42, 'docs/')).rejects.toThrow(ConflictException);
  });

  it.each(['', 'docs', '../docs/', 'a//b/'])('rejects invalid directory paths before writing', async path => {
    await expect(storage.createDirectory(42, path)).rejects.toThrow(BadRequestException);
    expect(send).not.toHaveBeenCalled();
  });

  it('does not turn a storage write failure into a directory conflict', async () => {
    const error = s3Error(403);
    send.mockRejectedValueOnce(error);
    await expect(storage.createDirectory(42, 'docs/')).rejects.toBe(error);
  });
});
