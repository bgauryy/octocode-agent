export type NativeProcessSignal = "SIGINT" | "SIGTERM";

export interface NativeSignalSource {
  on(signal: NativeProcessSignal, listener: () => void): void;
  off(signal: NativeProcessSignal, listener: () => void): void;
}

export interface NativeSignalScope {
  readonly interrupted: Promise<NativeProcessSignal>;
  readonly settled: Promise<void>;
  readonly signal: NativeProcessSignal | undefined;
  close(): void;
}

export function nativeSignalExitCode(signal: NativeProcessSignal): 130 | 143 {
  return signal === "SIGINT" ? 130 : 143;
}

export function nativeSignalReason(signal: NativeProcessSignal): string {
  return signal === "SIGINT" ? "user interrupt" : "process terminated";
}

/** Own the first process signal for one bounded runtime operation. */
export function createNativeSignalScope(options: {
  readonly source?: NativeSignalSource;
  readonly onSignal: (signal: NativeProcessSignal) => void | Promise<void>;
}): NativeSignalScope {
  const source = options.source ?? process;
  let claimed: NativeProcessSignal | undefined;
  let closed = false;
  let settled = Promise.resolve();
  let resolveInterrupted!: (signal: NativeProcessSignal) => void;
  const interrupted = new Promise<NativeProcessSignal>((resolve) => {
    resolveInterrupted = resolve;
  });
  const claim = (signal: NativeProcessSignal): void => {
    if (claimed !== undefined || closed) return;
    claimed = signal;
    resolveInterrupted(signal);
    settled = Promise.resolve().then(() => options.onSignal(signal));
  };
  const onSigint = (): void => claim("SIGINT");
  const onSigterm = (): void => claim("SIGTERM");
  source.on("SIGINT", onSigint);
  source.on("SIGTERM", onSigterm);

  return {
    interrupted,
    get settled() {
      return settled;
    },
    get signal() {
      return claimed;
    },
    close() {
      if (closed) return;
      closed = true;
      source.off("SIGINT", onSigint);
      source.off("SIGTERM", onSigterm);
    },
  };
}

/** Await cleanup without allowing a non-cooperative dependency to retain process ownership. */
export async function settleNativeCleanup(
  work: Promise<unknown>,
  timeoutMs: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), Math.max(1, timeoutMs));
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
