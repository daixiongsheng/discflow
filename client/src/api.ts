import type { BurnJob, BurnSnapshot } from './types';

async function readError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { message?: string | string[] };
    if (Array.isArray(body.message)) {
      return body.message.join('；');
    }
    return body.message || '请求失败';
  } catch {
    return `请求失败（HTTP ${response.status}）`;
  }
}

export async function fetchSnapshot(): Promise<BurnSnapshot> {
  const response = await fetch('/api/jobs', {
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(await readError(response));
  }
  return (await response.json()) as BurnSnapshot;
}

export async function cancelJob(id: string): Promise<BurnJob> {
  const response = await fetch(`/api/jobs/${id}/cancel`, { method: 'POST' });
  if (!response.ok) {
    throw new Error(await readError(response));
  }
  return (await response.json()) as BurnJob;
}

export async function retryJob(id: string): Promise<BurnJob> {
  const response = await fetch(`/api/jobs/${id}/retry`, { method: 'POST' });
  if (!response.ok) {
    throw new Error(await readError(response));
  }
  return (await response.json()) as BurnJob;
}

export function submitJob(
  files: File[],
  mode: 'files' | 'iso',
  discName: string,
  onProgress: (percent: number) => void,
): Promise<BurnJob> {
  return new Promise((resolve, reject) => {
    const body = new FormData();
    body.append('mode', mode);
    body.append('discName', discName);
    body.append(
      'relativePaths',
      JSON.stringify(
        files.map((file) => file.webkitRelativePath || file.name),
      ),
    );
    files.forEach((file) => body.append('files', file, file.name));

    const request = new XMLHttpRequest();
    request.open('POST', '/api/jobs');
    request.responseType = 'json';
    request.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable) {
        onProgress(Math.round((event.loaded / event.total) * 100));
      }
    });
    request.addEventListener('load', () => {
      if (request.status >= 200 && request.status < 300) {
        resolve(request.response as BurnJob);
        return;
      }
      const response = request.response as
        | { message?: string | string[] }
        | undefined;
      const message = response?.message;
      reject(
        new Error(
          Array.isArray(message)
            ? message.join('；')
            : message || `提交失败（HTTP ${request.status}）`,
        ),
      );
    });
    request.addEventListener('error', () => {
      reject(new Error('无法连接刻录服务器，请检查局域网连接'));
    });
    request.send(body);
  });
}

