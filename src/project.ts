import {
  cloneStoryValue,
  type JsonObject,
  type JsonValue,
  type StoryProject,
  type StoryProjectPlugin,
} from "@haneoka/altair/model";
import {
  assertVegaPluginLock,
  type VegaPluginInstallSource,
  type VegaPluginLock,
  type VegaPluginLockTarget,
  type VegaPluginMarketplaceEntry,
  type VegaProjectPlugin,
} from "@haneoka/vega-protocol";
import {
  createVegaPluginLock,
  normalizeVegaPluginCatalog,
  resolveVegaPluginDependencies,
  satisfiesVegaSemVer,
  vegaPluginSourceKey,
  type VegaPluginResolutionDiagnostic,
} from "@haneoka/vega/marketplace";
import { altairPluginAuthoringExtension } from "./catalog.js";
import type {
  AltairPluginCatalog,
  AltairPluginLockResult,
  AltairPluginProjectDiagnostic,
  AltairPluginTargetEnvironment,
  InstallStoryProjectPluginOptions,
} from "./contracts.js";

const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const isSafeJsonValue = (value: unknown, seen = new Set<object>()): value is JsonValue => {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (!value || typeof value !== "object" || seen.has(value)) {
    return false;
  }
  seen.add(value);
  const acceptable = Array.isArray(value)
    ? value.every((entry) => isSafeJsonValue(entry, seen))
    : Object.entries(value).every(([key, entry]) => !DANGEROUS_KEYS.has(key) && isSafeJsonValue(entry, seen));
  seen.delete(value);
  return acceptable;
};

const exactEntryFor = (
  catalog: AltairPluginCatalog,
  plugin: Pick<StoryProjectPlugin, "id" | "version" | "source">,
): VegaPluginMarketplaceEntry | undefined =>
  catalog.plugins.find(
    (entry) =>
      entry.id === plugin.id &&
      entry.version === plugin.version &&
      (plugin.source === undefined || vegaPluginSourceKey(entry.source) === vegaPluginSourceKey(plugin.source)),
  );

const entryFor = (
  catalog: AltairPluginCatalog,
  id: string,
  range: string,
  source?: VegaPluginInstallSource,
): VegaPluginMarketplaceEntry | undefined =>
  catalog.plugins.find(
    (entry) =>
      entry.id === id &&
      satisfiesVegaSemVer(entry.version, range) &&
      (source === undefined || vegaPluginSourceKey(entry.source) === vegaPluginSourceKey(source)),
  );

const normalizedProjectPlugins = (plugins: readonly StoryProjectPlugin[] | undefined): StoryProjectPlugin[] =>
  [...cloneStoryValue(plugins ?? [])].sort((left, right) => left.id.localeCompare(right.id));

const withProjectPlugins = (project: StoryProject, plugins: readonly StoryProjectPlugin[]): StoryProject => ({
  ...project,
  plugins: normalizedProjectPlugins(plugins),
});

const lockTarget = (environment: AltairPluginTargetEnvironment): VegaPluginLockTarget | undefined => {
  const target = {
    ...(environment.runtime ? { runtime: environment.runtime } : {}),
    ...(environment.platform ? { platform: environment.platform } : {}),
    ...(environment.architecture ? { architecture: environment.architecture } : {}),
    ...(environment.engineVersion ? { engineVersion: environment.engineVersion } : {}),
    ...(environment.apiVersion !== undefined ? { apiVersion: environment.apiVersion } : {}),
  };
  return Object.keys(target).length ? target : undefined;
};

const resolutionRequest = (plugin: StoryProjectPlugin): VegaProjectPlugin => {
  const { enabled: _enabled, required: _required, ...canonical } = plugin;
  return {
    ...cloneStoryValue(canonical),
    required: true,
  };
};

const enabledRequests = (plugins: readonly StoryProjectPlugin[] | undefined): VegaProjectPlugin[] =>
  (plugins ?? []).filter(({ enabled }) => enabled !== false).map(resolutionRequest);

