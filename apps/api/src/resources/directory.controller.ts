import { createDirectoryQuerySchema, type CreateDirectoryQuery, type DirectoryResource } from '@app/shared';
import { Controller, Post, Query } from '@nestjs/common';
import { CurrentUserId } from '../auth/current-user-id.decorator.js';
import { ResourcesService } from './resources.service.js';

@Controller('directory')
export class DirectoryController {
  constructor(private readonly resources: ResourcesService) {}

  @Post()
  create(
    @CurrentUserId() userId: number,
    @Query({ schema: createDirectoryQuerySchema }) query: CreateDirectoryQuery,
  ): Promise<DirectoryResource> {
    return this.resources.createDirectory(userId, query.path);
  }
}
