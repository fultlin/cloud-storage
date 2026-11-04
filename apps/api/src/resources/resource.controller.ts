import { resourceQuerySchema, type ResourceQuery, type Resource } from '@app/shared';
import { Controller, Delete, Get, HttpCode, Query } from '@nestjs/common';
import { CurrentUserId } from '../auth/current-user-id.decorator.js';
import { ResourcesService } from './resources.service.js';

@Controller('resource')
export class ResourceController {
  constructor(private readonly resources: ResourcesService) {}

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
