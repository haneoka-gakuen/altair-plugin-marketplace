import type {
  VegaPluginCatalog,
  VegaPluginLock,
  VegaPluginLockTarget,
  VegaPluginMarketplaceEntry,
} from "@haneoka/vega-protocol";

export const ALTAIR_PLUGIN_CATALOG_FORMAT =
  "vega-plugin-catalog" as const;
export const LEGACY_ALTAIR_PLUGIN_CATALOG_FORMAT =
  "altair-plugin-catalog" as const;
export const ALTAIR_PLUGIN_CATALOG_MAX_BYTES = 2 * 1024 * 1024;
export const ALTAIR_PLUGIN_CATALOG_MAX_ENTRIES = 10_000;
export const ALTAIR_PLUGIN_CATALOG_MAX_URL_LENGTH = 4_096;

export type AltairPluginScope = "authoring" | "runtime" | "host";
export type AltairPluginCatalogEntry = VegaPluginMarketplaceEntry;
export type AltairPluginLock = VegaPluginLock;

/**
 * Metadata understood by the Altair authoring host. Runtime/install metadata
 * remains the canonical Vega marketplace entry.
 */
export interface AltairPluginAuthoringExtension {
  readonly scope?: AltairPluginScope;
  readonly conflicts?: Readonly<Record<string, string>>;
  readonly altairVersion?: string;
  readonly permissions?: readonly string[];
}

export interface AltairPluginCatalogExtensions {
  readonly altair?: {
    readonly entries: Readonly<
      Record<string, AltairPluginAuthoringExtension>
    >;
  };
}

export type AltairPluginCatalog = VegaPluginCatalog & {
  readonly extensions?: AltairPluginCatalogExtensions;
};

export type AltairPluginCatalogSource =
  | {
      readonly kind: "static";
      readonly id: string;
      readonly plugins: readonly VegaPluginMarketplaceEntry[];
      readonly extensions?: AltairPluginCatalogExtensions;
    }
  | {
      readonly kind: "http";
      readonly id: string;
      readonly url: string;
    };

export interface AltairPluginCatalogResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly headers?: { get(name: string): string | null };
  text(): Promise<string>;
}

export type AltairPluginCatalogFetch = (
  url: string,
  init: {
    readonly headers: Readonly<Record<string, string>>;
    readonly signal?: AbortSignal;
  },
) => Promise<AltairPluginCatalogResponse>;

export interface LoadAltairPluginCatalogOptions {
  readonly fetch?: AltairPluginCatalogFetch;
  readonly signal?: AbortSignal;
}

export interface AltairPluginTargetEnvironment
  extends VegaPluginLockTarget {
  readonly altairVersion?: string;
  readonly altairApiVersion?: number;
  readonly grantedPermissions?: readonly string[];
  readonly deniedPermissions?: readonly string[];
}

export interface AltairPluginProjectDiagnostic {
  readonly severity: "error" | "warning";
  readonly code: string;
  readonly pluginId: string;
  readonly relatedPluginId?: string;
  readonly message: string;
}

export interface InstallStoryProjectPluginOptions {
  readonly version?: string;
  readonly required?: boolean;
  readonly environment?: AltairPluginTargetEnvironment;
}

export interface AltairPluginLockResult {
  readonly lock: VegaPluginLock | null;
  readonly entries: readonly VegaPluginMarketplaceEntry[];
  readonly diagnostics: readonly AltairPluginProjectDiagnostic[];
}
