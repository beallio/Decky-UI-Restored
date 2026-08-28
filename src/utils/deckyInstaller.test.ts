import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../log", () => ({ info: vi.fn() }));

import {
  INSTALL_TYPE_DOWNGRADE,
  INSTALL_TYPE_UPDATE,
  invokeDeckyInstaller,
  isDeckyInstallerAvailable,
} from "./deckyInstaller";

describe("deckyInstaller", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {},
    });
  });

  it("reports availability only for supported Decky APIs", () => {
    expect(isDeckyInstallerAvailable()).toBe(false);
    (window as any).DeckyBackend = { callable: vi.fn() };
    expect(isDeckyInstallerAvailable()).toBe(true);
    (window as any).DeckyBackend = { call: vi.fn() };
    expect(isDeckyInstallerAvailable()).toBe(true);
  });

  it("uses callable with the display identity and update type", async () => {
    const install = vi.fn().mockResolvedValue(undefined);
    const callable = vi.fn().mockReturnValue(install);
    (window as any).DeckyBackend = { callable };

    await invokeDeckyInstaller(
      "https://example/Decky-SteamAchievements.zip",
      "1.2.3",
      "a".repeat(64),
      INSTALL_TYPE_UPDATE,
    );

    expect(callable).toHaveBeenCalledWith("utilities/install_plugin");
    expect(install).toHaveBeenCalledWith(
      "https://example/Decky-SteamAchievements.zip",
      "Decky UI Restored",
      "1.2.3",
      "a".repeat(64),
      2,
    );
  });

  it("uses legacy call with the display identity and downgrade type", async () => {
    const call = vi.fn().mockResolvedValue(undefined);
    (window as any).DeckyBackend = { call };

    await invokeDeckyInstaller(
      "https://example/Decky-SteamAchievements.zip",
      "1.2.2",
      "b".repeat(64),
      INSTALL_TYPE_DOWNGRADE,
    );

    expect(call).toHaveBeenCalledWith(
      "utilities/install_plugin",
      "https://example/Decky-SteamAchievements.zip",
      "Decky UI Restored",
      "1.2.2",
      "b".repeat(64),
      3,
    );
  });
});
