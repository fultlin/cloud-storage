import { createDirectoryQuerySchema, listDirectoryQuerySchema, type CreateDirectoryQuery, type DirectoryResource, type ListDirectoryQuery, type Resource } from '@app/shared';
import { Controller, Get, Post, Query } from '@nestjs/common';
import { ApiCookieAuth, ApiCreatedResponse, ApiOkResponse } from '@nestjs/swagger';
import { directoryResourceSchema, resourceSchema } from '@app/shared';
import { z } from 'zod';
import { ApiErrors, SESSION_SECURITY } from '../openapi.js';
import { CurrentUserId } from '../auth/current-user-id.decorator.js';
import { ResourcesService } from './resources.service.js';

@Controller('directory')
@ApiCookieAuth(SESSION_SECURITY)
export class DirectoryController {
  constructor(private readonly resources: ResourcesService) {}

  @Get()
  @ApiOkResponse({ standardSchema: z.array(resourceSchema) })
  @ApiErrors(400, 401, 404, 500)
  list(
    @CurrentUserId() userId: number,
    @Query({ schema: listDirectoryQuerySchema }) query: ListDirectoryQuery,
  ): Promise<Resource[]> {
    return this.resources.listDirectory(userId, query.path);
  }

  @Post()
  @ApiCreatedResponse({ standardSchema: directoryResourceSchema })
  @ApiErrors(400, 401, 404, 409, 500)
  create(
    @CurrentUserId() userId: number,
    @Query({ schema: createDirectoryQuerySchema }) query: CreateDirectoryQuery,
  ): Promise<DirectoryResource> {
    return this.resources.createDirectory(userId, query.path);
  }
}
