import {
  type ChangeEvent,
  type DragEvent,
  type FormEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  cancelJob,
  fetchSnapshot,
  retryJob,
  submitJob,
} from './api';
import type {
  BurnJob,
  BurnJobStatus,
  BurnMode,
  BurnSnapshot,
} from './types';

const statusLabels: Record<BurnJobStatus, string> = {
  queued: '排队中',
  preparing: '准备中',
  burning: '刻录中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
};

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );
  const value = bytes / 1024 ** index;
  return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

function isPending(job: BurnJob): boolean {
  return (
    job.status === 'queued' ||
    job.status === 'preparing' ||
    job.status === 'burning'
  );
}

function DiscMark({ small = false }: { small?: boolean }) {
  return (
    <span className={`disc-mark${small ? ' disc-mark--small' : ''}`} aria-hidden>
      <span className="disc-mark__ring" />
      <span className="disc-mark__shine" />
    </span>
  );
}

export function App() {
  const [snapshot, setSnapshot] = useState<BurnSnapshot | null>(null);
  const [connection, setConnection] = useState<
    'connecting' | 'live' | 'offline'
  >('connecting');
  const [mode, setMode] = useState<BurnMode>('files');
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [discName, setDiscName] = useState('');
  const [dragging, setDragging] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [uploadPercent, setUploadPercent] = useState(0);
  const [busyJobId, setBusyJobId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{
    tone: 'error' | 'success';
    message: string;
  } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let active = true;
    void fetchSnapshot()
      .then((next) => {
        if (active) {
          setSnapshot(next);
          setConnection('live');
        }
      })
      .catch(() => {
        if (active) setConnection('offline');
      });

    const source = new EventSource('/api/events');
    source.addEventListener('open', () => {
      if (active) setConnection('live');
    });
    source.addEventListener('snapshot', (event) => {
      if (!active) return;
      try {
        setSnapshot(JSON.parse((event as MessageEvent).data) as BurnSnapshot);
        setConnection('live');
      } catch {
        // Ignore a malformed event and wait for the next server snapshot.
      }
    });
    source.addEventListener('error', () => {
      if (active) setConnection('offline');
    });

    const polling = window.setInterval(() => {
      void fetchSnapshot()
        .then((next) => {
          if (active) {
            setSnapshot(next);
            setConnection('live');
          }
        })
        .catch(() => {
          if (active) setConnection('offline');
        });
    }, 15_000);

    return () => {
      active = false;
      source.close();
      window.clearInterval(polling);
    };
  }, []);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 5_000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const jobs = useMemo(() => {
    const all = snapshot?.jobs ?? [];
    return [...all].sort((left, right) => {
      const leftPending = isPending(left);
      const rightPending = isPending(right);
      if (leftPending !== rightPending) return leftPending ? -1 : 1;
      if (left.queuePosition && right.queuePosition) {
        return left.queuePosition - right.queuePosition;
      }
      return right.createdAt.localeCompare(left.createdAt);
    });
  }, [snapshot]);

  const pendingCount = jobs.filter(isPending).length;
  const totalBytes = selectedFiles.reduce(
    (total, file) => total + file.size,
    0,
  );

  function chooseMode(next: BurnMode) {
    setMode(next);
    setSelectedFiles([]);
    if (fileInput.current) fileInput.current.value = '';
    if (folderInput.current) folderInput.current.value = '';
  }

  function acceptFiles(fileList: FileList | File[]) {
    const files = Array.from(fileList);
    if (files.length === 0) return;

    if (mode === 'iso') {
      const image = files.find((file) =>
        file.name.toLowerCase().endsWith('.iso'),
      );
      if (!image) {
        setNotice({
          tone: 'error',
          message: '请选择一个 .iso 镜像文件',
        });
        return;
      }
      setSelectedFiles([image]);
      if (!discName.trim()) {
        setDiscName(image.name.replace(/\.iso$/i, '').slice(0, 64));
      }
      return;
    }

    setSelectedFiles(files);
    if (!discName.trim()) {
      const rootFolder = files[0].webkitRelativePath.split('/')[0];
      setDiscName(
        (files.length === 1 ? files[0].name : rootFolder || 'DATA_DISC').slice(
          0,
          64,
        ),
      );
    }
  }

  function onFileChange(event: ChangeEvent<HTMLInputElement>) {
    if (event.target.files) acceptFiles(event.target.files);
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    acceptFiles(event.dataTransfer.files);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (selectedFiles.length === 0 || submitting) return;

    setSubmitting(true);
    setUploadPercent(0);
    setNotice(null);
    try {
      await submitJob(
        selectedFiles,
        mode,
        discName,
        setUploadPercent,
      );
      setSelectedFiles([]);
      setDiscName('');
      setNotice({
        tone: 'success',
        message: '任务已提交，服务器会按顺序安排刻录',
      });
      const next = await fetchSnapshot();
      setSnapshot(next);
    } catch (error) {
      setNotice({
        tone: 'error',
        message: error instanceof Error ? error.message : '提交任务失败',
      });
    } finally {
      setSubmitting(false);
      setUploadPercent(0);
    }
  }

  async function runJobAction(
    id: string,
    action: 'cancel' | 'retry',
  ): Promise<void> {
    setBusyJobId(id);
    try {
      if (action === 'cancel') {
        await cancelJob(id);
      } else {
        await retryJob(id);
      }
      setSnapshot(await fetchSnapshot());
    } catch (error) {
      setNotice({
        tone: 'error',
        message: error instanceof Error ? error.message : '操作失败',
      });
    } finally {
      setBusyJobId(null);
    }
  }

  const burnerBusy = snapshot?.burner.status === 'busy';
  const burnerStatusText =
    connection === 'offline'
      ? '服务器离线'
      : burnerBusy
        ? '刻录机工作中'
        : snapshot?.burner.simulation
          ? '模拟刻录机就绪'
          : '刻录机就绪';

  return (
    <div className="page">
      <header className="topbar">
        <a className="brand" href="/" aria-label="DiscFlow 首页">
          <DiscMark />
          <span>
            <strong>DiscFlow</strong>
            <small>LAN BURNING STATION</small>
          </span>
        </a>
        <div className="topbar__right">
          <span className={`live-state live-state--${connection}`}>
            <i />
            {connection === 'live'
              ? '实时连接'
              : connection === 'connecting'
                ? '正在连接'
                : '等待重连'}
          </span>
          <span className="server-chip">
            <span
              className={`server-chip__dot${
                connection === 'offline' ? ' is-offline' : ''
              }`}
            />
            {burnerStatusText}
            {snapshot?.burner.drive ? ` · ${snapshot.burner.drive}` : ''}
          </span>
        </div>
      </header>

      <main>
        <section className="intro">
          <div>
            <p className="eyebrow">WINDOWS DISC BURNER</p>
            <h1>
              文件放进来，
              <br />
              刻录机按序完成。
            </h1>
          </div>
          <p className="intro__copy">
            从局域网任意电脑提交文件和 ISO。服务器会先安全接收资料，
            再让唯一刻录机一次处理一个任务。
          </p>
        </section>

        <div className="workspace">
          <section className="panel composer">
            <div className="panel-heading">
              <div>
                <p className="section-index">01 / 新任务</p>
                <h2>准备一张光盘</h2>
              </div>
              <span className="capacity-note">
                {selectedFiles.length > 0
                  ? `${selectedFiles.length} 个文件 · ${formatBytes(totalBytes)}`
                  : 'CD / DVD'}
              </span>
            </div>

            <form onSubmit={(event) => void submit(event)}>
              <div className="mode-switch" aria-label="选择刻录来源">
                <button
                  type="button"
                  className={mode === 'files' ? 'is-active' : ''}
                  onClick={() => chooseMode('files')}
                >
                  <FileIcon />
                  文件和文件夹
                </button>
                <button
                  type="button"
                  className={mode === 'iso' ? 'is-active' : ''}
                  onClick={() => chooseMode('iso')}
                >
                  <DiscIcon />
                  ISO 镜像
                </button>
              </div>

              <div
                className={`dropzone${dragging ? ' is-dragging' : ''}${
                  selectedFiles.length > 0 ? ' has-files' : ''
                }`}
                onDragOver={(event) => {
                  event.preventDefault();
                  setDragging(true);
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={onDrop}
                onClick={() =>
                  mode === 'files'
                    ? fileInput.current?.click()
                    : fileInput.current?.click()
                }
                role="button"
                tabIndex={0}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    fileInput.current?.click();
                  }
                }}
              >
                <input
                  ref={fileInput}
                  className="visually-hidden"
                  type="file"
                  multiple={mode === 'files'}
                  accept={mode === 'iso' ? '.iso,application/x-iso9660-image' : undefined}
                  onChange={onFileChange}
                />
                <input
                  ref={folderInput}
                  className="visually-hidden"
                  type="file"
                  multiple
                  onChange={onFileChange}
                  {...({ webkitdirectory: '', directory: '' } as Record<
                    string,
                    string
                  >)}
                />

                {selectedFiles.length === 0 ? (
                  <div className="dropzone__empty">
                    <span className="dropzone__icon">
                      {mode === 'iso' ? <DiscIcon /> : <UploadIcon />}
                    </span>
                    <strong>
                      {mode === 'iso'
                        ? '拖入或选择一个 ISO 文件'
                        : '拖入文件，或点击选择'}
                    </strong>
                    <span>
                      {mode === 'iso'
                        ? '仅支持 .iso 镜像'
                        : '文件将上传至刻录服务器并保留目录结构'}
                    </span>
                  </div>
                ) : (
                  <div className="selection">
                    <div className="selection__head">
                      <span className="selection__icon">
                        {mode === 'iso' ? <DiscIcon /> : <CheckIcon />}
                      </span>
                      <div>
                        <strong>已准备好</strong>
                        <span>
                          {selectedFiles.length === 1
                            ? selectedFiles[0].name
                            : `${selectedFiles.length} 个文件已选择`}
                        </span>
                      </div>
                      <button
                        type="button"
                        className="text-button"
                        onClick={(event) => {
                          event.stopPropagation();
                          setSelectedFiles([]);
                        }}
                      >
                        清空
                      </button>
                    </div>
                    <div className="selection__list">
                      {selectedFiles.slice(0, 5).map((file) => (
                        <div
                          key={`${file.webkitRelativePath}-${file.name}-${file.size}`}
                          className="selection__row"
                        >
                          <span>
                            {file.webkitRelativePath || file.name}
                          </span>
                          <small>{formatBytes(file.size)}</small>
                        </div>
                      ))}
                      {selectedFiles.length > 5 && (
                        <div className="selection__more">
                          另有 {selectedFiles.length - 5} 个文件
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>

              {mode === 'files' && selectedFiles.length === 0 && (
                <div className="picker-actions">
                  <button
                    type="button"
                    className="small-action"
                    onClick={() => fileInput.current?.click()}
                  >
                    添加文件
                  </button>
                  <span>或</span>
                  <button
                    type="button"
                    className="small-action"
                    onClick={() => folderInput.current?.click()}
                  >
                    添加整个文件夹
                  </button>
                </div>
              )}

              <label className="field">
                <span>光盘名称</span>
                <input
                  value={discName}
                  onChange={(event) => setDiscName(event.target.value)}
                  placeholder="例如：项目资料_2026"
                  maxLength={64}
                />
                <small>{discName.length} / 64</small>
              </label>

              <button
                className="submit-button"
                type="submit"
                disabled={selectedFiles.length === 0 || submitting}
              >
                {submitting ? (
                  <>
                    <span className="spinner" />
                    {uploadPercent < 100
                      ? `正在上传 ${uploadPercent}%`
                      : '正在创建任务'}
                  </>
                ) : (
                  <>
                    提交刻录任务
                    <ArrowIcon />
                  </>
                )}
              </button>
            </form>
          </section>

          <section className="panel queue">
            <div className="panel-heading panel-heading--queue">
              <div>
                <p className="section-index">02 / 刻录队列</p>
                <h2>任务按序进行</h2>
              </div>
              <div className="queue-total">
                <strong>{pendingCount}</strong>
                <span>待处理</span>
              </div>
            </div>

            <div className="queue-rule">
              <span
                className={
                  connection === 'offline' ? 'is-offline' : 'is-online'
                }
              >
                {connection === 'offline' ? '等待服务器' : '单任务执行'}
              </span>
              <p>一张光盘完成后，下一项才会开始。</p>
            </div>

            <div className="job-list">
              {jobs.length === 0 ? (
                <div className="empty-queue">
                  <DiscMark small />
                  <strong>刻录机正在等待</strong>
                  <span>提交第一个任务后，进度会显示在这里。</span>
                </div>
              ) : (
                jobs.map((job, index) => (
                  <JobCard
                    key={job.id}
                    job={job}
                    index={index}
                    busy={busyJobId === job.id}
                    onCancel={() => void runJobAction(job.id, 'cancel')}
                    onRetry={() => void runJobAction(job.id, 'retry')}
                  />
                ))
              )}
            </div>
          </section>
        </div>

        <footer className="footer">
          <div>
            <span className="footer__pulse" />
            <span>
              {snapshot?.burner.simulation
                ? '当前为模拟刻录模式，不会写入真实光盘'
                : '刻录任务由所连接的 Windows IMAPI2 刻录机执行'}
            </span>
          </div>
          <span>请勿在刻录过程中关闭服务器</span>
        </footer>
      </main>

      {notice && (
        <div
          className={`toast toast--${notice.tone}`}
          role={notice.tone === 'error' ? 'alert' : 'status'}
        >
          <span>{notice.tone === 'error' ? '!' : '✓'}</span>
          {notice.message}
          <button
            type="button"
            aria-label="关闭提示"
            onClick={() => setNotice(null)}
          >
            ×
          </button>
        </div>
      )}
    </div>
  );
}

function JobCard({
  job,
  index,
  busy,
  onCancel,
  onRetry,
}: {
  job: BurnJob;
  index: number;
  busy: boolean;
  onCancel: () => void;
  onRetry: () => void;
}) {
  const active = job.status === 'preparing' || job.status === 'burning';
  const displayNumber = String(index + 1).padStart(2, '0');

  return (
    <article className={`job-card job-card--${job.status}`}>
      <div className="job-card__number">{displayNumber}</div>
      <div className="job-card__body">
        <div className="job-card__title-row">
          <div className="job-card__title">
            <strong>{job.discName}</strong>
            <span>
              {job.mode === 'iso' ? 'ISO 镜像' : `${job.fileCount} 个文件`}
              {' · '}
              {formatBytes(job.totalBytes)}
            </span>
          </div>
          <span className={`status-badge status-badge--${job.status}`}>
            {job.status === 'burning' && <i className="status-pulse" />}
            {job.queuePosition && job.status === 'queued'
              ? `第 ${job.queuePosition} 位`
              : statusLabels[job.status]}
          </span>
        </div>

        <p className="job-card__message">
          {job.error || job.message}
          <span>{formatTime(job.createdAt)}</span>
        </p>

        {(active || job.status === 'queued') && (
          <div className="progress-line">
            <span
              className={job.status === 'queued' ? 'is-waiting' : ''}
              style={{ width: `${Math.max(job.progress, active ? 3 : 0)}%` }}
            />
          </div>
        )}

        {(job.status === 'burning' || job.status === 'preparing') && (
          <div className="progress-caption">
            <span>{job.progress}%</span>
            <span>刻录机占用中</span>
          </div>
        )}

        {job.status === 'queued' && (
          <button
            type="button"
            className="job-action"
            disabled={busy}
            onClick={onCancel}
          >
            取消排队
          </button>
        )}
        {(job.status === 'failed' || job.status === 'cancelled') && (
          <button
            type="button"
            className="job-action"
            disabled={busy}
            onClick={onRetry}
          >
            重新排队
          </button>
        )}
      </div>
    </article>
  );
}

function UploadIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden>
      <path d="M12 16V4m0 0L7 9m5-5 5 5M5 20h14" />
    </svg>
  );
}

function FileIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden>
      <path d="M6 3h8l4 4v14H6zM14 3v5h5M9 12h6M9 16h6" />
    </svg>
  );
}

function DiscIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden>
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="12" cy="12" r="2.5" />
      <path d="M12 3.5a8.5 8.5 0 0 1 7.2 4" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden>
      <path d="m5 12 4.5 4.5L19 6.5" />
    </svg>
  );
}

function ArrowIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden>
      <path d="M5 12h14m-5-5 5 5-5 5" />
    </svg>
  );
}

