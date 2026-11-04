import { Injectable, Logger } from '@nestjs/common';
import archiver from 'archiver';
import type { Response } from 'express';
import { once } from 'node:events';
import { addAbortSignal, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { StorageService } from '../storage/storage.service.js';
import { contentDisposition } from './content-disposition.js';

@Injectable()
export class DownloadService {
  private readonly logger = new Logger(DownloadService.name);

  constructor(private readonly storage: StorageService) {}

  async download(userId: number, path: string, response: Response): Promise<void> {
    const cancellation = new AbortController();
    const { signal } = cancellation;
    const onClose = () => { if (!response.writableFinished) cancellation.abort(); };
    response.once('close', onClose);
    try {
      const resource = await this.storage.getResource(userId, path);
      signal.throwIfAborted();
      const isDirectory = resource.type === 'DIRECTORY';
      const body = isDirectory ? undefined : await this.storage.openFile(userId, path, signal);
      response.status(200).set({
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': contentDisposition(isDirectory ? `${resource.name}.zip` : resource.name),
      });
      if (body) await pipeline(body, response, { signal });
      else await this.zip(userId, path, response, cancellation);
    } catch (error: unknown) {
      if (!response.headersSent && !response.destroyed) {
        response.removeHeader('Content-Disposition');
        response.removeHeader('Content-Type');
        throw error;
      }
      this.logger.warn('Download stream ended before completion', error);
      response.destroy();
    } finally {
      response.off('close', onClose);
    }
  }

  private async zip(userId: number, path: string, response: Response, cancellation: AbortController): Promise<void> {
    const { signal } = cancellation;
    const archive = archiver('zip', { zlib: { level: 1 } });
    let current: Readable | undefined;
    const writing = pipeline(archive, response, { signal });
    const entries = async () => {
      for await (const name of this.storage.downloadEntries(userId, path, signal)) {
        const folder = name.endsWith('/');
        current = folder ? undefined : addAbortSignal(signal, await this.storage.openFile(userId, path + name, signal));
        const fail = (error: Error) => archive.destroy(error);
        current?.once('error', fail);
        const entry = once(archive, 'entry', { signal });
        archive.append(current ?? '', { name });
        try {
          // Only open the next S3 stream after Archiver has consumed this one.
          await entry;
        } finally {
          current?.off('error', fail);
        }
        current = undefined;
      }
      await archive.finalize();
    };
    try {
      await Promise.all([writing, entries()]);
    } catch (error: unknown) {
      cancellation.abort();
      current?.destroy();
      archive.abort();
      archive.destroy();
      throw error;
    }
  }
}
