import type {
  RpcFailure,
  RpcResult,
  UpdateCheckContext,
  UpdateCheckResult,
} from "../backend";

type LogLevel = "debug" | "info" | "warning" | "error";

export const UPDATE_POLL_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const UPDATE_POLL_INITIAL_DELAY_MS = 30_000;

type TimeoutHandle = ReturnType<typeof globalThis.setTimeout>;
type IntervalHandle = ReturnType<typeof globalThis.setInterval>;

export interface UpdatePollerDeps {
  getUpdateCheckContext(): Promise<RpcResult<UpdateCheckContext>>;
  checkForUpdate(
    currentVersion: string,
    force: boolean,
  ): Promise<UpdateCheckResult>;
  markUpdateNotified(tag: string): Promise<RpcResult<UpdateCheckContext>>;
  notify(title: string, body: string): void;
  log(level: LogLevel, message: string): void;
  setTimeout?: typeof globalThis.setTimeout;
  clearTimeout?: typeof globalThis.clearTimeout;
  setInterval?: typeof globalThis.setInterval;
  clearInterval?: typeof globalThis.clearInterval;
}

export type UpdatePoller = Readonly<{
  start(): void;
  dispose(): void;
}>;

function isRpcStatus(
  result: RpcResult<UpdateCheckContext>,
): result is RpcFailure {
  return (
    typeof result === "object"
    && result !== null
    && "status" in result
    && (result.status === "failed" || result.status === "skipped")
  );
}

export function createUpdatePoller(deps: UpdatePollerDeps): UpdatePoller {
  const scheduleTimeout = deps.setTimeout ?? globalThis.setTimeout;
  const cancelTimeout = deps.clearTimeout ?? globalThis.clearTimeout;
  const scheduleInterval = deps.setInterval ?? globalThis.setInterval;
  const cancelInterval = deps.clearInterval ?? globalThis.clearInterval;

  let started = false;
  let disposed = false;
  let inFlight = false;
  let initialTimer: TimeoutHandle | null = null;
  let intervalTimer: IntervalHandle | null = null;

  const tick = async (): Promise<void> => {
    if (disposed || inFlight) {
      return;
    }
    inFlight = true;

    try {
      const context = await deps.getUpdateCheckContext();
      if (disposed) {
        return;
      }
      if (isRpcStatus(context)) {
        deps.log(
          "warning",
          `Background update context failed: ${context.message ?? context.status}`,
        );
        return;
      }
      if (
        !context.automatic_update_checks
        || context.pending_update_install !== null
      ) {
        return;
      }

      const result = await deps.checkForUpdate(
        context.effective_installed_version,
        false,
      );
      if (disposed) {
        return;
      }
      if (result.status === "failed") {
        deps.log("warning", `Background update check failed: ${result.message}`);
        return;
      }
      if (
        result.status !== "available"
        || result.candidate.tag === context.last_notified_tag
      ) {
        return;
      }

      deps.notify(
        "Deck UI Restored Update Available",
        `v${result.candidate.version} is available. Open the plugin to install.`,
      );
      if (disposed) {
        return;
      }

      const marked = await deps.markUpdateNotified(result.candidate.tag);
      if (!disposed && isRpcStatus(marked)) {
        deps.log(
          "warning",
          `Recording update notification failed: ${marked.message ?? marked.status}`,
        );
      }
    } catch (error) {
      if (!disposed) {
        deps.log("warning", `Background update polling failed: ${String(error)}`);
      }
    } finally {
      inFlight = false;
    }
  };

  return Object.freeze({
    start() {
      if (started || disposed) {
        return;
      }
      started = true;
      initialTimer = scheduleTimeout(() => {
        initialTimer = null;
        if (disposed) {
          return;
        }
        void tick();
        intervalTimer = scheduleInterval(() => {
          void tick();
        }, UPDATE_POLL_INTERVAL_MS);
      }, UPDATE_POLL_INITIAL_DELAY_MS);
    },
    dispose() {
      disposed = true;
      if (initialTimer !== null) {
        cancelTimeout(initialTimer);
        initialTimer = null;
      }
      if (intervalTimer !== null) {
        cancelInterval(intervalTimer);
        intervalTimer = null;
      }
    },
  });
}
