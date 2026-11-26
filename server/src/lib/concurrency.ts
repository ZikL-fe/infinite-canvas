/** 轻量进程内并发信号量与有界排队器：用于 AI 代理并发控流与大媒体转存并发保护。 */

export class ConcurrencyLimitError extends Error {
  readonly code: "QUEUE_FULL" | "QUEUE_TIMEOUT" | "ABORTED";

  constructor(code: "QUEUE_FULL" | "QUEUE_TIMEOUT" | "ABORTED", message: string) {
    super(message);
    this.name = "ConcurrencyLimitError";
    this.code = code;
  }
}

type Waiter = {
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  onAbort?: () => void;
};

/** 创建进程内有界并发信号量，支持最大并发数、等待队列上限、排队超时及 AbortSignal 取消。 */
export function createConcurrencyLimiter(options: {
  maxConcurrent: number;
  maxQueue?: number;
  queueTimeoutMs?: number;
}) {
  const maxConcurrent = Math.max(1, Math.floor(options.maxConcurrent));
  const maxQueue = options.maxQueue !== undefined ? Math.max(0, Math.floor(options.maxQueue)) : undefined;
  const queueTimeoutMs = options.queueTimeoutMs && options.queueTimeoutMs > 0 ? Math.floor(options.queueTimeoutMs) : undefined;

  let active = 0;
  const queue: Waiter[] = [];

  const cleanupWaiter = (waiter: Waiter) => {
    if (waiter.timer) clearTimeout(waiter.timer);
    if (waiter.signal && waiter.onAbort) {
      waiter.signal.removeEventListener("abort", waiter.onAbort);
    }
  };

  const makeReleaser = () => {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = queue.shift();
      if (next) {
        cleanupWaiter(next);
        next.resolve(makeReleaser());
      } else {
        active = Math.max(0, active - 1);
      }
    };
  };

  const acquire = (signal?: AbortSignal): Promise<() => void> => {
    if (signal?.aborted) {
      return Promise.reject(new ConcurrencyLimitError("ABORTED", "请求已取消"));
    }
    if (active < maxConcurrent) {
      active += 1;
      return Promise.resolve(makeReleaser());
    }
    if (maxQueue !== undefined && queue.length >= maxQueue) {
      return Promise.reject(new ConcurrencyLimitError("QUEUE_FULL", "当前生成高峰排队已满，请稍后重试"));
    }

    return new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, signal };
      const removeFromQueue = () => {
        const idx = queue.indexOf(waiter);
        if (idx >= 0) queue.splice(idx, 1);
      };

      if (queueTimeoutMs) {
        waiter.timer = setTimeout(() => {
          removeFromQueue();
          cleanupWaiter(waiter);
          reject(new ConcurrencyLimitError("QUEUE_TIMEOUT", "当前生成高峰排队超时，请稍后重试"));
        }, queueTimeoutMs);
      }

      if (signal) {
        waiter.onAbort = () => {
          removeFromQueue();
          cleanupWaiter(waiter);
          reject(new ConcurrencyLimitError("ABORTED", "请求已取消"));
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }

      queue.push(waiter);
    });
  };

  const run = async <T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> => {
    const release = await acquire(signal);
    try {
      return await fn();
    } finally {
      release();
    }
  };

  return {
    acquire,
    run,
    stats: () => ({ active, queued: queue.length, maxConcurrent, maxQueue }),
  };
}
