export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  let response: Response;
  try {
    response = await fetch(path, {
      ...options,
      headers,
      signal: options.signal ?? AbortSignal.timeout(120_000),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'TimeoutError') {
      throw new ApiError('The local application did not answer in time. Check the server logs.', 0, 'TIMEOUT');
    }
    throw new ApiError(
      'The local TicketsManage server is not reachable. Make sure the application is still running.',
      0,
      'NETWORK_ERROR',
    );
  }
  const contentType = response.headers.get('content-type') ?? '';
  const body = contentType.includes('application/json') ? await response.json() : await response.text();
  if (!response.ok) {
    const error = typeof body === 'object' && body ? (body as { error?: { message?: string; code?: string; details?: unknown } }).error : null;
    throw new ApiError(
      error?.message || `Request failed with HTTP ${response.status}`,
      response.status,
      error?.code || 'REQUEST_FAILED',
      error?.details,
    );
  }
  return body as T;
}

export function download(path: string): void {
  const anchor = document.createElement('a');
  anchor.href = path;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

export function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return new Intl.NumberFormat().format(value);
}

export function formatPoints(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatDateOnly(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: '2-digit' });
}
