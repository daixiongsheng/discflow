import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Sse,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import { extname } from 'node:path';
import { interval, map, merge, Observable } from 'rxjs';
import { BurnJobsService } from './burn-jobs.service';
import { BurnMode, BurnSnapshot } from './burn-job.types';
import { ensureStorageDirectories, incomingRoot } from './paths';

type UploadBody = {
  mode?: string;
  discName?: string;
  relativePaths?: string;
};

const maxUploadBytes = Number(
  process.env.MAX_UPLOAD_BYTES ?? 8 * 1024 * 1024 * 1024,
);

@Controller('api')
export class BurnJobsController {
  constructor(private readonly jobs: BurnJobsService) {}

  @Get('health')
  health() {
    return {
      ok: true,
      ...this.jobs.getSnapshot(),
    };
  }

  @Get('jobs')
  listJobs() {
    return this.jobs.getSnapshot();
  }

  @Get('jobs/:id')
  getJob(@Param('id') id: string) {
    return this.jobs.getJob(id);
  }

  @Post('jobs')
  @UseInterceptors(
    FilesInterceptor('files', 500, {
      storage: diskStorage({
        destination: (_request, _file, callback) => {
          ensureStorageDirectories();
          callback(null, incomingRoot());
        },
        filename: (_request, file, callback) => {
          const extension = extname(file.originalname).slice(0, 20);
          callback(null, `${randomUUID()}${extension}`);
        },
      }),
      limits: {
        fileSize: maxUploadBytes,
        files: 500,
      },
    }),
  )
  async createJob(
    @UploadedFiles() files: Express.Multer.File[] | undefined,
    @Body() body: UploadBody,
  ) {
    try {
      if (!files?.length) {
        throw new BadRequestException('请选择至少一个文件或 ISO 镜像');
      }

      const mode: BurnMode = body.mode === 'iso' ? 'iso' : 'files';
      if (mode === 'iso' && files.length !== 1) {
        throw new BadRequestException('ISO 模式只能上传一个镜像文件');
      }
      if (
        mode === 'iso' &&
        !files[0].originalname.toLowerCase().endsWith('.iso')
      ) {
        throw new BadRequestException('ISO 模式只接受 .iso 文件');
      }
      if (
        files.reduce((total, file) => total + file.size, 0) > maxUploadBytes
      ) {
        throw new BadRequestException('本次上传的文件总量超过服务器限制');
      }

      let relativePaths: string[] = [];
      if (body.relativePaths) {
        try {
          const parsed: unknown = JSON.parse(body.relativePaths);
          if (
            !Array.isArray(parsed) ||
            parsed.some((item) => typeof item !== 'string')
          ) {
            throw new Error('invalid paths');
          }
          relativePaths = parsed;
        } catch {
          throw new BadRequestException('文件路径列表格式不正确');
        }
      }

      return await this.jobs.createJob({
        mode,
        discName: body.discName ?? '',
        relativePaths,
        files: files.map((file) => ({
          path: file.path,
          originalname: file.originalname,
          size: file.size,
        })),
      });
    } finally {
      await Promise.all(
        (files ?? []).map((file) =>
          unlink(file.path).catch(() => undefined),
        ),
      );
    }
  }

  @Post('jobs/:id/cancel')
  cancelJob(@Param('id') id: string) {
    return this.jobs.cancelQueuedJob(id);
  }

  @Post('jobs/:id/retry')
  retryJob(@Param('id') id: string) {
    return this.jobs.retryJob(id);
  }

  @Sse('events')
  events(): Observable<{ data: string; type: string }> {
    const initial = new Observable<BurnSnapshot>((subscriber) => {
      subscriber.next(this.jobs.getSnapshot());
      subscriber.complete();
    });

    return merge(initial, this.jobs.events).pipe(
      map((snapshot) => ({
        type: 'snapshot',
        data: JSON.stringify(snapshot),
      })),
    );
  }

  @Sse('heartbeat')
  heartbeat(): Observable<{ data: string; type: string }> {
    return interval(15_000).pipe(
      map(() => ({
        type: 'heartbeat',
        data: new Date().toISOString(),
      })),
    );
  }
}

