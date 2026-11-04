import { createDirectoryQuerySchema, listDirectoryQuerySchema, type CreateDirectoryQuery, type DirectoryResource, type ListDirectoryQuery, type Resource } from '@app/shared';
import { Controller, Get, Post, Query } from '@nestjs/common';
import { CurrentUserId } from '../auth/current-user-id.decorator.js';
import { ResourcesService } from './resources.service.js';

@Controller('directory')
export class DirectoryController {
  constructor(private readonly resources: ResourcesService) {}

  @Get()
  list(
    @CurrentUserId() userId: number,
    @Query({ schema: listDirectoryQuerySchema }) query: ListDirectoryQuery,
  ): Promise<Resource[]> {
    return this.resources.listDirectory(userId, query.path);
  }

  @Post()
  create(
    @CurrentUserId() userId: number,
    @Query({ schema: createDirectoryQuerySchema }) query: CreateDirectoryQuery,
  ): Promise<DirectoryResource> {
    return this.resources.createDirectory(userId, query.path);
  }
}
