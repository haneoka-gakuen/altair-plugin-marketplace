import type {
  JsonObject,
  StoryProject,
} from "@haneoka/altair/model";
import {
  defineAltairPlugin,
  defineAltairService,
  type AltairPluginV2,
} from "@haneoka/altair/plugins";
import {
  altairPluginAuthoringExtension,
  loadAltairPluginCatalog,
  mergeAltairPluginCatalogs,
  parseAltairPluginCatalog,
  searchAltairPluginCatalog,
} from "./catalog.js";
import type {
  AltairPluginAuthoringExtension,
  AltairPluginCatalog,
  AltairPluginCatalogEntry,
  AltairPluginCatalogFetch,
  AltairPluginCatalogSource,
  AltairPluginLock,
  AltairPluginLockResult,
  AltairPluginProjectDiagnostic,
  AltairPluginTargetEnvironment,
  InstallStoryProjectPluginOptions,
  LoadAltairPluginCatalogOptions,
} from "./contracts.js";
import {
  configureStoryProjectPlugin,
  createAltairPluginLock,
  diagnoseStoryProjectPlugins,
  installStoryProjectPlugin,
  removeStoryProjectPlugin,
  serializeAltairPluginLock,
  setStoryProjectPluginEnabled,
  setStoryProjectPluginPermissions,
} from "./project.js";

export * from "./catalog.js";
export * from "./contracts.js";
export * from "./project.js";

export const ALTAIR_MARKETPLACE_SERVICE_ID =
  "haneoka.altair.marketplace";

export interface AltairMarketplaceService {
  parseCatalog(value: unknown, fallbackId?: string): AltairPluginCatalog;
  loadCatalog(
    source: AltairPluginCatalogSource,
    options?: LoadAltairPluginCatalogOptions,
  ): Promise<AltairPluginCatalog>;
  mergeCatalogs(
    catalogs: readonly AltairPluginCatalog[],
  ): AltairPluginCatalog;
  search(
    catalog: AltairPluginCatalog,
    query: string,
  ): readonly AltairPluginCatalogEntry[];
  authoringExtension(
    catalog: AltairPluginCatalog,
    entry: Pick<AltairPluginCatalogEntry, "id" | "version">,
  ): AltairPluginAuthoringExtension | undefined;
  install(
    project: StoryProject,
    pluginId: string,
    catalog: AltairPluginCatalog,
    options?: InstallStoryProjectPluginOptions,
  ): StoryProject;
  setEnabled(
    project: StoryProject,
    pluginId: string,
    enabled: boolean,
    catalog: AltairPluginCatalog,
    environment?: AltairPluginTargetEnvironment,
  ): StoryProject;
  configure(
    project: StoryProject,
    pluginId: string,
    configuration: JsonObject,
  ): StoryProject;
  setPermissions(
    project: StoryProject,
    pluginId: string,
    permissions: readonly string[],
  ): StoryProject;
  remove(
    project: StoryProject,
    pluginId: string,
    catalog: AltairPluginCatalog,
  ): StoryProject;
  diagnose(
    project: Pick<StoryProject, "plugins">,
    catalog: AltairPluginCatalog,
    environment?: AltairPluginTargetEnvironment,
  ): readonly AltairPluginProjectDiagnostic[];
  createLock(
    project: Pick<StoryProject, "plugins">,
    catalog: AltairPluginCatalog,
    environment?: AltairPluginTargetEnvironment,
  ): AltairPluginLockResult;
  serializeLock(lock: AltairPluginLock): string;
}

export interface AltairMarketplaceServiceOptions {
  readonly fetch?: AltairPluginCatalogFetch;
}

export const altairMarketplaceServiceKey =
  defineAltairService<AltairMarketplaceService>(
    ALTAIR_MARKETPLACE_SERVICE_ID,
  );

export const createAltairMarketplaceService = (
  options: AltairMarketplaceServiceOptions = {},
): AltairMarketplaceService => {
  if (options.fetch !== undefined && typeof options.fetch !== "function") {
    throw new TypeError("Altair marketplace fetch must be a function");
  }
  const defaultFetch = options.fetch;
  return Object.freeze({
    parseCatalog: (value, fallbackId) =>
      parseAltairPluginCatalog(value, fallbackId),
    loadCatalog(source, loadOptions = {}) {
      const fetch = loadOptions.fetch ?? defaultFetch;
      return loadAltairPluginCatalog(source, {
        ...(fetch === undefined ? {} : { fetch }),
        ...(loadOptions.signal === undefined
          ? {}
          : { signal: loadOptions.signal }),
      });
    },
    mergeCatalogs: (catalogs) =>
      mergeAltairPluginCatalogs(...catalogs),
    search: (catalog, query) =>
      searchAltairPluginCatalog(catalog, query),
    authoringExtension: (catalog, entry) =>
      altairPluginAuthoringExtension(catalog, entry),
    install: (project, pluginId, catalog, installOptions) =>
      installStoryProjectPlugin(
        project,
        pluginId,
        catalog,
        installOptions,
      ),
    setEnabled: (
      project,
      pluginId,
      enabled,
      catalog,
      environment,
    ) =>
      setStoryProjectPluginEnabled(
        project,
        pluginId,
        enabled,
        catalog,
        environment,
      ),
    configure: (project, pluginId, configuration) =>
      configureStoryProjectPlugin(
        project,
        pluginId,
        configuration,
      ),
    setPermissions: (project, pluginId, permissions) =>
      setStoryProjectPluginPermissions(
        project,
        pluginId,
        permissions,
      ),
    remove: (project, pluginId, catalog) =>
      removeStoryProjectPlugin(project, pluginId, catalog),
    diagnose: (project, catalog, environment) =>
      diagnoseStoryProjectPlugins(project, catalog, environment),
    createLock: (project, catalog, environment) =>
      createAltairPluginLock(project, catalog, environment),
    serializeLock: (lock) => serializeAltairPluginLock(lock),
  } satisfies AltairMarketplaceService);
};

const pluginWithService = (
  service: AltairMarketplaceService,
): AltairPluginV2 =>
  defineAltairPlugin({
    manifest: {
      id: "haneoka.altair-marketplace",
      name: "Altair Marketplace",
      version: "0.1.0",
      apiVersion: 2,
      description:
        "Metadata-only catalog and project plugin management service",
      capabilities: ["services"],
    },
    setup(context) {
      context.provide(altairMarketplaceServiceKey, service);
    },
  });

export const createAltairMarketplacePlugin = (
  options: AltairMarketplaceServiceOptions = {},
): AltairPluginV2 =>
  pluginWithService(createAltairMarketplaceService(options));

export const altairMarketplaceService =
  createAltairMarketplaceService();

export const altairMarketplacePlugin = pluginWithService(
  altairMarketplaceService,
);

export default altairMarketplacePlugin;
