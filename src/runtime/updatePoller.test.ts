import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { UpdateCheckContext, UpdateCheckResult } from "../backend";
import {
  createUpdatePoller,
  UPDATE_POLL_INITIAL_DELAY_MS,
  UPDATE_POLL_INTERVAL_MS,
  type UpdatePollerDeps,
} from "./updatePoller";

const context = (
  overrides: Partial<UpdateCheckContext> = {},
): UpdateCheckContext => ({
  update_channel: "stable",
  automatic_update_checks: true,
  installed_version: "1.2.2",
  effective_installed_version: "1.2.2",
  last_checked_at: null,
  last_checked_channel: null,
  last_available_tag: null,
  last_notified_tag: null,
  installed_release_tag: null,
  installed_release_published_at: null,
  pending_update_install: null,
  rate_limited_until: null,
  ...overrides,
});

const currentResult = (): UpdateCheckResult => ({
  status: "current",
  checked_at: "2026-07-24T00:00:00Z",
  channel: "stable",
});

const availableResult = (
  tag = "v1.2.3",
): UpdateCheckResult => ({
  status: "available",
  checked_at: "2026-07-24T00:00:00Z",
  candidate: {
    version: "1.2.3",
    tag,
    channel: "stable",
    artifact_url: "https://example.invalid/plugin.zip",
    sha256: "a".repeat(64),
    release_url: "https://example.invalid/release",
    published_at: "2026-07-24T00:00:00Z",
    action: "update",
  },
});

function makeDeps(
  overrides: Partial<UpdatePollerDeps> = {},
): UpdatePollerDeps {
  return {
    getUpdateCheckContext: vi.fn().mockResolvedValue(context()),
    checkForUpdate: vi.fn().mockResolvedValue(currentResult()),
    markUpdateNotified: vi.fn().mockResolvedValue(context()),
    notify: vi.fn(),
    log: vi.fn(),
    ...overrides,
  };
}

