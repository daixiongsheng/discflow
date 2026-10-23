import { Module } from '@nestjs/common';
import { BurnJobsController } from './burn-jobs.controller';
import { BurnJobsService } from './burn-jobs.service';
import { Imapi2RunnerService } from './imapi2-runner.service';

@Module({
  controllers: [BurnJobsController],
  providers: [BurnJobsService, Imapi2RunnerService],
})
export class BurnJobsModule {}

