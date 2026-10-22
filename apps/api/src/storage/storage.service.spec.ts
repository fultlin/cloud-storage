import { HeadBucketCommand, HeadObjectCommand, PutObjectCommand, S3Client, S3ServiceException } from '@aws-sdk/client-s3';
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