const mapResolutionDiagnostic = (value: VegaPluginResolutionDiagnostic): AltairPluginProjectDiagnostic => ({
  severity: value.severity,
  code: value.code,
  pluginId: value.pluginId ?? "project",
  message: value.message,
  ...(value.relatedPluginId ? { relatedPluginId: value.relatedPluginId } : {}),
});

interface ScopedPluginResolution {
  readonly entries: readonly VegaPluginMarketplaceEntry[];
  readonly runtimeEntries: readonly VegaPluginMarketplaceEntry[];
  readonly diagnostics: readonly AltairPluginProjectDiagnostic[];
}

/**
 * Authoring plugins execute in Altair; runtime and host plugins execute in
 * Vega. Each root is therefore resolved against the host which executes it.
 */
const resolveScopedPluginRequests = (
  requests: readonly VegaProjectPlugin[],
  catalog: AltairPluginCatalog,
  environment: AltairPluginTargetEnvironment,
): ScopedPluginResolution => {
  const authoringRequests: VegaProjectPlugin[] = [];
  const runtimeRequests: VegaProjectPlugin[] = [];
  for (const request of requests) {
    const entry = entryFor(catalog, request.id, request.version, request.source);
    if (entry && altairPluginAuthoringExtension(catalog, entry)?.scope === "authoring") {
      authoringRequests.push(request);
    } else {
      runtimeRequests.push(request);
    }
  }
  const permissions = {
    ...(environment.grantedPermissions
      ? {
          grantedPermissions: environment.grantedPermissions,
        }
      : {}),
    ...(environment.deniedPermissions ? { deniedPermissions: environment.deniedPermissions } : {}),
  };
  const runtimeTarget = lockTarget(environment);
  const authoring = resolveVegaPluginDependencies(catalog.plugins, {
    plugins: authoringRequests,
    target: {
      ...(runtimeTarget ?? {}),
      runtime: "altair",
      apiVersion: environment.altairApiVersion ?? 2,
    },
    ...permissions,
  });
  const runtime = resolveVegaPluginDependencies(catalog.plugins, {
    plugins: runtimeRequests,
    ...(runtimeTarget ? { target: runtimeTarget } : {}),
    ...permissions,
  });
  return {
    entries: normalizeVegaPluginCatalog([...authoring.entries, ...runtime.entries]),
    runtimeEntries: runtime.entries,
    diagnostics: [...authoring.diagnostics, ...runtime.diagnostics].map(mapResolutionDiagnostic),
  };
};

const pushDiagnostic = (diagnostics: AltairPluginProjectDiagnostic[], value: AltairPluginProjectDiagnostic): void => {
  if (
    diagnostics.some(
      (entry) =>
        entry.code === value.code &&
        entry.pluginId === value.pluginId &&
        entry.relatedPluginId === value.relatedPluginId,
    )
  ) {
    return;
  }
  diagnostics.push(value);
};

