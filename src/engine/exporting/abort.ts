export function exportAbortError(): DOMException {
  return new DOMException('動画の書き出しをキャンセルしました。', 'AbortError');
}

export function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw exportAbortError();
}

/** Stop waiting for preparation/probes while observing any later rejection. */
export function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const abort = () => { cleanup(); reject(exportAbortError()); };
    const cleanup = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    if (signal.aborted) abort();
  });
}
