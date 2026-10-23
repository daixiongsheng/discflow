import { Module } from '@nestjs/common';
import { BurnJobsModule } from './burn-jobs/burn-jobs.module';

@Module({
  imports: [BurnJobsModule],
})
export class AppModule {}

