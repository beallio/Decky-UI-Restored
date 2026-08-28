import { info } from "../log";

declare global {
  interface Window {
    DeckyBackend?: {
      callable?: (method: string) => (...args: any[]) => Promise<any>;
      call?: (method: string, ...args: any[]) => Promise<any>;
    };
  }
}

const EXPECTED_PLUGIN_NAME = "Deck UI Restored";
export const INSTALL_TYPE_UPDATE = 2;
export const INSTALL_TYPE_DOWNGRADE = 3;

export function isDeckyInstallerAvailable(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.DeckyBackend === "object" &&
    window.DeckyBackend !== null &&
    (typeof window.DeckyBackend.callable === "function" ||
      typeof window.DeckyBackend.call === "function")
  );
}

export async function invokeDeckyInstaller(
  url: string,
  version: string,
  sha256: string,
  installType: typeof INSTALL_TYPE_UPDATE | typeof INSTALL_TYPE_DOWNGRADE,
  traceId?: string
): Promise<any> {
  const start = performance.now();
  const backend = window.DeckyBackend;
  if (!backend) {
    throw new Error("Decky Loader backend is not available in this environment.");
  }

  const shaPrefix = sha256.slice(0, 8);
  const elapsed = Math.round(performance.now() - start);

  if (typeof backend.callable === "function") {
    // installer_api: "callable"
    info("updater", `handoff_start: trace_id=${traceId || "none"}, version=${version}, sha256_prefix=${shaPrefix}, installer_api="callable", elapsed_ms=${elapsed}`);
    const installFn = backend.callable("utilities/install_plugin");
    return await installFn(url, EXPECTED_PLUGIN_NAME, version, sha256, installType);
  } else if (typeof backend.call === "function") {
    // installer_api: "call"
    info("updater", `handoff_start: trace_id=${traceId || "none"}, version=${version}, sha256_prefix=${shaPrefix}, installer_api="call", elapsed_ms=${elapsed}`);
    return await backend.call("utilities/install_plugin", url, EXPECTED_PLUGIN_NAME, version, sha256, installType);
  } else {
    throw new Error("Decky Loader backend has no compatible RPC interface.");
  }
}
