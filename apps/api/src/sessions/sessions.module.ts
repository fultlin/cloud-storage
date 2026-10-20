import { Module } from '@nestjs/common';
import { SessionsService } from './sessions.service.js';

@Module({
  providers: [SessionsService],
  exports: [SessionsService],
})
export class SessionsModule {}
