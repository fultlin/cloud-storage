import { resourceQuerySchema, type ResourceQuery, type Resource } from '@app/shared';
import { Controller, Delete, Get, HttpCode, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { CurrentUserId } from '../auth/current-user-id.decorator.js';
import { ResourcesService } from './resources.service.js';
import { UploadService } from './upload.service.js';

@Controller('resource')
export class ResourceController {
  constructor(private readonly resources: ResourcesService, private readonly uploads: UploadService) {}

  @Post()
  upload(@CurrentUserId() userId: number, @Query('path') path: unknown, @Req() request: Request): Promise<Resource[]> {
    return this.uploads.upload(userId, path, request);
  }

  @Delete()
  @HttpCode(204)
  remove(
    @CurrentUserId() userId: number,
    @Query({ schema: resourceQuerySchema }) query: ResourceQuery,
  ): Promise<void> {
    return this.resources.deleteResource(userId, query.path);
  }

  @Get()
  get(
    @CurrentUserId() userId: number,
    @Query({ schema: resourceQuerySchema }) query: ResourceQuery,
  ): Promise<Resource> {
    return this.resources.getResource(userId, query.path);
  }
}
