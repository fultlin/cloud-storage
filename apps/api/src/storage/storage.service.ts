import { normalizeAndValidatePath, type Resource, type PathValidationOptions } from '@app/shared';
import { Upload } from '@aws-sdk/lib-storage';
import { CopyObjectCommand, DeleteObjectCommand, DeleteObjectsCommand, GetObjectCommand, HeadBucketCommand, HeadObjectCommand, ListObjectsV2Command, paginateListObjectsV2, PutObjectCommand, S3Client, S3ServiceException } from '@aws-sdk/client-s3';
import { BadRequestException, ConflictException, Injectable, NotFoundException, UnauthorizedException, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ZodError } from 'zod';
import type { Env } from '../config/env.schema.js';

function splitResourcePath(path: string) {
  const fullName = path.endsWith('/') ? path.slice(0, -1) : path;
  const separator = fullName.lastIndexOf('/');
  return { path: fullName.slice(0, separator + 1), name: fullName.slice(separator + 1) };
}

@Injectable()
export class StorageService implements OnModuleInit, OnModuleDestroy {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly maxFileSize: number;

  constructor(config: ConfigService<Env, true>) {
    this.bucket = config.get('S3_BUCKET', { infer: true });
    this.maxFileSize = config.get('UPLOAD_MAX_FILE_SIZE_BYTES', { infer: true });
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

  async validateUploadDestination(userId: number, path: unknown): Promise<string> {
    const directory = this.validateRelativePath(userId, path, 'directory-or-root');
    if (directory !== '' && !(await this.resourceExists(userId, directory))) {
      throw new BadRequestException('Upload directory does not exist');
    }
    return directory;
  }

  planUploadFile(userId: number, destination: string, filename: unknown) {
    const directory = this.validateRelativePath(userId, destination, 'directory-or-root');
    // Проверяем имя отдельно: префикс назначения не должен скрыть ведущий слеш или пустое имя.
    const relativeFile = this.validateRelativePath(userId, filename, 'file');
    const path = this.validateRelativePath(userId, directory + relativeFile, 'file');
    const separator = relativeFile.lastIndexOf('/');
    const name = relativeFile.slice(separator + 1);
    const directories: string[] = [];
    let parent = directory;
    if (separator !== -1) {
      for (const segment of relativeFile.slice(0, separator).split('/')) {
        parent += `${segment}/`;
        directories.push(parent);
      }
    }
    return { path, parent, name, directories };
  }

  async uploadFile(userId: number, path: string, source: Readable): Promise<number> {
    const key = this.buildKey(userId, path, 'file');
    let size = 0;
    const limit = this.maxFileSize;
    const body = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        size += chunk.byteLength;
        if (size > limit) callback(new BadRequestException('File exceeds the upload size limit'));
        else callback(null, chunk);
      },
    });
    const upload = new Upload({
      client: this.client,
      params: { Bucket: this.bucket, Key: key, Body: body, IfNoneMatch: '*' },
      queueSize: 1,
      partSize: 5 * 1024 ** 2,
      leavePartsOnError: false,
    });
    const sending = upload.done().catch((error: unknown) => {
      body.destroy();
      throw error;
    });
    // Ждём завершения SDK: при ошибке потока он сам убирает незавершённые части.
    const [pumping, writing] = await Promise.allSettled([pipeline(source, body), sending]);
    if (writing.status === 'rejected') {
      const error: unknown = writing.reason;
      if (error instanceof S3ServiceException && error.$metadata.httpStatusCode === 412) {
        throw new ConflictException('File already exists');
      }
      if (pumping.status === 'rejected' && pumping.reason instanceof BadRequestException) throw pumping.reason;
      throw error;
    }
    return size;
  }

  async rollbackUploadObject(userId: number, path: string): Promise<void> {
    const key = this.buildKey(userId, path);
    // Другой запрос мог заполнить созданную нами папку. Не удаляем её содержимое.
    if (path.endsWith('/') && (await this.listDirectory(userId, path)).length) return;
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async moveResource(userId: number, from: string, to: string): Promise<Resource> {
    const source = this.buildKey(userId, from);
    const target = this.buildKey(userId, to);
    const directory = from.endsWith('/');
    const origin = splitResourcePath(from);
    const destination = splitResourcePath(to);
    if (from === to || directory !== to.endsWith('/') || (directory && to.startsWith(from)) ||
      (origin.path !== destination.path && origin.name !== destination.name)) {
      throw new BadRequestException('Invalid move paths');
    }
    const resource = await this.getResource(userId, from);
    if (destination.path && !(await this.resourceExists(userId, destination.path))) {
      throw new NotFoundException('Destination directory does not exist');
    }
    if (await this.resourceExists(userId, to)) throw new ConflictException('Destination already exists');

    const copies = [{ source, target }];
    if (directory) {
      // An orphaned subtree also occupies the destination, even without a marker.
      const occupied = await this.client.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: target, MaxKeys: 1 }));
      if (occupied.Contents?.length) throw new ConflictException('Destination already exists');
      const pages = paginateListObjectsV2({ client: this.client }, { Bucket: this.bucket, Prefix: source });
      for await (const page of pages) {
        for (const { Key } of page.Contents ?? []) {
          if (!Key?.startsWith(source)) throw new Error('S3 returned an invalid object key for move');
          if (Key === source) continue;
          const suffix = Key.slice(source.length);
          copies.push({ source: Key, target: this.buildKey(userId, to + suffix) });
        }
      }
    }

    for (const copy of copies) {
      try {
        if (copy.source.endsWith('/')) {
          // SeaweedFS exposes directory markers via HEAD but cannot copy them via CopyObject.
          await this.client.send(new PutObjectCommand({
            Bucket: this.bucket, Key: copy.target, Body: '', ContentLength: 0, IfNoneMatch: '*',
          }));
        } else {
          await this.client.send(new CopyObjectCommand({
            Bucket: this.bucket, Key: copy.target, IfNoneMatch: '*',
            CopySource: `${this.bucket}/${copy.source.split('/').map(encodeURIComponent).join('/')}`,
          }));
        }
      } catch (error: unknown) {
        if (error instanceof S3ServiceException && [409, 412].includes(error.$metadata.httpStatusCode ?? 0)) {
          throw new ConflictException('Destination already exists');
        }
        throw error;
      }
    }
    // SeaweedFS can only remove a directory marker once its children are gone.
    const files = copies.slice(1).filter(copy => !copy.source.endsWith('/'));
    for (let offset = 0; offset < files.length; offset += 1000) {
      await this.deleteBatch(files.slice(offset, offset + 1000).map(copy => ({ Key: copy.source })));
    }
    const markers = copies.filter(copy => copy.source.endsWith('/')).sort((a, b) => b.source.length - a.source.length);
    for (const { source: marker } of markers) {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: marker }));
    }
    if (!directory) await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: source }));
    return { ...resource, ...destination };
  }

  private async deleteBatch(objects: { Key: string }[]): Promise<void> {
    const result = await this.client.send(new DeleteObjectsCommand({
      Bucket: this.bucket, Delete: { Objects: objects, Quiet: true },
    }));
    if (result.Errors?.length) throw new Error('S3 failed to delete one or more directory objects');
  }

  async deleteResource(userId: number, path: string): Promise<void> {
    const key = this.buildKey(userId, path);
    if (!(await this.resourceExists(userId, path))) throw new NotFoundException('Resource not found');

    if (path.endsWith('/')) {
      // Без Delimiter S3 отдаёт все уровни. Одна страница помещается в одну пачку удаления.
      const pages = paginateListObjectsV2({ client: this.client, pageSize: 1000 }, {
        Bucket: this.bucket, Prefix: key,
      });
      for await (const page of pages) {
        const objects = [];
        for (const { Key } of page.Contents ?? []) {
          if (!Key?.startsWith(key)) throw new Error('S3 returned an invalid object key for deletion');
          if (Key !== key) objects.push({ Key });
        }
        if (objects.length) await this.deleteBatch(objects);
      }
    }
    // Маркер самой папки удаляем последним, чтобы после сбоя можно было повторить запрос.
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async searchResources(userId: number, query: string): Promise<Resource[]> {
    const prefix = this.buildKey(userId, '', 'directory-or-root');
    const needle = query.toLowerCase();
    const directories = new Set<string>();
    const matches: { key: string; resource: Resource }[] = [];
    const pages = paginateListObjectsV2({ client: this.client }, { Bucket: this.bucket, Prefix: prefix });
    for await (const page of pages) {
      for (const { Key, Size } of page.Contents ?? []) {
        if (Key === prefix) continue;
        if (!Key?.startsWith(prefix)) throw new Error('S3 returned an invalid search result key');
        const relative = Key.slice(prefix.length);
        const location = splitResourcePath(relative);
        const marker = relative.endsWith('/');
        if (!marker && location.name.toLowerCase().includes(needle)) {
          matches.push({ key: relative, resource: { ...location, type: 'FILE', size: this.requireSize(Size) } });
        }
        let directory = marker ? relative : location.path;
        while (directory && !directories.has(directory)) {
          directories.add(directory);
          const parent = splitResourcePath(directory);
          if (parent.name.toLowerCase().includes(needle)) {
            matches.push({ key: directory, resource: { ...parent, type: 'DIRECTORY' } });
          }
          directory = parent.path;
        }
      }
    }
    return matches.sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0).map(match => match.resource);
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
    const location = splitResourcePath(path);
    if (directory) return { ...location, type: 'DIRECTORY' };
    return { ...location, size: this.requireSize(size), type: 'FILE' };
  }

  async openFile(userId: number, path: string, signal: AbortSignal): Promise<Readable> {
    const key = this.buildKey(userId, path, 'file');
    try {
      const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }), { abortSignal: signal });
      if (!(result.Body instanceof Readable)) throw new Error('S3 returned no readable file body');
      return result.Body;
    } catch (error: unknown) {
      if (error instanceof S3ServiceException && error.$metadata.httpStatusCode === 404) {
        throw new NotFoundException('Resource not found');
      }
      throw error;
    }
  }

  async *downloadEntries(userId: number, path: string, signal: AbortSignal): AsyncGenerator<string> {
    const prefix = this.buildKey(userId, path, 'directory');
    const pages = paginateListObjectsV2({ client: this.client }, { Bucket: this.bucket, Prefix: prefix }, { abortSignal: signal });
    for await (const page of pages) {
      for (const { Key } of page.Contents ?? []) {
        signal.throwIfAborted();
        if (Key === prefix) continue;
        if (!Key?.startsWith(prefix)) throw new Error('S3 returned an invalid archive entry key');
        yield normalizeAndValidatePath(Key.slice(prefix.length));
      }
    }
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
    return this.userPrefix(userId) + this.validateRelativePath(userId, input, kind);
  }

  private userPrefix(userId: number): string {
    if (!Number.isSafeInteger(userId) || userId <= 0) throw new UnauthorizedException('Unauthorized');
    return `user-${userId}-files/`;
  }

  private validateRelativePath(userId: number, input: unknown, kind: PathValidationOptions['kind']): string {
    const keyPrefix = this.userPrefix(userId);
    try {
      return normalizeAndValidatePath(input, { kind, keyPrefix });
    } catch (error: unknown) {
      // Не раскрываем клиенту внутренний префикс и подробности Zod.
      if (error instanceof ZodError) throw new BadRequestException('Invalid resource path');
      throw error;
    }
  }
}
