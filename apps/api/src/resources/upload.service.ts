import type { Resource } from '@app/shared';
import { BadRequestException, ConflictException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import busboy from 'busboy';
import type { Request } from 'express';
import type { Env } from '../config/env.schema.js';
import { StorageService } from '../storage/storage.service.js';

@Injectable()
export class UploadService {
  private readonly logger = new Logger(UploadService.name);

  constructor(private readonly storage: StorageService, private readonly config: ConfigService<Env, true>) {}

  async upload(userId: number, input: unknown, request: Request): Promise<Resource[]> {
    const destination = await this.storage.validateUploadDestination(userId, input);
    let parser: ReturnType<typeof busboy>;
    try {
      parser = busboy({
        headers: request.headers,
        preservePath: true,
        defParamCharset: 'utf8',
        limits: {
          files: this.config.get('UPLOAD_MAX_FILES', { infer: true }),
          // Busboy emits limit at equality. The configured size itself is allowed.
          fileSize: this.config.get('UPLOAD_MAX_FILE_SIZE_BYTES', { infer: true }) + 1,
          fields: 0,
        },
      });
    } catch {
      throw new BadRequestException('Expected multipart/form-data');
    }
    if (!request.is('multipart/form-data') || request.destroyed) {
      parser.destroy();
      throw new BadRequestException('Expected multipart/form-data');
    }

    const seen = new Set<string>();
    const created: string[] = [];
    const files: Resource[] = [];
    let failure: { error: unknown } | undefined;
    let work = Promise.resolve();
    const fail = (error: unknown): void => {
      if (failure) return;
      failure = { error };
      request.unpipe(parser);
      if (!parser.destroyed) parser.destroy();
      // Drain the request rather than destroy its socket: the client still needs the HTTP error.
      request.resume();
    };
    const abort = () => fail(new BadRequestException('Upload was interrupted'));
    const parsed = new Promise<void>(resolve => parser.once('close', resolve));
    parser.on('error', () => fail(new BadRequestException('Malformed multipart body')));
    parser.on('fieldsLimit', () => fail(new BadRequestException('Only the files field is allowed')));
    parser.on('filesLimit', () => fail(new BadRequestException('Too many files')));
    request.once('aborted', abort);
    request.once('error', abort);
    parser.on('file', (field, file, info) => {
      // Destroying the parser can also destroy queued files before pipeline attaches.
      file.on('error', () => {});
      file.once('limit', () => fail(new BadRequestException('File exceeds the upload size limit')));
      if (field !== 'files') {
        fail(new BadRequestException('Only the files field is allowed'));
        return;
      }
      work = work.then(async () => {
        if (failure) return;
        const plan = this.storage.planUploadFile(userId, destination, info.filename);
        if (seen.has(plan.path) || await this.storage.resourceExists(userId, plan.path)) {
          throw new ConflictException('File already exists');
        }
        seen.add(plan.path);
        for (const directory of plan.directories) {
          if (failure) return;
          if (await this.storage.resourceExists(userId, directory)) continue;
          try {
            await this.storage.createDirectory(userId, directory);
            created.push(directory);
          } catch (error: unknown) {
            if (!(error instanceof ConflictException)) throw error;
          }
        }
        if (failure) return;
        const size = await this.storage.uploadFile(userId, plan.path, file);
        created.push(plan.path);
        files.push({ path: plan.parent, name: plan.name, size, type: 'FILE' });
      }).catch(fail);
    });

    try {
      request.pipe(parser);
      await parsed;
      await work;
      if (failure) throw failure.error;
      if (!files.length) throw new BadRequestException('At least one file is required');
      return files;
    } catch (error: unknown) {
      let rollbackFailed = false;
      for (const path of created.reverse()) {
        try {
          await this.storage.rollbackUploadObject(userId, path);
        } catch (rollbackError: unknown) {
          rollbackFailed = true;
          this.logger.error('Failed to roll back upload object', rollbackError);
        }
      }
      if (rollbackFailed) throw new Error('Upload rollback failed', { cause: error });
      throw error;
    } finally {
      request.off('aborted', abort);
      request.off('error', abort);
    }
  }
}