describe("createUpdatePoller", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits for the initial delay before checking", async () => {
    const deps = makeDeps();
    const poller = createUpdatePoller(deps);

    poller.start();
    expect(deps.getUpdateCheckContext).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(UPDATE_POLL_INITIAL_DELAY_MS - 1);
    expect(deps.getUpdateCheckContext).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(deps.getUpdateCheckContext).toHaveBeenCalledTimes(1);
  });

  it("checks once per poll interval after the initial tick", async () => {
    const deps = makeDeps();
    const poller = createUpdatePoller(deps);

    poller.start();
    await vi.advanceTimersByTimeAsync(UPDATE_POLL_INITIAL_DELAY_MS);
    await vi.advanceTimersByTimeAsync(UPDATE_POLL_INTERVAL_MS);

    expect(deps.checkForUpdate).toHaveBeenCalledTimes(2);
  });

  it("never forces automatic checks", async () => {
    const deps = makeDeps();
    const poller = createUpdatePoller(deps);

    poller.start();
    await vi.advanceTimersByTimeAsync(UPDATE_POLL_INITIAL_DELAY_MS);

    expect(deps.checkForUpdate).toHaveBeenCalledWith("1.2.2", false);
  });

  it("skips a tick when automatic checks are disabled", async () => {
    const deps = makeDeps({
      getUpdateCheckContext: vi.fn().mockResolvedValue(
        context({ automatic_update_checks: false }),
      ),
    });
    const poller = createUpdatePoller(deps);

    poller.start();
    await vi.advanceTimersByTimeAsync(UPDATE_POLL_INITIAL_DELAY_MS);

    expect(deps.checkForUpdate).not.toHaveBeenCalled();
  });

  it("skips a tick while an update install is pending", async () => {
    const deps = makeDeps({
      getUpdateCheckContext: vi.fn().mockResolvedValue(
        context({
          pending_update_install: {
            version: "1.2.3",
            tag: "v1.2.3",
            channel: "stable",
            published_at: "2026-07-24T00:00:00Z",
            requested_at: "2026-07-24T00:00:00Z",
          },
        }),
      ),
    });
    const poller = createUpdatePoller(deps);

    poller.start();
    await vi.advanceTimersByTimeAsync(UPDATE_POLL_INITIAL_DELAY_MS);

    expect(deps.checkForUpdate).not.toHaveBeenCalled();
  });

  it("notifies and records a newly available tag", async () => {
    const deps = makeDeps({
      checkForUpdate: vi.fn().mockResolvedValue(availableResult()),
    });
    const poller = createUpdatePoller(deps);

    poller.start();
    await vi.advanceTimersByTimeAsync(UPDATE_POLL_INITIAL_DELAY_MS);

    expect(deps.notify).toHaveBeenCalledWith(
      "Decky UI Restored Update Available",
      "v1.2.3 is available. Open the plugin to install.",
    );
    expect(deps.markUpdateNotified).toHaveBeenCalledWith("v1.2.3");
    expect(vi.mocked(deps.notify).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(deps.markUpdateNotified).mock.invocationCallOrder[0],
    );
  });

  it("does not notify for an already-notified tag", async () => {
    const deps = makeDeps({
      getUpdateCheckContext: vi.fn().mockResolvedValue(
        context({ last_notified_tag: "v1.2.3" }),
      ),
      checkForUpdate: vi.fn().mockResolvedValue(availableResult()),
    });
    const poller = createUpdatePoller(deps);

    poller.start();
    await vi.advanceTimersByTimeAsync(UPDATE_POLL_INITIAL_DELAY_MS);

    expect(deps.notify).not.toHaveBeenCalled();
    expect(deps.markUpdateNotified).not.toHaveBeenCalled();
  });

  it("does not notify for current or failed results and keeps scheduling", async () => {
    const failed: UpdateCheckResult = {
      status: "failed",
      checked_at: "2026-07-24T00:00:00Z",
      message: "rate limit cooldown",
    };
    const checkForUpdate = vi
      .fn()
      .mockResolvedValueOnce(failed)
      .mockResolvedValueOnce(currentResult());
    const deps = makeDeps({ checkForUpdate });
    const poller = createUpdatePoller(deps);

    poller.start();
    await vi.advanceTimersByTimeAsync(UPDATE_POLL_INITIAL_DELAY_MS);
    await vi.advanceTimersByTimeAsync(UPDATE_POLL_INTERVAL_MS);

    expect(deps.notify).not.toHaveBeenCalled();
    expect(deps.log).toHaveBeenCalledWith(
      "warning",
      expect.stringContaining("rate limit cooldown"),
    );
    expect(checkForUpdate).toHaveBeenCalledTimes(2);
  });

  it("suppresses overlapping ticks", async () => {
    let resolveCheck: (result: UpdateCheckResult) => void = () => {};
    const checkForUpdate = vi.fn().mockReturnValue(
      new Promise<UpdateCheckResult>((resolve) => {
        resolveCheck = resolve;
      }),
    );
    const deps = makeDeps({ checkForUpdate });
    const poller = createUpdatePoller(deps);

    poller.start();
    await vi.advanceTimersByTimeAsync(UPDATE_POLL_INITIAL_DELAY_MS);
    await vi.advanceTimersByTimeAsync(UPDATE_POLL_INTERVAL_MS);

    expect(checkForUpdate).toHaveBeenCalledTimes(1);

    resolveCheck(currentResult());
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(UPDATE_POLL_INTERVAL_MS);
    expect(checkForUpdate).toHaveBeenCalledTimes(2);
  });

  it("dispose clears the initial timer", async () => {
    const deps = makeDeps();
    const poller = createUpdatePoller(deps);

    poller.start();
    poller.dispose();
    await vi.advanceTimersByTimeAsync(UPDATE_POLL_INITIAL_DELAY_MS);

    expect(deps.getUpdateCheckContext).not.toHaveBeenCalled();
  });

  it("dispose clears the interval and suppresses late check side effects", async () => {
    let resolveCheck: (result: UpdateCheckResult) => void = () => {};
    const checkForUpdate = vi.fn().mockReturnValue(
      new Promise<UpdateCheckResult>((resolve) => {
        resolveCheck = resolve;
      }),
    );
    const deps = makeDeps({ checkForUpdate });
    const poller = createUpdatePoller(deps);

    poller.start();
    await vi.advanceTimersByTimeAsync(UPDATE_POLL_INITIAL_DELAY_MS);
    poller.dispose();
    resolveCheck(availableResult());
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(UPDATE_POLL_INTERVAL_MS);

    expect(checkForUpdate).toHaveBeenCalledTimes(1);
    expect(deps.notify).not.toHaveBeenCalled();
    expect(deps.markUpdateNotified).not.toHaveBeenCalled();
  });

  it("survives thrown RPC errors and checks again later", async () => {
    const checkForUpdate = vi
      .fn()
      .mockRejectedValueOnce(new Error("suspended"))
      .mockResolvedValueOnce(currentResult());
    const deps = makeDeps({ checkForUpdate });
    const poller = createUpdatePoller(deps);

    poller.start();
    await vi.advanceTimersByTimeAsync(UPDATE_POLL_INITIAL_DELAY_MS);
    await vi.advanceTimersByTimeAsync(UPDATE_POLL_INTERVAL_MS);

    expect(deps.log).toHaveBeenCalledWith(
      "warning",
      expect.stringContaining("suspended"),
    );
    expect(checkForUpdate).toHaveBeenCalledTimes(2);
  });
});
