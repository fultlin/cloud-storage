import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module.js';
import { DirectoryController } from './directory.controller.js';
import { ResourcesService } from './resources.service.js';

@Module({
  imports: [StorageModule],
  controllers: [DirectoryController],
  providers: [ResourcesService],
})
export class ResourcesModule {}
