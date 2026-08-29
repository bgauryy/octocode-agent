import { describe, expect, it, vi } from "vitest";

import {
  createNativeSignalScope,
  nativeSignalExitCode,
  type NativeProcessSignal,
  type NativeSignalSource,
} from "../src/native-signal-scope.js";

class TestSignalSource implements NativeSignalSource {
  readonly listeners = new Map<NativeProcessSignal, Set<() => void>>();
  readonly on = vi.fn((signal: NativeProcessSignal, listener: () => void) => {
    const listeners = this.listeners.get(signal) ?? new Set();
    listeners.add(listener);
    this.listeners.set(signal, listeners);
  });
  readonly off = vi.fn((signal: NativeProcessSignal, listener: () => void) => {
    this.listeners.get(signal)?.delete(listener);
  });

  emit(signal: NativeProcessSignal): void {
    for (const listener of this.listeners.get(signal) ?? []) listener();
  }
}

describe("native signal scope", () => {
  it("claims only the first process signal and detaches both handlers", async () => {
    const source = new TestSignalSource();
    const onSignal = vi.fn(async () => undefined);
    const scope = createNativeSignalScope({ source, onSignal });

    source.emit("SIGINT");
    source.emit("SIGTERM");

    await expect(scope.interrupted).resolves.toBe("SIGINT");
    await scope.settled;
    expect(onSignal).toHaveBeenCalledOnce();
    expect(onSignal).toHaveBeenCalledWith("SIGINT");
    scope.close();
    scope.close();
    expect(source.off).toHaveBeenCalledTimes(2);
    expect(
      [...source.listeners.values()].every((listeners) => listeners.size === 0),
    ).toBe(true);
  });

  it("uses conventional interrupt and termination exit statuses", () => {
    expect(nativeSignalExitCode("SIGINT")).toBe(130);
    expect(nativeSignalExitCode("SIGTERM")).toBe(143);
  });
});
