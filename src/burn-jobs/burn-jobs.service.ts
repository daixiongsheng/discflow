import {
  ConflictException,
  Injectable,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  copyFile,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { Observable, Subject } from 'rxjs';
import {
  BurnJob,
  BurnSnapshot,
  CreateJobInput,
  JobWithPosition,
  PublicBurnJob,
} from './burn-job.types';
import { Imapi2RunnerService } from './imapi2-runner.service';
import {
  dataRoot,
  ensureStorageDirectories,
  jobsRoot,
} from './paths';

type StoredJobs = {
  version: 1;
  jobs: BurnJob[];
};

@Injectable()
export class BurnJobsService implements OnModuleInit {
  private readonly jobs = new Map<string, BurnJob>();
  private readonly queue: string[] = [];
  private readonly eventsSubject = new Subject<BurnSnapshot>();
  private runningJobId: string | null = null;
  private persistTail: Promise<void> = Promise.resolve();

  readonly events: Observable<BurnSnapshot> =
    this.eventsSubject.asObservable();

  constructor(private readonly runner: Imapi2RunnerService) {}

  async onModuleInit(): Promise<void> {
    ensureStorageDirectories();
    await this.loadJobs();

    for (const job of this.jobs.values()) {
      if (job.status === 'preparing' || job.status === 'burning') {
        job.status = 'failed';
        job.message = '服务重启中断了刻录，请确认盘片后重试';
        job.error = '刻录进程在任务完成前退出';
        job.finishedAt = new Date().toISOString();
        job.updatedAt = job.finishedAt;
      } else if (job.status === 'queued') {
        this.queue.push(job.id);
      }
    }

    await this.persist();
    this.publish();
    this.pumpQueue();
  }

  getSnapshot(): BurnSnapshot {
    const queuePositions = new Map(
      this.queue.map((jobId, index) => [jobId, index + 1]),
    );
    const jobs: JobWithPosition[] = Array.from(this.jobs.values())
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map((job) => this.toPublicJob(job, queuePositions));

    return {
      jobs,
      queueLength: this.queue.length,
      burner: {
        status: this.runningJobId ? 'busy' : 'online',
        activeJobId: this.runningJobId,
        drive: this.runner.getDrive(),
        simulation: this.runner.isSimulationEnabled(),
      },
      serverTime: new Date().toISOString(),
    };
  }

  getJob(id: string): JobWithPosition {
    return this.toPublicJob(this.requireJob(id));
  }

  private requireJob(id: string): BurnJob {
    const job = this.jobs.get(id);
    if (!job) {
      throw new NotFoundException('刻录任务不存在');
    }
    return job;
  }

  async createJob(input: CreateJobInput): Promise<JobWithPosition> {
    ensureStorageDirectories();
    const id = randomUUID();
    const now = new Date().toISOString();
    const workspace = join(jobsRoot(), id);
    const sourceDirectory = join(workspace, 'source');
    const discName = this.normaliseDiscName(input.discName, now);
    let isoPath: string | undefined;

    try {
      await mkdir(sourceDirectory, { recursive: true });

      for (let index = 0; index < input.files.length; index += 1) {
        const file = input.files[index];
        const requestedPath =
          input.relativePaths[index] || file.originalname || `file-${index + 1}`;
        const targetPath = await this.uniqueStagedPath(
          sourceDirectory,
          this.safeRelativePath(requestedPath),
        );
        await mkdir(dirname(targetPath), { recursive: true });
        await this.moveFile(file.path, targetPath);
        if (input.mode === 'iso') {
          isoPath = targetPath;
        }
      }
    } catch (error) {
      await rm(workspace, { recursive: true, force: true });
      throw error;
    }

    const job: BurnJob = {
      id,
      mode: input.mode,
      discName,
      status: 'queued',
      message: '等待刻录机空闲',
      progress: 0,
      fileCount: input.files.length,
      totalBytes: input.files.reduce((total, file) => total + file.size, 0),
      createdAt: now,
      updatedAt: now,
      sourceDirectory: workspace,
      isoPath,
    };

    this.jobs.set(job.id, job);
    this.queue.push(job.id);
    await this.persist();
    this.publish();
    this.pumpQueue();

    return this.toPublicJob(job);
  }

  async cancelQueuedJob(id: string): Promise<JobWithPosition> {
    const job = this.requireJob(id);
    if (job.status !== 'queued') {
      throw new ConflictException('任务已开始执行，无法安全取消');
    }

    const queueIndex = this.queue.indexOf(id);
    if (queueIndex >= 0) {
      this.queue.splice(queueIndex, 1);
    }

    job.status = 'cancelled';
    job.message = '任务已取消';
    job.finishedAt = new Date().toISOString();
    job.updatedAt = job.finishedAt;
    await this.persist();
    this.publish();

    return this.toPublicJob(job);
  }

  async retryJob(id: string): Promise<JobWithPosition> {
    const job = this.requireJob(id);
    if (job.status !== 'failed' && job.status !== 'cancelled') {
      throw new ConflictException('只有失败或已取消的任务可以重试');
    }

    job.status = 'queued';
    job.message = '等待刻录机空闲';
    job.progress = 0;
    job.error = undefined;
    job.startedAt = undefined;
    job.finishedAt = undefined;
    job.updatedAt = new Date().toISOString();
    this.queue.push(job.id);
    await this.persist();
    this.publish();
    this.pumpQueue();

    return this.toPublicJob(job);
  }

  private pumpQueue(): void {
    if (this.runningJobId || this.queue.length === 0) {
      return;
    }

    const id = this.queue.shift();
    if (!id) {
      return;
    }
    const job = this.jobs.get(id);
    if (!job || job.status !== 'queued') {
      this.pumpQueue();
      return;
    }

    this.runningJobId = id;
    void this.executeJob(job).finally(() => {
      this.runningJobId = null;
      this.publish();
      this.pumpQueue();
    });
  }

  private async executeJob(job: BurnJob): Promise<void> {
    job.status = 'preparing';
    job.message = '正在检查刻录机与盘片';
    job.progress = 1;
    job.startedAt = new Date().toISOString();
    job.updatedAt = job.startedAt;
    job.drive = this.runner.getDrive() ?? undefined;
    await this.persist();
    this.publish();

    try {
      job.status = 'burning';
      job.message = '正在刻录';
      job.progress = 5;
      job.updatedAt = new Date().toISOString();
      await this.persist();
      this.publish();

      await this.runner.burn(job, async (progress) => {
        job.progress = progress.percent;
        job.message = progress.message;
        job.updatedAt = new Date().toISOString();
        await this.persist();
        this.publish();
      });

      job.status = 'completed';
      job.progress = 100;
      job.message = '刻录完成，请从刻录机取出光盘';
      job.finishedAt = new Date().toISOString();
      job.updatedAt = job.finishedAt;
      await this.persist();
      this.publish();

      if (process.env.CLEANUP_SOURCES_AFTER_SUCCESS !== 'false') {
        await this.cleanupWorkspace(job);
      }
    } catch (error) {
      job.status = 'failed';
      job.message = '刻录失败';
      job.error =
        error instanceof Error ? error.message.slice(0, 2_000) : String(error);
      job.finishedAt = new Date().toISOString();
      job.updatedAt = job.finishedAt;
      await this.persist();
      this.publish();
    }
  }

  private publish(): void {
    this.eventsSubject.next(this.getSnapshot());
  }

  private toPublicJob(
    job: BurnJob,
    queuePositions?: Map<string, number>,
  ): JobWithPosition {
    const positions =
      queuePositions ??
      new Map(this.queue.map((jobId, index) => [jobId, index + 1]));
    const publicJob: PublicBurnJob = {
      id: job.id,
      mode: job.mode,
      discName: job.discName,
      status: job.status,
      message: job.message,
      progress: job.progress,
      fileCount: job.fileCount,
      totalBytes: job.totalBytes,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      error: job.error,
      drive: job.drive,
    };

    return {
      ...publicJob,
      queuePosition:
        job.status === 'queued' ? (positions.get(job.id) ?? null) : null,
    };
  }

  private async persist(): Promise<void> {
    const snapshot: StoredJobs = {
      version: 1,
      jobs: Array.from(this.jobs.values()),
    };
    const serialised = JSON.stringify(snapshot, null, 2);

    this.persistTail = this.persistTail.then(async () => {
      await mkdir(dataRoot(), { recursive: true });
      const target = join(dataRoot(), 'jobs.json');
      const temporary = `${target}.tmp`;
      await writeFile(temporary, serialised, 'utf8');
      await rename(temporary, target);
    });

    await this.persistTail;
  }

  private async loadJobs(): Promise<void> {
    const path = join(dataRoot(), 'jobs.json');
    let contents: string;
    try {
      contents = await readFile(path, 'utf8');
    } catch {
      return;
    }

    try {
      const stored = JSON.parse(contents) as Partial<StoredJobs>;
      if (!Array.isArray(stored.jobs)) {
        return;
      }
      for (const job of stored.jobs) {
        if (job && typeof job.id === 'string') {
          this.jobs.set(job.id, job);
        }
      }
    } catch {
      console.error(`无法解析任务快照：${path}`);
    }
  }

  private async cleanupWorkspace(job: BurnJob): Promise<void> {
    if (!job.sourceDirectory) {
      return;
    }
    try {
      await rm(job.sourceDirectory, { recursive: true, force: true });
    } catch (error) {
      console.warn(`任务 ${job.id} 的源文件清理失败`, error);
    }
  }

  private normaliseDiscName(value: string, now: string): string {
    const cleaned = value
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 64);
    if (cleaned) {
      return cleaned;
    }
    const stamp = now.slice(0, 16).replace(/[-:T]/g, '');
    return `DISC_${stamp}`;
  }

  private safeRelativePath(value: string): string {
    const segments = value
      .replace(/\\/g, '/')
      .split('/')
      .map((segment) => segment.trim())
      .filter(
        (segment) =>
          segment.length > 0 &&
          segment !== '.' &&
          segment !== '..' &&
          !segment.includes('\0'),
      );
    if (segments.length === 0) {
      return 'untitled';
    }
    return segments.join('/');
  }

  private async uniqueStagedPath(
    root: string,
    relativePath: string,
  ): Promise<string> {
    const rootPath = resolve(root);
    const candidate = resolve(rootPath, relativePath);
    if (!candidate.startsWith(`${rootPath}${sep}`)) {
      throw new Error('上传文件路径超出任务目录');
    }

    try {
      await stat(candidate);
    } catch {
      return candidate;
    }

    const extensionIndex = relativePath.lastIndexOf('.');
    const base =
      extensionIndex > 0 ? relativePath.slice(0, extensionIndex) : relativePath;
    const extension =
      extensionIndex > 0 ? relativePath.slice(extensionIndex) : '';
    let index = 2;
    while (true) {
      const next = resolve(rootPath, `${base} (${index})${extension}`);
      if (!next.startsWith(`${rootPath}${sep}`)) {
        throw new Error('上传文件路径超出任务目录');
      }
      try {
        await stat(next);
        index += 1;
      } catch {
        return next;
      }
    }
  }

  private async moveFile(source: string, target: string): Promise<void> {
    try {
      await rename(source, target);
    } catch {
      await copyFile(source, target);
      await unlink(source);
    }
  }
}

