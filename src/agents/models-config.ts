import fs from "node:fs/promises";
import path from "node:path";
import {
  getRuntimeConfig,
  getRuntimeConfigSourceSnapshot,
  projectConfigOntoRuntimeSourceSnapshot,
  type OpenClawConfig,
} from "../config/config.js";
import { createConfigRuntimeEnv } from "../config/env-vars.js";
import { getCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-snapshot.js";
import { resolveInstalledManifestRegistryIndexFingerprint } from "../plugins/manifest-registry-installed.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { resolveOpenClawAgentDir } from "./agent-paths.js";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "./agent-scope.js";
import { MODELS_JSON_STATE } from "./models-config-state.js";
import { planOpenClawModelsJson } from "./models-config.plan.js";

export { resetModelsJsonReadyCacheForTest } from "./models-config-state.js";

async function readFileMtimeMs(pathname: string): Promise<number | null> {
  try {
    const stat = await fs.stat(pathname);
    return Number.isFinite(stat.mtimeMs) ? stat.mtimeMs : null;
  } catch {
    return null;
  }
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).toSorted(([a], [b]) =>
    a.localeCompare(b),
  );
  return `{${entries
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
    .join(",")}}`;
}

async function buildModelsJsonFingerprint(params: {
  config: OpenClawConfig;
  sourceConfigForSecrets: OpenClawConfig;
  agentDir: string;
  workspaceDir?: string;
  pluginMetadataSnapshot?: Pick<PluginMetadataSnapshot, "index">;
  providerDiscoveryProviderIds?: readonly string[];
  providerDiscoveryTimeoutMs?: number;
}): Promise<string> {
  const authProfilesMtimeMs = await readFileMtimeMs(
    path.join(params.agentDir, "auth-profiles.json"),
  );
  const envShape = createConfigRuntimeEnv(params.config, {});
  const pluginMetadataSnapshotIndexFingerprint = params.pluginMetadataSnapshot
    ? resolveInstalledManifestRegistryIndexFingerprint(params.pluginMetadataSnapshot.index)
    : undefined;
  // Note: modelsFileMtimeMs is intentionally excluded. Including it caused a
  // cache invalidation bug: after planOpenClawModelsJson writes models.json,
  // the stored fingerprint (computed pre-write) no longer matches the new mtime,
  // forcing every subsequent caller to re-run planOpenClawModelsJson. The content
  // comparison inside planOpenClawModelsJson already handles external changes.
  return stableStringify({
    config: params.config,
    sourceConfigForSecrets: params.sourceConfigForSecrets,
    envShape,
    authProfilesMtimeMs,
    workspaceDir: params.workspaceDir,
    pluginMetadataSnapshotIndexFingerprint,
    providerDiscoveryProviderIds: params.providerDiscoveryProviderIds,
    providerDiscoveryTimeoutMs: params.providerDiscoveryTimeoutMs,
  });
}

async function readExistingModelsFile(pathname: string): Promise<{
  raw: string;
  parsed: unknown;
}> {
  try {
    const raw = await fs.readFile(pathname, "utf8");
    return {
      raw,
      parsed: JSON.parse(raw) as unknown,
    };
  } catch {
    return {
      raw: "",
      parsed: null,
    };
  }
}

export async function ensureModelsFileModeForModelsJson(pathname: string): Promise<void> {
  await fs.chmod(pathname, 0o600).catch(() => {
    // best-effort
  });
}

export async function writeModelsFileAtomicForModelsJson(
  targetPath: string,
  contents: string,
): Promise<void> {
  const tempPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempPath, contents, { mode: 0o600 });
  await fs.rename(tempPath, targetPath);
}

function resolveModelsConfigInput(config?: OpenClawConfig): {
  config: OpenClawConfig;
  sourceConfigForSecrets: OpenClawConfig;
} {
  const runtimeSource = getRuntimeConfigSourceSnapshot();
  if (!config) {
    const loaded = getRuntimeConfig();
    return {
      config: runtimeSource ?? loaded,
      sourceConfigForSecrets: runtimeSource ?? loaded,
    };
  }
  if (!runtimeSource) {
    return {
      config,
      sourceConfigForSecrets: config,
    };
  }
  const projected = projectConfigOntoRuntimeSourceSnapshot(config);
  return {
    config: projected,
    // If projection is skipped (for example incompatible top-level shape),
    // keep managed secret persistence anchored to the active source snapshot.
    sourceConfigForSecrets: projected === config ? runtimeSource : projected,
  };
}

async function withModelsJsonWriteLock<T>(targetPath: string, run: () => Promise<T>): Promise<T> {
  const prior = MODELS_JSON_STATE.writeLocks.get(targetPath) ?? Promise.resolve();
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pending = prior.then(() => gate);
  MODELS_JSON_STATE.writeLocks.set(targetPath, pending);
  try {
    await prior;
    return await run();
  } finally {
    release();
    if (MODELS_JSON_STATE.writeLocks.get(targetPath) === pending) {
      MODELS_JSON_STATE.writeLocks.delete(targetPath);
    }
  }
}