const authoringDiagnostics = (
  project: Pick<StoryProject, "plugins">,
  catalog: AltairPluginCatalog,
  environment: AltairPluginTargetEnvironment,
  selectedEntries: readonly VegaPluginMarketplaceEntry[],
): AltairPluginProjectDiagnostic[] => {
  const diagnostics: AltairPluginProjectDiagnostic[] = [];
  const enabled = (project.plugins ?? []).filter(({ enabled }) => enabled !== false);
  const byId = new Map(enabled.map((plugin) => [plugin.id, plugin]));
  for (const plugin of project.plugins ?? []) {
    if (plugin.required && plugin.enabled === false) {
      pushDiagnostic(diagnostics, {
        severity: "error",
        code: "altair-required-plugin-disabled",
        pluginId: plugin.id,
        message: "A required project plugin cannot be disabled",
      });
    }
  }
  for (const entry of selectedEntries) {
    const extension = altairPluginAuthoringExtension(catalog, entry);
    if (extension?.altairVersion && environment.altairVersion === undefined) {
      pushDiagnostic(diagnostics, {
        severity: "warning",
        code: "altair-version-unverified",
        pluginId: entry.id,
        message: `Altair compatibility ${extension.altairVersion} has not been verified`,
      });
    } else if (
      extension?.altairVersion &&
      environment.altairVersion &&
      !satisfiesVegaSemVer(environment.altairVersion, extension.altairVersion)
    ) {
      pushDiagnostic(diagnostics, {
        severity: "error",
        code: "altair-version-incompatible",
        pluginId: entry.id,
        message: `${entry.id} requires Altair ${extension.altairVersion}, found ${environment.altairVersion}`,
      });
    }
    for (const [conflictId, range] of Object.entries(extension?.conflicts ?? {})) {
      const conflict = byId.get(conflictId);
      if (conflict && satisfiesVegaSemVer(conflict.version, range)) {
        pushDiagnostic(diagnostics, {
          severity: "error",
          code: "altair-plugin-conflict",
          pluginId: entry.id,
          relatedPluginId: conflictId,
          message: `${entry.id} conflicts with ${conflictId}@${range}`,
        });
      }
    }
    const requiredPermissions = extension?.permissions ?? [];
    const granted = new Set([...(environment.grantedPermissions ?? []), ...(byId.get(entry.id)?.permissions ?? [])]);
    const denied = new Set(environment.deniedPermissions ?? []);
    const rejected = requiredPermissions.filter((permission) => denied.has(permission));
    if (rejected.length) {
      pushDiagnostic(diagnostics, {
        severity: "error",
        code: "altair-authoring-permission-denied",
        pluginId: entry.id,
        message: `${entry.id} requires denied Altair permissions: ${rejected.join(", ")}`,
      });
    }
    const unreviewed = requiredPermissions.filter((permission) => !denied.has(permission) && !granted.has(permission));
    if (unreviewed.length) {
      pushDiagnostic(diagnostics, {
        severity: "warning",
        code: "altair-authoring-permission-review-required",
        pluginId: entry.id,
        message: `${entry.id} requires Altair permission review: ${unreviewed.join(", ")}`,
      });
    }
  }
  return diagnostics;
};

const resolveProjectPlugins = (
  project: Pick<StoryProject, "plugins">,
  catalog: AltairPluginCatalog,
  environment: AltairPluginTargetEnvironment,
): AltairPluginLockResult => {
  const resolution = resolveScopedPluginRequests(enabledRequests(project.plugins), catalog, environment);
  const diagnostics = [
    ...resolution.diagnostics,
    ...authoringDiagnostics(project, catalog, environment, resolution.entries),
  ];
  const hasErrors = diagnostics.some(({ severity }) => severity === "error");
  const runtimeIds = new Set(resolution.runtimeEntries.map(({ id }) => id));
  const hasUnreviewedRuntimePermissions = diagnostics.some(
    ({ code, pluginId }) => code === "permission-review-required" && runtimeIds.has(pluginId),
  );
  let lock: VegaPluginLock | null = null;
  if (!hasErrors && !hasUnreviewedRuntimePermissions) {
    const runtimeEntries = resolution.runtimeEntries;
    const crossScopeDependency = runtimeEntries.find((entry) =>
      Object.keys(entry.dependencies ?? {}).some(
        (id) => !runtimeIds.has(id) && resolution.entries.some(({ id: selectedId }) => selectedId === id),
      ),
    );
    if (crossScopeDependency) {
      diagnostics.push({
        severity: "error",
        code: "altair-authoring-runtime-dependency",
        pluginId: crossScopeDependency.id,
        message: `${crossScopeDependency.id} has a runtime dependency on an authoring-only plugin`,
      });
    } else {
      const projectDependencies = Object.fromEntries(
        (project.plugins ?? [])
          .filter(
            (plugin) => plugin.enabled !== false && runtimeIds.has(plugin.id) && plugin.dependencies !== undefined,
          )
          .map((plugin) => [plugin.id, plugin.dependencies!]),
      );
      lock = createVegaPluginLock(runtimeEntries, lockTarget(environment), projectDependencies);
    }
  }
  return {
    lock,
    entries: resolution.entries,
    diagnostics: diagnostics.sort(
      (left, right) =>
        (left.severity === right.severity ? 0 : left.severity === "error" ? -1 : 1) ||
        left.pluginId.localeCompare(right.pluginId) ||
        left.code.localeCompare(right.code),
    ),
  };
};

