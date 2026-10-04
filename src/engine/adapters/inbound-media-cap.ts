import type { IncomingMessage } from '../interfaces/whatsapp-engine.interface';
import { ConcurrencyLimiter } from '../../common/utils/concurrency-limiter';

/** Default inbound media cap: 50 MiB. Shares MEDIA_DOWNLOAD_MAX_BYTES with the outbound download cap. */
const DEFAULT_INBOUND_MEDIA_MAX_BYTES = 50 * 1024 * 1024;

/**
 * Resolved inbound media byte cap.
 */
export function inboundMediaMaxBytes(): number {
  const parsed = Number.parseInt(process.env.MEDIA_DOWNLOAD_MAX_BYTES ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_INBOUND_MEDIA_MAX_BYTES;
}

/** Default number of inbound media downloads processed at once. */
const DEFAULT_INBOUND_MEDIA_CONCURRENCY = 4;

/**
 * Max inbound media downloads processed concurrently.
 */
export function inboundMediaConcurrency(): number {
  const parsed = Number.parseInt(process.env.INBOUND_MEDIA_CONCURRENCY ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_INBOUND_MEDIA_CONCURRENCY;
}

/**
 * Process-wide ceiling on inbound media downloads across every session.
 */
export function inboundMediaGlobalConcurrency(): number {
  const parsed = Number.parseInt(process.env.INBOUND_MEDIA_GLOBAL_CONCURRENCY ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
}

let globalGate: ConcurrencyLimiter | null | undefined;

export function globalInboundMediaGate(): ConcurrencyLimiter | null {
  if (globalGate === undefined) {
    const max = inboundMediaGlobalConcurrency();
    globalGate = max > 0 ? new ConcurrencyLimiter(max) : null;
  }
  return globalGate;
}

export function runUnderGlobalMediaGate<T>(task: () => Promise<T>): Promise<T> {
  const gate = globalInboundMediaGate();
  return gate ? gate.run(task) : task();
}

export function __resetGlobalInboundMediaGate(): void {
  globalGate = undefined;
}

const DEFAULT_INBOUND_MEDIA_TIMEOUT_MS = 30_000;

export function inboundMediaTimeoutMs(): number {
  const parsed = Number.parseInt(process.env.MEDIA_DOWNLOAD_TIMEOUT_MS ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_INBOUND_MEDIA_TIMEOUT_MS;
}

/**
 * Helper to identify upstream whatsapp-web.js 1.34.7 internal 't: t' download error (#1739).
 */
export function isUpstreamMediaDownloadError(err: unknown): boolean {
  if (!err) return false;
  if (err === 't: t') return true;
  if (typeof err === 'object') {
    const anyErr = err as Record<string, unknown>;
    if (anyErr.t === 't') return true;
    if (typeof anyErr.message === 'string' && anyErr.message.includes('t: t')) return true;
  }
  return false;
}

/**
 * Bound an inbound media download by a wall-clock deadline.
 * Handles upstream whatsapp-web.js 1.34.7 't: t' rejections (#1739) by safely returning null instead of throwing.
 */
export function withInboundDownloadTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout?: () => void,
): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<null>(resolve => {
    timer = setTimeout(() => {
      onTimeout?.();
      resolve(null);
    }, timeoutMs);
    timer.unref?.();
  });

  // Catch upstream wwebjs 1.34.7 't: t' rejection or late rejection
  const safePromise = promise.catch((err: unknown) => {
    if (isUpstreamMediaDownloadError(err)) {
      return null as T | null;
    }
    return Promise.reject(err);
  });

  // Defuse any abandoned late rejection
  safePromise.catch(() => undefined);

  return Promise.race([safePromise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export function isMediaDownloadEnabled(): boolean {
  const val = (process.env.MEDIA_DOWNLOAD_ENABLED ?? '').trim().toLowerCase();
  return val !== 'false' && val !== '0' && val !== 'no';
}

const DEFAULT_CHAT_HISTORY_MEDIA_BUDGET_BYTES = 25 * 1024 * 1024;

export function chatHistoryMediaBudgetBytes(): number {
  const parsed = Number.parseInt(process.env.CHAT_HISTORY_MEDIA_BUDGET_BYTES ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_CHAT_HISTORY_MEDIA_BUDGET_BYTES;
}

const INGEST_MEDIA_BUDGET_ITEMS = 4;

export function ingestMediaBudgetBytes(perItemMaxBytes: number): number {
  if (!Number.isFinite(perItemMaxBytes) || perItemMaxBytes <= 0) return chatHistoryMediaBudgetBytes();
  return Math.max(chatHistoryMediaBudgetBytes(), Math.ceil(perItemMaxBytes * INGEST_MEDIA_BUDGET_ITEMS * 1.37));
}

export function coerceDeclaredSize(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (value && typeof (value as { toNumber?: () => number }).toNumber === 'function') {
    const n = (value as { toNumber: () => number }).toNumber();
    return Number.isFinite(n) ? n : 0;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

type InboundMedia = NonNullable<IncomingMessage['media']>;

export function capInboundMedia(args: {
  mimetype: string;
  filename?: string;
  sizeBytes: number;
  toBase64: () => string;
  maxBytes?: number;
}): InboundMedia {
  const max = args.maxBytes ?? inboundMediaMaxBytes();
  if (args.sizeBytes > max) {
    return { mimetype: args.mimetype, filename: args.filename, omitted: true, sizeBytes: args.sizeBytes };
  }
  return { mimetype: args.mimetype, filename: args.filename, data: args.toBase64() };
}