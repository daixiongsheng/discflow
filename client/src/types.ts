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
  queuePosition: number | null;
}

export interface BurnSnapshot {
  jobs: BurnJob[];
  queueLength: number;
  burner: {
    status: 'online' | 'busy' | 'offline';
    activeJobId: string | null;
    drive: string | null;
    simulation: boolean;
  };
  serverTime: string;
}

