import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module.js';
import { DirectoryController } from './directory.controller.js';
import { DownloadService } from './download.service.js';
import { ResourceController } from './resource.controller.js';
import { ResourcesService } from './resources.service.js';
import { UploadService } from './upload.service.js';

@Module({
  imports: [StorageModule],
  controllers: [DirectoryController, ResourceController],
  providers: [ResourcesService, UploadService, DownloadService],
})
export class ResourcesModule {}
