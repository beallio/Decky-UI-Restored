import { callable } from "@decky/api";

export type PluginSettings = {
  feature_enabled: boolean;
  home_carousel_fix_enabled: boolean;
  debug_logging: boolean;
  update_channel: UpdateChannel;
  automatic_update_checks: boolean;
};

export type UpdateChannel = "stable" | "development";

export type PluginUpdateCandidate = {
  version: string;
  tag: string;
  channel: UpdateChannel;
  artifact_url: string;
  sha256: string;
  release_url: string;
  published_at: string;
  action: "update" | "move_to_stable" | "downgrade_to_stable";
};

export type UpdateCheckResult =
  | { status: "available"; checked_at: string; candidate: PluginUpdateCandidate }
  | { status: "current"; checked_at: string; channel?: UpdateChannel }
  | { status: "failed"; checked_at: string; message: string; retry_after?: string };

export type PendingUpdateInstall = {
  version: string;
  tag: string;
  channel: UpdateChannel;
  published_at: string;
  requested_at: string;
  handoff_confirmed_at?: string;
  update_trace_id?: string | null;
};

export type UpdateCheckContext = {
  update_channel: UpdateChannel;
  automatic_update_checks: boolean;
  installed_version: string;
  effective_installed_version: string;
  last_checked_at: string | null;
  last_checked_channel: UpdateChannel | null;
  last_available_tag: string | null;
  last_notified_tag: string | null;
  installed_release_tag: string | null;
  installed_release_published_at: string | null;
  pending_update_install: PendingUpdateInstall | null;
  rate_limited_until: string | null;
};

export type RpcFailure = {
  status: "failed" | "skipped";
  message: string;
  reason?: string;
};

export type RpcResult<T> = T | RpcFailure;
export type RevalidateResult =
  | PluginUpdateCandidate
  | { status: "failed"; message: string; checked_at?: string };

export type Versions = {
  plugin: string;
  decky: string;
  steamos: string;
};

export const getSettings = callable<[], PluginSettings>("get_settings");
export const setFeatureEnabled = callable<[boolean], PluginSettings>(
  "set_feature_enabled",
);
export const setHomeCarouselFixEnabled = callable<[boolean], PluginSettings>(
  "set_home_carousel_fix_enabled",
);
export const setDebugLogging = callable<[boolean], PluginSettings>(
  "set_debug_logging",
);
export const setUpdateChannelCall = callable<[UpdateChannel], PluginSettings>(
  "set_update_channel",
);
export const setAutomaticUpdateChecksCall = callable<[boolean], PluginSettings>(
  "set_automatic_update_checks",
);
export const checkForPluginUpdateCall = callable<
  [currentVersion: string, force: boolean],
  UpdateCheckResult
>("check_for_plugin_update");
export const revalidatePluginUpdateCall = callable<
  [candidate: PluginUpdateCandidate],
  RevalidateResult
>("revalidate_plugin_update");
export const recordUpdateInstallRequestedCall = callable<
  [candidate: PluginUpdateCandidate & { updateTraceId: string }],
  RpcResult<UpdateCheckContext>
>("record_update_install_requested");
export const confirmUpdateInstallHandoffCall = callable<
  [version: string],
  RpcResult<UpdateCheckContext>
>("confirm_update_install_handoff");
export const clearPendingUpdateInstallCall = callable<
  [version: string],
  RpcResult<UpdateCheckContext>
>("clear_pending_update_install");
export const markUpdateNotifiedCall = callable<
  [tag: string],
  RpcResult<UpdateCheckContext>
>("mark_update_notified");
export const getUpdateCheckContextCall = callable<
  [],
  RpcResult<UpdateCheckContext>
>("get_update_check_context");
export const getVersions = callable<[], Versions>("get_versions");