export async function ensureOpenClawModelsJson(
  config?: OpenClawConfig,
  agentDirOverride?: string,
  options: {
    pluginMetadataSnapshot?: Pick<PluginMetadataSnapshot, "index" | "manifestRegistry" | "owners">;
    workspaceDir?: string;
    providerDiscoveryProviderIds?: readonly string[];
    providerDiscoveryTimeoutMs?: number;
  } = {},
): Promise<{ agentDir: string; wrote: boolean }> {
  const resolved = resolveModelsConfigInput(config);
  const cfg = resolved.config;
  const workspaceDir =
    options.workspaceDir ??
    (agentDirOverride?.trim()
      ? undefined
      : resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg)));
  const pluginMetadataSnapshot =
    options.pluginMetadataSnapshot ??
    getCurrentPluginMetadataSnapshot({
      config: cfg,
      ...(workspaceDir ? { workspaceDir } : {}),
    });
  const agentDir = agentDirOverride?.trim() ? agentDirOverride.trim() : resolveOpenClawAgentDir();
  const targetPath = path.join(agentDir, "models.json");

  // Fast path: if models.json has not changed since the last noop result, return
  // immediately. This is safe because a noop result means the generated content
  // already matches what is on disk, so no caller's config variant can produce
  // a different outcome. Keying by mtime rather than fingerprint avoids repeated
  // planOpenClawModelsJson runs when agents with different configs (e.g. main
  // agent vs active-memory subagent) call this function concurrently.
  const currentMtime = await readFileMtimeMs(targetPath);
  const noopCached = MODELS_JSON_STATE.noopCache.get(targetPath);
  // Only use the noop cache when the file exists (mtime !== null). A null mtime
  // means models.json was absent; caching null would match any future absent-file
  // state even if the environment changed (e.g. an API key was added), preventing
  // regeneration until the next mtime change.
  if (noopCached && currentMtime !== null && noopCached.mtime === currentMtime) {
    await ensureModelsFileModeForModelsJson(targetPath);
    return noopCached.result;
  }

  const fingerprint = await buildModelsJsonFingerprint({
    config: cfg,
    sourceConfigForSecrets: resolved.sourceConfigForSecrets,
    agentDir,
    ...(workspaceDir ? { workspaceDir } : {}),
    ...(pluginMetadataSnapshot ? { pluginMetadataSnapshot } : {}),
    ...(options.providerDiscoveryProviderIds
      ? { providerDiscoveryProviderIds: options.providerDiscoveryProviderIds }
      : {}),
    ...(options.providerDiscoveryTimeoutMs !== undefined
      ? { providerDiscoveryTimeoutMs: options.providerDiscoveryTimeoutMs }
      : {}),
  });
  const cached = MODELS_JSON_STATE.readyCache.get(targetPath);
  if (cached) {
    const settled = await cached;
    if (settled.fingerprint === fingerprint) {
      await ensureModelsFileModeForModelsJson(targetPath);
      return settled.result;
    }
  }

  const pending = withModelsJsonWriteLock(targetPath, async () => {
    // Ensure config env vars (e.g. AWS_PROFILE, AWS_ACCESS_KEY_ID) are
    // are available to provider discovery without mutating process.env.
    const env = createConfigRuntimeEnv(cfg);
    const existingModelsFile = await readExistingModelsFile(targetPath);
    const plan = await planOpenClawModelsJson({
      cfg,
      sourceConfigForSecrets: resolved.sourceConfigForSecrets,
      agentDir,
      env,
      ...(workspaceDir ? { workspaceDir } : {}),
      existingRaw: existingModelsFile.raw,
      existingParsed: existingModelsFile.parsed,
      ...(pluginMetadataSnapshot ? { pluginMetadataSnapshot } : {}),
      ...(options.providerDiscoveryProviderIds
        ? { providerDiscoveryProviderIds: options.providerDiscoveryProviderIds }
        : {}),
      ...(options.providerDiscoveryTimeoutMs !== undefined
        ? { providerDiscoveryTimeoutMs: options.providerDiscoveryTimeoutMs }
        : {}),
    });

    if (plan.action === "skip") {
      return { fingerprint, result: { agentDir, wrote: false } };
    }

    if (plan.action === "noop") {
      await ensureModelsFileModeForModelsJson(targetPath);
      return { fingerprint, result: { agentDir, wrote: false } };
    }

    await fs.mkdir(agentDir, { recursive: true, mode: 0o700 });
    await writeModelsFileAtomicForModelsJson(targetPath, plan.contents);
    await ensureModelsFileModeForModelsJson(targetPath);
    return { fingerprint, result: { agentDir, wrote: true } };
  });
  MODELS_JSON_STATE.readyCache.set(targetPath, pending);
  try {
    const settled = await pending;
    // Populate the noop cache so subsequent callers with different configs can
    // skip planOpenClawModelsJson as long as models.json has not changed.
    if (!settled.result.wrote) {
      const newMtime = await readFileMtimeMs(targetPath);
      // Only cache when models.json exists (mtime !== null) to avoid matching
      // future absent-file states where the environment may have changed.
      if (newMtime !== null) {
        MODELS_JSON_STATE.noopCache.set(targetPath, { mtime: newMtime, result: settled.result });
      }
    } else {
      // A write occurred — invalidate the noop cache so the new mtime is picked up.
      MODELS_JSON_STATE.noopCache.delete(targetPath);
    }
    return settled.result;
  } catch (error) {
    if (MODELS_JSON_STATE.readyCache.get(targetPath) === pending) {
      MODELS_JSON_STATE.readyCache.delete(targetPath);
    }
    throw error;
  }
}