/**
 * Record a canonical marketplace release and all resolved dependencies.
 * Resolution is metadata-only and never imports executable plugin code.
 */
export const installStoryProjectPlugin = (
  project: StoryProject,
  pluginId: string,
  catalog: AltairPluginCatalog,
  options: InstallStoryProjectPluginOptions = {},
): StoryProject => {
  const current = normalizedProjectPlugins(project.plugins);
  const existing = current.find(({ id }) => id === pluginId);
  const requestedVersion = options.version ?? existing?.version ?? "*";
  const selected = entryFor(catalog, pluginId, requestedVersion, existing?.source);
  if (!selected) {
    throw new Error(`No marketplace release of ${pluginId} satisfies ${requestedVersion}`);
  }
  const requests = enabledRequests(current.filter(({ id }) => id !== pluginId));
  requests.push({
    ...(existing ? resolutionRequest(existing) : {}),
    id: selected.id,
    version: selected.version,
    required: true,
    source: cloneStoryValue(selected.source),
  });
  const resolution = resolveScopedPluginRequests(requests, catalog, options.environment ?? {});
  if (resolution.diagnostics.some(({ severity }) => severity === "error")) {
    throw new Error(
      resolution.diagnostics
        .filter(({ severity }) => severity === "error")
        .map(({ message }) => message)
        .join("; ") || `Unable to resolve ${pluginId}`,
    );
  }
  const resolvedIds = new Set(resolution.entries.map(({ id }) => id));
  const disabledUnrelated = current.filter((plugin) => plugin.enabled === false && !resolvedIds.has(plugin.id));
  const resolved = resolution.entries.map((entry): StoryProjectPlugin => {
    const previous = current.find(({ id }) => id === entry.id);
    const extension = altairPluginAuthoringExtension(catalog, entry);
    const selectedTargets = entry.targets ?? previous?.targets;
    const targets =
      extension?.scope === "authoring"
        ? {
            ...(selectedTargets ? cloneStoryValue(selectedTargets) : {}),
            runtimes: ["altair"],
          }
        : selectedTargets
          ? cloneStoryValue(selectedTargets)
          : undefined;
    return {
      id: entry.id,
      version: entry.version,
      enabled: true,
      ...(previous?.required || (entry.id === pluginId && options.required === true) ? { required: true } : {}),
      ...(previous?.configuration
        ? {
            configuration: cloneStoryValue(previous.configuration),
          }
        : {}),
      ...(previous?.capabilities
        ? {
            capabilities: cloneStoryValue(previous.capabilities),
          }
        : {}),
      ...(previous?.permissions
        ? {
            permissions: cloneStoryValue(previous.permissions),
          }
        : {}),
      ...(previous?.dependencies
        ? {
            dependencies: cloneStoryValue(previous.dependencies),
          }
        : {}),
      ...(targets ? { targets } : {}),
      source: cloneStoryValue(entry.source),
    };
  });
  return withProjectPlugins(project, [...disabledUnrelated, ...resolved]);
};

const dependantsOf = (
  project: Pick<StoryProject, "plugins">,
  pluginId: string,
  catalog: AltairPluginCatalog,
  enabledOnly: boolean,
): StoryProjectPlugin[] =>
  (project.plugins ?? []).filter((plugin) => {
    if (plugin.id === pluginId || (enabledOnly && plugin.enabled === false)) {
      return false;
    }
    const entry = exactEntryFor(catalog, plugin);
    return Object.hasOwn(entry?.dependencies ?? {}, pluginId) || Object.hasOwn(plugin.dependencies ?? {}, pluginId);
  });

