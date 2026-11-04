import type { DirectoryResource, Resource } from '@app/shared';
import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { StorageService } from '../storage/storage.service.js';

@Injectable()
export class ResourcesService {
  constructor(private readonly storage: StorageService) {}

  deleteResource(userId: number, path: string): Promise<void> {
    return this.storage.deleteResource(userId, path);
  }

  listDirectory(userId: number, path: string): Promise<Resource[]> {
    return this.storage.listDirectory(userId, path);
  }

  getResource(userId: number, path: string): Promise<Resource> {
    return this.storage.getResource(userId, path);
  }

  async createDirectory(userId: number, path: string): Promise<DirectoryResource> {
    // resourceExists валидирует весь путь и длину ключа до обращения к S3.
    if (await this.storage.resourceExists(userId, path)) {
      throw new ConflictException('Directory already exists');
    }
    const withoutTrailingSlash = path.slice(0, -1);
    const separator = withoutTrailingSlash.lastIndexOf('/');
    const parent = withoutTrailingSlash.slice(0, separator + 1);
    const name = withoutTrailingSlash.slice(separator + 1);
    // Корень пользователя существует всегда; для остальных папок проверяем существование.
    if (parent !== '' && !(await this.storage.resourceExists(userId, parent))) {
      throw new NotFoundException('Parent directory does not exist');
    }
    await this.storage.createDirectory(userId, path);
    return { path: parent, name, type: 'DIRECTORY' };
  }
}
