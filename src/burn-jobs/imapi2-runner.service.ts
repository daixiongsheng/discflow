import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { spawn } from 'node:child_process';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { BurnJob, BurnProgress } from './burn-job.types';

type ProgressCallback = (progress: BurnProgress) => Promise<void>;

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

@Injectable()
export class Imapi2RunnerService {
  isSimulationEnabled(): boolean {
    return (
      process.platform !== 'win32' ||
      process.env.BURN_SIMULATION?.toLowerCase() === 'true'
    );
  }

  getDrive(): string | null {
    return process.env.BURN_DRIVE?.trim() || null;
  }

  async burn(job: BurnJob, onProgress: ProgressCallback): Promise<void> {
    if (this.isSimulationEnabled()) {
      await this.simulateBurn(job, onProgress);
      return;
    }

    const scriptPath = resolve(
      process.env.IMAPI2_SCRIPT ??
        join(process.cwd(), 'windows', 'Invoke-Imapi2Burn.ps1'),
    );
    try {
      await access(scriptPath);
    } catch {
      throw new InternalServerErrorException(
        `找不到 IMAPI2 脚本：${scriptPath}`,
      );
    }

    const jobDirectory = job.sourceDirectory;
    if (!jobDirectory) {
      throw new InternalServerErrorException('任务源目录不存在');
    }

    const manifestPath = join(jobDirectory, 'burn-manifest.json');
    await mkdir(jobDirectory, { recursive: true });
    await writeFile(
      manifestPath,
      JSON.stringify(
        {
          jobId: job.id,
          mode: job.mode,
          discName: job.discName,
          sourceDirectory: join(jobDirectory, 'source'),
          isoPath: job.isoPath,
          drive: this.getDrive(),
        },
        null,
        2,
      ),
      'utf8',
    );

    await this.runPowerShell([
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Sta',
      '-File',
      scriptPath,
      '-ManifestPath',
      manifestPath,
    ], onProgress);
  }

  private async simulateBurn(
    job: BurnJob,
    onProgress: ProgressCallback,
  ): Promise<void> {
    const stepDelay = Math.max(
      0,
      Number(process.env.SIMULATION_DELAY_MS ?? 120),
    );
    const steps: BurnProgress[] = [
      { percent: 8, message: '正在检查模拟刻录机与盘片' },
      { percent: 24, message: '正在整理光盘文件系统' },
      { percent: 54, message: '正在写入光盘数据' },
      { percent: 82, message: '正在完成光盘轨道' },
      { percent: 97, message: '正在校验刻录结果' },
    ];

    for (const step of steps) {
      await delay(stepDelay);
      await onProgress(step);
    }

    await delay(stepDelay);
    await onProgress({
      percent: 100,
      message:
        job.mode === 'iso'
          ? '模拟 ISO 刻录完成'
          : '模拟文件光盘刻录完成',
    });
  }

  private runPowerShell(
    args: string[],
    onProgress: ProgressCallback,
  ): Promise<void> {
    const executable = process.env.POWERSHELL_PATH ?? 'powershell.exe';

    return new Promise((resolveBurn, rejectBurn) => {
      const child = spawn(executable, args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdoutBuffer = '';
      let stderr = '';
      let settled = false;

      const fail = (error: Error) => {
        if (!settled) {
          settled = true;
          rejectBurn(error);
        }
      };

      const processLine = (rawLine: string) => {
        const line = rawLine.trim();
        if (!line) {
          return;
        }

        try {
          const payload = JSON.parse(line) as {
            type?: string;
            percent?: number;
            message?: string;
          };
          if (payload.type === 'progress') {
            const percent = Math.max(
              0,
              Math.min(100, Number(payload.percent ?? 0)),
            );
            void onProgress({
              percent,
              message: payload.message ?? '正在刻录',
            });
          } else if (payload.type === 'error') {
            stderr = payload.message ?? "IMAPI2 执行失败";
          }
        } catch {
          // Device drivetext or a PowerShell warning may not be JSON.
        }
      };

      child.stdout.on('data', (chunk: Buffer) => {
        stdoutBuffer += chunk.toString('utf8');
        const lines = stdoutBuffer.split(/\r?\n/);
        stdoutBuffer = lines.pop() ?? '';
        lines.forEach(processLine);
      });

      child.stderr.on('data', (chunk: Buffer) => {
        stderr = `${stderr}${chunk.toString('utf8')}`.slice(-8_000);
      });

      child.on('error', (error) => {
        fail(
          new Error(
            `无法启动 PowerShell（${executable}）：${error.message}`,
          ),
        );
      });

      child.on('close', (code) => {
        if (stdoutBuffer.trim()) {
          processLine(stdoutBuffer);
        }
        if (settled) {
          return;
        }
        settled = true;
        if (code === 0) {
          resolveBurn();
          return;
        }
        rejectBurn(
          new Error(
            stderr.trim() ||
              `PowerShell 刻录进程退出，状态码 ${String(code)}`,
          ),
        );
      });
    });
  }
}