export const setStoryProjectPluginEnabled = (
  project: StoryProject,
  pluginId: string,
  enabled: boolean,
  catalog: AltairPluginCatalog,
  environment: AltairPluginTargetEnvironment = {},
): StoryProject => {
  const plugin = project.plugins?.find((entry) => entry.id === pluginId);
  if (!plugin) {
    throw new Error(`Project plugin is not installed: ${pluginId}`);
  }
  if (enabled) {
    return installStoryProjectPlugin(project, pluginId, catalog, {
      version: plugin.version,
      ...(plugin.required ? { required: true } : {}),
      environment,
    });
  }
  if (plugin.required) {
    throw new Error(`Required plugin cannot be disabled: ${pluginId}`);
  }
  const dependants = dependantsOf(project, pluginId, catalog, true);
  if (dependants.length) {
    throw new Error(`${pluginId} is required by ${dependants.map(({ id }) => id).join(", ")}`);
  }
  return withProjectPlugins(
    project,
    (project.plugins ?? []).map((entry) => (entry.id === pluginId ? { ...entry, enabled: false } : entry)),
  );
};

export const configureStoryProjectPlugin = (
  project: StoryProject,
  pluginId: string,
  configuration: JsonObject,
): StoryProject => {
  if (!isRecord(configuration) || !isSafeJsonValue(configuration)) {
    throw new TypeError("Plugin configuration must be a safe JSON object");
  }
  if (!project.plugins?.some(({ id }) => id === pluginId)) {
    throw new Error(`Project plugin is not installed: ${pluginId}`);
  }
  return withProjectPlugins(
    project,
    project.plugins.map((plugin) =>
      plugin.id === pluginId
        ? {
            ...plugin,
            configuration: cloneStoryValue(configuration),
          }
        : plugin,
    ),
  );
};

export const setStoryProjectPluginPermissions = (
  project: StoryProject,
  pluginId: string,
  permissions: readonly string[],
): StoryProject => {
  if (!project.plugins?.some(({ id }) => id === pluginId)) {
    throw new ReferenceError(`Plugin is not installed: ${pluginId}`);
  }
  const normalized = [
    ...new Set(
      permissions.map((permission) => {
        if (typeof permission !== "string" || !permission.trim()) {
          throw new TypeError("Plugin permissions must be non-empty strings");
        }
        return permission.trim();
      }),
    ),
  ].sort((left, right) => left.localeCompare(right));
  return withProjectPlugins(
    project,
    project.plugins.map((plugin) => {
      if (plugin.id !== pluginId) return plugin;
      const { permissions: _permissions, ...withoutPermissions } = plugin;
      return normalized.length
        ? {
            ...withoutPermissions,
            permissions: normalized,
          }
        : withoutPermissions;
    }),
  );
};

export const removeStoryProjectPlugin = (
  project: StoryProject,
  pluginId: string,
  catalog: AltairPluginCatalog,
): StoryProject => {
  const plugin = project.plugins?.find((entry) => entry.id === pluginId);
  if (!plugin) return project;
  if (plugin.required) {
    throw new Error(`Required plugin cannot be removed: ${pluginId}`);
  }
  const dependants = dependantsOf(project, pluginId, catalog, false);
  if (dependants.length) {
    throw new Error(`${pluginId} is required by ${dependants.map(({ id }) => id).join(", ")}`);
  }
  return withProjectPlugins(
    project,
    (project.plugins ?? []).filter(({ id }) => id !== pluginId),
  );
};

export const diagnoseStoryProjectPlugins = (
  project: Pick<StoryProject, "plugins">,
  catalog: AltairPluginCatalog,
  environment: AltairPluginTargetEnvironment = {},
): readonly AltairPluginProjectDiagnostic[] => resolveProjectPlugins(project, catalog, environment).diagnostics;

export const createAltairPluginLock = (
  project: Pick<StoryProject, "plugins">,
  catalog: AltairPluginCatalog,
  environment: AltairPluginTargetEnvironment = {},
): AltairPluginLockResult => resolveProjectPlugins(project, catalog, environment);

export const serializeAltairPluginLock = (lock: VegaPluginLock): string => {
  assertVegaPluginLock(lock);
  return `${JSON.stringify(lock, null, 2)}\n`;
};
