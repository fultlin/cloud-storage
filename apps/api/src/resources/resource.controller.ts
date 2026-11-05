import { fileResourceSchema, listDirectoryQuerySchema, moveResourceQuerySchema, resourceQuerySchema, resourceSchema, searchResourcesQuerySchema, type ListDirectoryQuery, type MoveResourceQuery, type ResourceQuery, type Resource, type SearchResourcesQuery } from '@app/shared';
import { Controller, Delete, Get, HttpCode, Post, Query, Req, Res } from '@nestjs/common';
import { ApiBody, ApiConsumes, ApiCookieAuth, ApiCreatedResponse, ApiNoContentResponse, ApiOkResponse } from '@nestjs/swagger';
import { z } from 'zod';
import { ApiErrors, SESSION_SECURITY } from '../openapi.js';
import type { Request, Response } from 'express';
import { DownloadService } from './download.service.js';
import { CurrentUserId } from '../auth/current-user-id.decorator.js';
import { ResourcesService } from './resources.service.js';
import { UploadService } from './upload.service.js';

@Controller('resource')
@ApiCookieAuth(SESSION_SECURITY)
export class ResourceController {
  constructor(private readonly resources: ResourcesService, private readonly uploads: UploadService, private readonly downloads: DownloadService) {}

  @Get('search')
  @ApiOkResponse({ standardSchema: z.array(resourceSchema) })
  @ApiErrors(400, 401, 500)
  search(
    @CurrentUserId() userId: number,
    @Query({ schema: searchResourcesQuerySchema }) query: SearchResourcesQuery,
  ): Promise<Resource[]> {
    return this.resources.searchResources(userId, query.query);
  }

  @Get('download')
  @ApiOkResponse({
    description: 'File or ZIP archive',
    content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } },
    headers: { 'Content-Disposition': { schema: { type: 'string' }, description: 'Attachment filename' } },
  })
  @ApiErrors(400, 401, 404, 500)
  download(
    @CurrentUserId() userId: number,
    @Query({ schema: resourceQuerySchema }) query: ResourceQuery,
    @Res() response: Response,
  ): Promise<void> {
    return this.downloads.download(userId, query.path, response);
  }

  @Post('move')
  @ApiOkResponse({ standardSchema: resourceSchema })
  @ApiErrors(400, 401, 404, 409, 500)
  @HttpCode(200)
  move(
    @CurrentUserId() userId: number,
    @Query({ schema: moveResourceQuerySchema }) query: MoveResourceQuery,
  ): Promise<Resource> {
    return this.resources.moveResource(userId, query.from, query.to);
  }

  @Post()
  @ApiConsumes('multipart/form-data')
  @ApiBody({ required: true, schema: { type: 'object', required: ['files'], properties: {
    files: { type: 'array', minItems: 1, items: { type: 'string', format: 'binary' } },
  } } })
  @ApiCreatedResponse({ standardSchema: z.array(fileResourceSchema) })
  @ApiErrors(400, 401, 409, 500)
  upload(@CurrentUserId() userId: number, @Query({ schema: listDirectoryQuerySchema }) query: ListDirectoryQuery, @Req() request: Request): Promise<Resource[]> {
    return this.uploads.upload(userId, query.path, request);
  }

  @Delete()
  @ApiNoContentResponse({ description: 'Resource deleted' })
  @ApiErrors(400, 401, 404, 500)
  @HttpCode(204)
  remove(
    @CurrentUserId() userId: number,
    @Query({ schema: resourceQuerySchema }) query: ResourceQuery,
  ): Promise<void> {
    return this.resources.deleteResource(userId, query.path);
  }

  @Get()
  @ApiOkResponse({ standardSchema: resourceSchema })
  @ApiErrors(400, 401, 404, 500)
  get(
    @CurrentUserId() userId: number,
    @Query({ schema: resourceQuerySchema }) query: ResourceQuery,
  ): Promise<Resource> {
    return this.resources.getResource(userId, query.path);
  }
}
