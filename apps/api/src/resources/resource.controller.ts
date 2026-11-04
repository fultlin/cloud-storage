import { moveResourceQuerySchema, resourceQuerySchema, type MoveResourceQuery, type ResourceQuery, type Resource } from '@app/shared';
import { Controller, Delete, Get, HttpCode, Post, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { DownloadService } from './download.service.js';
import { CurrentUserId } from '../auth/current-user-id.decorator.js';
import { ResourcesService } from './resources.service.js';
import { UploadService } from './upload.service.js';

@Controller('resource')
export class ResourceController {
  constructor(private readonly resources: ResourcesService, private readonly uploads: UploadService, private readonly downloads: DownloadService) {}

  @Get('download')
  download(
    @CurrentUserId() userId: number,
    @Query({ schema: resourceQuerySchema }) query: ResourceQuery,
    @Res() response: Response,
  ): Promise<void> {
    return this.downloads.download(userId, query.path, response);
  }

  @Post('move')
  @HttpCode(200)
  move(
    @CurrentUserId() userId: number,
    @Query({ schema: moveResourceQuerySchema }) query: MoveResourceQuery,
  ): Promise<Resource> {
    return this.resources.moveResource(userId, query.from, query.to);
  }

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
