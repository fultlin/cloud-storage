import { normalizeAndValidatePath, type Resource, type PathValidationOptions } from '@app/shared';
import { HeadBucketCommand, HeadObjectCommand, paginateListObjectsV2, PutObjectCommand, S3Client, S3ServiceException } from '@aws-sdk/client-s3';
import { BadRequestException, ConflictException, Injectable, NotFoundException, UnauthorizedException, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ZodError } from 'zod';
import type { Env } from '../config/env.schema.js';

@Injectable()
export class StorageService implements OnModuleInit, OnModuleDestroy {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(config: ConfigService<Env, true>) {
    this.bucket = config.get('S3_BUCKET', { infer: true });
    this.client = new S3Client({
      endpoint: config.get('S3_ENDPOINT', { infer: true }),
      region: config.get('S3_REGION', { infer: true }),
      credentials: {
        accessKeyId: config.get('S3_ACCESS_KEY_ID', { infer: true }),
        secretAccessKey: config.get('S3_SECRET_ACCESS_KEY', { infer: true }),
      },
      forcePathStyle: config.get('S3_FORCE_PATH_STYLE', { infer: true }),
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  }

  async onModuleInit(): Promise<void> {
    try {
      // Бакет создаётся административной командой, а не API-приложением.
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch (error: unknown) {
      this.client.destroy();
      const missing = error instanceof S3ServiceException && error.$metadata.httpStatusCode === 404;
      throw new Error(missing
        ? 'Configured S3 bucket does not exist. Create it before starting the API.'
        : 'Configured S3 bucket is unavailable. Check the endpoint, credentials and permissions.',
      { cause: error });
    }
  }

  async resourceExists(userId: number, path: unknown): Promise<boolean> {
    const key = this.buildKey(userId, path);
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch (error: unknown) {
      // HeadObject часто возвращает 404 без тела. Остальные ошибки не означают отсутствие объекта.
      if (error instanceof S3ServiceException && error.$metadata.httpStatusCode === 404) return false;
      throw error;
    }
  }

  async listDirectory(userId: number, path: string): Promise<Resource[]> {
    const prefix = this.buildKey(userId, path, 'directory-or-root');
    if (path !== '' && !(await this.resourceExists(userId, path))) {
      throw new NotFoundException('Directory does not exist');
    }

    const children: Resource[] = [];
    const pages = paginateListObjectsV2({ client: this.client }, {
      Bucket: this.bucket, Prefix: prefix, Delimiter: '/',
    });
    for await (const page of pages) {
      for (const { Key, Size } of page.Contents ?? []) {
        if (Key === prefix) continue; // Маркер самой папки не является её содержимым.
        const name = Key?.startsWith(prefix) ? Key.slice(prefix.length) : '';
        if (!name || name.includes('/')) throw new Error('S3 returned an invalid child object key');
        children.push({ path, name, size: this.requireSize(Size), type: 'FILE' });
      }
      for (const { Prefix } of page.CommonPrefixes ?? []) {
        const name = Prefix?.startsWith(prefix) && Prefix.endsWith('/') ? Prefix.slice(prefix.length, -1) : '';
        if (!name || name.includes('/')) throw new Error('S3 returned an invalid child prefix');
        children.push({ path, name, type: 'DIRECTORY' });
      }
    }
    return children;
  }

  async getResource(userId: number, path: string): Promise<Resource> {
    const key = this.buildKey(userId, path);
    let size: number | undefined;
    try {
      const metadata = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      size = metadata.ContentLength;
    } catch (error: unknown) {
      if (error instanceof S3ServiceException && error.$metadata.httpStatusCode === 404) {
        throw new NotFoundException('Resource not found');
      }
      throw error;
    }
    // Маркер папки остаётся деталью хранилища; его размер не попадает в ответ.
    const directory = path.endsWith('/');
    const fullName = directory ? path.slice(0, -1) : path;
    const separator = fullName.lastIndexOf('/');
    const location = { path: fullName.slice(0, separator + 1), name: fullName.slice(separator + 1) };
    if (directory) return { ...location, type: 'DIRECTORY' };
    return { ...location, size: this.requireSize(size), type: 'FILE' };
  }

  private requireSize(size: number | undefined): number {
    if (size === undefined || !Number.isSafeInteger(size) || size < 0) {
      throw new Error('S3 returned an invalid object size');
    }
    return size;
  }

  onModuleDestroy(): void {
    this.client.destroy();
  }

  async createDirectory(userId: number, path: string): Promise<void> {
    const key = this.buildKey(userId, path, 'directory');
    try {
      await this.client.send(new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: '',
        ContentLength: 0,
        // Проверка на стороне S3 закрывает гонку между предварительной проверкой и записью.
        IfNoneMatch: '*',
      }));
    } catch (error: unknown) {
      if (error instanceof S3ServiceException && error.$metadata.httpStatusCode === 412) {
        throw new ConflictException('Directory already exists');
      }
      throw error;
    }
  }

  private buildKey(userId: number, input: unknown, kind: PathValidationOptions['kind'] = 'resource'): string {
    if (!Number.isSafeInteger(userId) || userId <= 0) throw new UnauthorizedException('Unauthorized');
    const prefix = `user-${userId}-files/`;
    try {
      const path = normalizeAndValidatePath(input, { kind, keyPrefix: prefix });
      return prefix + path;
    } catch (error: unknown) {
      // Не раскрываем клиенту внутренний префикс и подробности Zod.
      if (error instanceof ZodError) throw new BadRequestException('Invalid resource path');
      throw error;
    }
  }
}
