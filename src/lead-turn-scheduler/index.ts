import { resolve } from "node:path";

export type LeadTurnScope = {
  targetProjectPath: string;
  sessionId?: string;
  ownerTurnId?: string;
};

type Work = {
  scope: LeadTurnScope;
  run(signal: AbortSignal): Promise<void>;
  cancel?(): void;
};

/** One Lead executes effects at a time. Owner input takes priority over observations. */
export function createLeadTurnScheduler(input: {
  nextContinuation(): Work | undefined;
  onState?(state: "responding" | "available"): void;
  onError(error: unknown): void;
}) {
  const owners: Work[] = [];
  let active: { kind: "owner" | "continuation"; scope: LeadTurnScope; controller: AbortController } | undefined;
  let draining: Promise<void> | undefined;
  let closed = false;
  let wakeRequested = false;

  const drain = async (): Promise<void> => {
    while (!closed) {
      const owner = owners.shift();
      const work = owner ?? (wakeRequested ? input.nextContinuation() : undefined);
      if (!work) {
        wakeRequested = false;
        break;
      }
      const controller = new AbortController();
      active = { kind: owner ? "owner" : "continuation", scope: work.scope, controller };
      input.onState?.("responding");
      try {
        await work.run(controller.signal);
      } catch (error) {
        input.onError(error);
      } finally {
        active = undefined;
        wakeRequested = true;
      }
      // Let incoming Owner input run before another autonomous turn is selected.
      await new Promise<void>((done) => setImmediate(done));
    }
    input.onState?.("available");
  };
  const wake = (): void => {
    if (closed) return;
    wakeRequested = true;
    if (draining) return;
    draining = Promise.resolve().then(drain).catch((error: unknown) => {
      wakeRequested = false;
      input.onError(error);
    }).finally(() => {
      draining = undefined;
      if (!closed && (owners.length > 0 || wakeRequested)) wake();
    });
  };

  return {
    submitOwner<T>(scope: LeadTurnScope, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
      if (closed) return Promise.reject(new Error("Lead scheduler is closed."));
      const result = Promise.withResolvers<T>();
      owners.push({
        scope,
        cancel: () => result.reject(new Error("Lead scheduler closed before this Owner turn started.")),
        async run(signal) {
          try { result.resolve(await run(signal)); }
          catch (error) { result.reject(error); }
        },
      });
      if (active?.kind === "continuation") active.controller.abort();
      wake();
      return result.promise;
    },
    interrupt(scope: LeadTurnScope): boolean {
      if (!active || !sameProject(active.scope.targetProjectPath, scope.targetProjectPath)) return false;
      if (scope.sessionId && active.scope.sessionId !== scope.sessionId) return false;
      if (scope.ownerTurnId && active.scope.ownerTurnId !== scope.ownerTurnId) return false;
      active.controller.abort();
      return true;
    },
    wake,
    async close(): Promise<void> {
      closed = true;
      active?.controller.abort();
      for (const owner of owners.splice(0)) owner.cancel?.();
      await draining;
    },
  };
}

function sameProject(left: string, right: string): boolean {
  const key = (path: string) => process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);
  return key(left) === key(right);
}
