export type BurnMode = 'files' | 'iso';

export type BurnJobStatus =
  | 'queued'
  | 'preparing'
  | 'burning'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface BurnJob {
  id: string;
  mode: BurnMode;
  discName: string;
  status: BurnJobStatus;
  message: string;
  progress: number;
  fileCount: number;
  totalBytes: number;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  drive?: string;
  sourceDirectory?: string;
  isoPath?: string;
}

export interface BurnerState {
  status: 'online' | 'busy' | 'offline';
  activeJobId: string | null;
  drive: string | null;
  simulation: boolean;
}

export interface PublicBurnJob {
  id: string;
  mode: BurnMode;
  discName: string;
  status: BurnJobStatus;
  message: string;
  progress: number;
  fileCount: number;
  totalBytes: number;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  drive?: string;
}

export interface JobWithPosition extends PublicBurnJob {
  queuePosition: number | null;
}

export interface BurnSnapshot {
  jobs: JobWithPosition[];
  queueLength: number;
  burner: BurnerState;
  serverTime: string;
}

export interface StagedUpload {
  path: string;
  originalname: string;
  size: number;
}

export interface CreateJobInput {
  mode: BurnMode;
  discName: string;
  relativePaths: string[];
  files: StagedUpload[];
}

export interface BurnProgress {
  percent: number;
  message: string;
}

