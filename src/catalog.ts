import {
  assertVegaPluginCatalog,
  assertVegaPluginMarketplaceEntry,
  type VegaPluginInstallSource,
  type VegaPluginCatalog,
  type VegaPluginMarketplaceEntry,
  type VegaPluginTargets,
} from "@haneoka/vega-protocol";
import {
  isValidVegaSemVerRange,
  normalizeVegaPluginCatalog,
  parseVegaSemVer,
  searchVegaPluginCatalog,
  VegaStaticPluginCatalog,
  type VegaPluginCatalogProvider,
} from "@haneoka/vega/marketplace";
import {
  ALTAIR_PLUGIN_CATALOG_FORMAT,
  ALTAIR_PLUGIN_CATALOG_MAX_BYTES,
  ALTAIR_PLUGIN_CATALOG_MAX_ENTRIES,
  ALTAIR_PLUGIN_CATALOG_MAX_URL_LENGTH,
  LEGACY_ALTAIR_PLUGIN_CATALOG_FORMAT,
  type AltairPluginAuthoringExtension,
  type AltairPluginCatalog,
  type AltairPluginCatalogExtensions,
  type AltairPluginCatalogFetch,
  type AltairPluginCatalogSource,
  type AltairPluginScope,
  type LoadAltairPluginCatalogOptions,
} from "./contracts.js";

interface LegacyAltairPluginCatalogEntry {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly version: string;
  readonly scope: AltairPluginScope;
  readonly source: {
    readonly kind: "builtin" | "npm" | "git" | "http";
    readonly locator: string;
    readonly integrity?: string;
  };
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly conflicts?: Readonly<Record<string, string>>;
  readonly permissions?: readonly string[];
  readonly capabilities?: readonly string[];
  readonly targets?: {
    readonly altair?: string;
    readonly vega?: string;
    readonly deneb?: string;
    readonly platforms?: readonly string[];
  };
}

const PLUGIN_ID = /^[a-z0-9][a-z0-9._/-]*[a-z0-9]$/i;
const DANGEROUS_KEYS = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);
const LEGACY_ENTRY_KEYS = new Set([
  "id",
  "name",
  "description",
  "version",
  "scope",
  "source",
  "dependencies",
  "conflicts",
  "permissions",
  "capabilities",
  "targets",
]);
const LEGACY_SOURCE_KEYS = new Set([
  "kind",
  "locator",
  "integrity",
]);
const LEGACY_TARGET_KEYS = new Set([
  "altair",
  "vega",
  "deneb",
  "platforms",
]);

const isRecord = (
  value: unknown,
): value is Record<string, unknown> =>
  Boolean(value) &&
  typeof value === "object" &&
  !Array.isArray(value);

const requireString = (value: unknown, path: string): string => {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${path} must be a non-empty string`);
  }
  return value.trim();
};

const rejectUnknownKeys = (
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  path: string,
): void => {
  for (const key of Object.keys(value)) {
    if (DANGEROUS_KEYS.has(key) || !allowed.has(key)) {
      throw new TypeError(`${path}.${key} is not catalog metadata`);
    }
  }
};

const stringArray = (
  value: unknown,
  path: string,
): readonly string[] | undefined => {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.some(
      (entry) =>
        typeof entry !== "string" || !entry.trim(),
    )
  ) {
    throw new TypeError(
      `${path} must be an array of non-empty strings`,
    );
  }
  const normalized = value.map((entry) =>
    (entry as string).trim(),
  );
  if (new Set(normalized).size !== normalized.length) {
    throw new TypeError(`${path} contains a duplicate`);
  }
  return normalized;
};

const versionRanges = (
  value: unknown,
  path: string,
): Readonly<Record<string, string>> | undefined => {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new TypeError(`${path} must be an object`);
  }
  const output: Record<string, string> = {};
  for (const [id, rangeValue] of Object.entries(value)) {
    if (!PLUGIN_ID.test(id)) {
      throw new TypeError(
        `${path} has an invalid plugin ID '${id}'`,
      );
    }
    const range = requireString(rangeValue, `${path}.${id}`);
    if (!isValidVegaSemVerRange(range)) {
      throw new TypeError(
        `${path}.${id} is not a semantic-version range`,
      );
    }
    output[id] = range;
  }
  return output;
};

export const altairPluginCatalogEntryKey = (
  entry: Pick<VegaPluginMarketplaceEntry, "id" | "version">,
): string => `${entry.id}@${entry.version}`;

const parseCanonicalEntry = (
  value: unknown,
  path: string,
): VegaPluginMarketplaceEntry => {
  try {
    assertVegaPluginMarketplaceEntry(value, path);
  } catch (error) {
    throw new TypeError(
      error instanceof Error ? error.message : String(error),
    );
  }
  const entry = value as VegaPluginMarketplaceEntry;
  if (!parseVegaSemVer(entry.version)) {
    throw new TypeError(`${path}.version is invalid`);
  }
  return normalizeVegaPluginCatalog([entry])[0]!;
};

const legacyRegistryPackage = (
  locator: string,
  version: string,
): string =>
  locator.endsWith(`@${version}`)
    ? locator.slice(0, -(version.length + 1))
    : locator;

const legacySource = (
  value: unknown,
  version: string,
  path: string,
): VegaPluginInstallSource => {
  if (!isRecord(value)) {
    throw new TypeError(`${path} must be an object`);
  }
  rejectUnknownKeys(value, LEGACY_SOURCE_KEYS, path);
  const kind = requireString(value.kind, `${path}.kind`);
  const locator = requireString(value.locator, `${path}.locator`);
  switch (kind) {
    case "builtin":
      return { type: "builtin", key: locator };
    case "npm":
      return {
        type: "registry",
        package: legacyRegistryPackage(locator, version),
      };
    case "git":
    case "http": {
      const integrity = requireString(
        value.integrity,
        `${path}.integrity`,
      );
      return {
        type: "url",
        url: new URL(locator).href,
        integrity,
      };
    }
    default:
      throw new TypeError(`${path}.kind is unsupported`);
  }
};

const adaptLegacyEntry = (
  value: unknown,
  path: string,
): {
  readonly entry: VegaPluginMarketplaceEntry;
  readonly extension: AltairPluginAuthoringExtension;
} => {
  if (!isRecord(value)) {
    throw new TypeError(`${path} must be an object`);
  }
  rejectUnknownKeys(value, LEGACY_ENTRY_KEYS, path);
  const id = requireString(value.id, `${path}.id`);
  if (!PLUGIN_ID.test(id)) {
    throw new TypeError(`${path}.id is invalid`);
  }
  const version = requireString(value.version, `${path}.version`);
  if (!parseVegaSemVer(version)) {
    throw new TypeError(`${path}.version is invalid`);
  }
  const scope = requireString(value.scope, `${path}.scope`);
  if (
    scope !== "authoring" &&
    scope !== "runtime" &&
    scope !== "host"
  ) {
    throw new TypeError(`${path}.scope is unsupported`);
  }
  const targetsValue = value.targets;
  let targets: LegacyAltairPluginCatalogEntry["targets"];
  if (targetsValue !== undefined) {
    if (!isRecord(targetsValue)) {
      throw new TypeError(`${path}.targets must be an object`);
    }
    rejectUnknownKeys(
      targetsValue,
      LEGACY_TARGET_KEYS,
      `${path}.targets`,
    );
    targets = {
      ...(targetsValue.altair === undefined
        ? {}
        : {
            altair: requireString(
              targetsValue.altair,
              `${path}.targets.altair`,
            ),
          }),
      ...(targetsValue.vega === undefined
        ? {}
        : {
            vega: requireString(
              targetsValue.vega,
              `${path}.targets.vega`,
            ),
          }),
      ...(targetsValue.deneb === undefined
        ? {}
        : {
            deneb: requireString(
              targetsValue.deneb,
              `${path}.targets.deneb`,
            ),
          }),
      ...(targetsValue.platforms === undefined
        ? {}
        : {
            platforms: stringArray(
              targetsValue.platforms,
              `${path}.targets.platforms`,
            )!,
          }),
    };
    for (const range of [
      targets.altair,
      targets.vega,
      targets.deneb,
    ]) {
      if (
        range !== undefined &&
        !isValidVegaSemVerRange(range)
      ) {
        throw new TypeError(
          `${path}.targets contains an invalid version range`,
        );
      }
    }
  }
  const canonicalTargets: VegaPluginTargets | undefined =
    targets?.platforms?.length || targets?.vega || targets?.deneb
      ? {
          ...(targets.platforms
            ? { platforms: targets.platforms }
            : {}),
          ...(targets.vega || targets.deneb
            ? {
                engineVersion:
                  targets.vega ?? targets.deneb,
              }
            : {}),
        }
      : undefined;
  const entry: VegaPluginMarketplaceEntry = {
    format: "vega-plugin-entry",
    formatVersion: 1,
    id,
    name: requireString(value.name, `${path}.name`),
    version,
    apiVersion: 1,
    ...(value.description === undefined
      ? {}
      : {
          description: requireString(
            value.description,
            `${path}.description`,
          ),
        }),
    ...(value.capabilities === undefined
      ? {}
      : {
          capabilities: stringArray(
            value.capabilities,
            `${path}.capabilities`,
          )!,
        }),
    ...(value.permissions === undefined
      ? {}
      : {
          permissions: stringArray(
            value.permissions,
            `${path}.permissions`,
          )!,
        }),
    ...(value.dependencies === undefined
      ? {}
      : {
          dependencies: versionRanges(
            value.dependencies,
            `${path}.dependencies`,
          )!,
        }),
    ...(canonicalTargets ? { targets: canonicalTargets } : {}),
    source: legacySource(
      value.source,
      version,
      `${path}.source`,
    ),
  };
  return {
    entry: parseCanonicalEntry(entry, path),
    extension: {
      scope,
      ...(value.conflicts === undefined
        ? {}
        : {
            conflicts: versionRanges(
              value.conflicts,
              `${path}.conflicts`,
            )!,
          }),
      ...(targets?.altair
        ? { altairVersion: targets.altair }
        : {}),
    },
  };
};

const parseAuthoringExtension = (
  value: unknown,
  path: string,
): AltairPluginAuthoringExtension => {
  if (!isRecord(value)) {
    throw new TypeError(`${path} must be an object`);
  }
  rejectUnknownKeys(
    value,
    new Set([
      "scope",
      "conflicts",
      "altairVersion",
      "permissions",
    ]),
    path,
  );
  let scope: AltairPluginScope | undefined;
  if (value.scope !== undefined) {
    const candidate = requireString(
      value.scope,
      `${path}.scope`,
    );
    if (
      candidate !== "authoring" &&
      candidate !== "runtime" &&
      candidate !== "host"
    ) {
      throw new TypeError(`${path}.scope is unsupported`);
    }
    scope = candidate;
  }
  let altairVersion: string | undefined;
  if (value.altairVersion !== undefined) {
    altairVersion = requireString(
      value.altairVersion,
      `${path}.altairVersion`,
    );
    if (!isValidVegaSemVerRange(altairVersion)) {
      throw new TypeError(
        `${path}.altairVersion is invalid`,
      );
    }
  }
  return {
    ...(scope ? { scope } : {}),
    ...(value.conflicts === undefined
      ? {}
      : {
          conflicts: versionRanges(
            value.conflicts,
            `${path}.conflicts`,
          )!,
        }),
    ...(altairVersion ? { altairVersion } : {}),
    ...(value.permissions === undefined
      ? {}
      : {
          permissions: stringArray(
            value.permissions,
            `${path}.permissions`,
          )!,
        }),
  };
};

const parseExtensions = (
  value: unknown,
  path: string,
): AltairPluginCatalogExtensions | undefined => {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new TypeError(`${path} must be an object`);
  }
  rejectUnknownKeys(value, new Set(["altair"]), path);
  if (value.altair === undefined) return {};
  if (!isRecord(value.altair)) {
    throw new TypeError(`${path}.altair must be an object`);
  }
  rejectUnknownKeys(
    value.altair,
    new Set(["entries"]),
    `${path}.altair`,
  );
  if (!isRecord(value.altair.entries)) {
    throw new TypeError(
      `${path}.altair.entries must be an object`,
    );
  }
  return {
    altair: {
      entries: Object.fromEntries(
        Object.entries(value.altair.entries)
          .sort(([left], [right]) =>
            left.localeCompare(right),
          )
          .map(([key, extension]) => [
            key,
            parseAuthoringExtension(
              extension,
              `${path}.altair.entries[${JSON.stringify(key)}]`,
            ),
          ]),
      ),
    },
  };
};

export const parseAltairPluginCatalogEntry = (
  value: unknown,
  path = "$",
): VegaPluginMarketplaceEntry =>
  isRecord(value) && value.format === "vega-plugin-entry"
    ? parseCanonicalEntry(value, path)
    : adaptLegacyEntry(value, path).entry;

export const parseAltairPluginCatalog = (
  value: unknown,
  fallbackId = "catalog",
): AltairPluginCatalog => {
  const root = Array.isArray(value) ? { plugins: value } : value;
  if (!isRecord(root)) {
    throw new TypeError(
      "Plugin catalog must be an object or array",
    );
  }
  rejectUnknownKeys(
    root,
    new Set([
      "format",
      "formatVersion",
      "id",
      "plugins",
      "extensions",
    ]),
    "$",
  );
  if (
    root.format !== undefined &&
    root.format !== ALTAIR_PLUGIN_CATALOG_FORMAT &&
    root.format !== LEGACY_ALTAIR_PLUGIN_CATALOG_FORMAT
  ) {
    throw new TypeError(
      `$.format must be '${ALTAIR_PLUGIN_CATALOG_FORMAT}'`,
    );
  }
  if (
    root.formatVersion !== undefined &&
    root.formatVersion !== 1
  ) {
    throw new TypeError("$.formatVersion must be 1");
  }
  if (!Array.isArray(root.plugins)) {
    throw new TypeError("$.plugins must be an array");
  }
  if (
    root.plugins.length > ALTAIR_PLUGIN_CATALOG_MAX_ENTRIES
  ) {
    throw new RangeError(
      `Plugin catalog exceeds ${ALTAIR_PLUGIN_CATALOG_MAX_ENTRIES} entries`,
    );
  }
  const extensions = parseExtensions(
    root.extensions,
    "$.extensions",
  );
  const authoring = new Map(
    Object.entries(extensions?.altair?.entries ?? {}),
  );
  const entries = root.plugins.map((candidate, index) => {
    const path = `$.plugins[${index}]`;
    if (
      isRecord(candidate) &&
      candidate.format === "vega-plugin-entry"
    ) {
      return parseCanonicalEntry(candidate, path);
    }
    const adapted = adaptLegacyEntry(candidate, path);
    const key = altairPluginCatalogEntryKey(adapted.entry);
    const existing = authoring.get(key);
    if (
      existing &&
      JSON.stringify(existing) !==
        JSON.stringify(adapted.extension)
    ) {
      throw new TypeError(
        `Conflicting Altair extension metadata for ${key}`,
      );
    }
    authoring.set(key, adapted.extension);
    return adapted.entry;
  });
  const id =
    root.id === undefined
      ? fallbackId
      : requireString(root.id, "$.id");
  const canonical: VegaPluginCatalog = {
    format: ALTAIR_PLUGIN_CATALOG_FORMAT,
    formatVersion: 1,
    id,
    plugins: entries,
  };
  assertVegaPluginCatalog(canonical);
  const plugins = new VegaStaticPluginCatalog(
    entries,
    id,
  ).entries();
  return {
    ...canonical,
    plugins,
    ...(authoring.size
      ? {
          extensions: {
            altair: {
              entries: Object.fromEntries(
                [...authoring].sort(([left], [right]) =>
                  left.localeCompare(right),
                ),
              ),
            },
          },
        }
      : {}),
  };
};

const defaultCatalogFetch: AltairPluginCatalogFetch = async (
  url,
  init,
) => {
  if (typeof globalThis.fetch !== "function") {
    throw new Error(
      "No fetch implementation is available for HTTP plugin catalogs",
    );
  }
  return globalThis.fetch(url, init);
};

const validateCatalogUrl = (value: string): URL => {
  if (value.length > ALTAIR_PLUGIN_CATALOG_MAX_URL_LENGTH) {
    throw new RangeError("HTTP plugin catalog URL is too long");
  }
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError(
      "HTTP plugin catalog URL must use http: or https:",
    );
  }
  if (url.username || url.password) {
    throw new TypeError(
      "HTTP plugin catalog URL must not contain credentials",
    );
  }
  url.hash = "";
  return url;
};

export const loadAltairPluginCatalog = async (
  source: AltairPluginCatalogSource,
  options: LoadAltairPluginCatalogOptions = {},
): Promise<AltairPluginCatalog> => {
  options.signal?.throwIfAborted();
  if (source.kind === "static") {
    return parseAltairPluginCatalog(
      {
        format: ALTAIR_PLUGIN_CATALOG_FORMAT,
        formatVersion: 1,
        id: source.id,
        plugins: source.plugins,
        ...(source.extensions
          ? { extensions: source.extensions }
          : {}),
      },
      source.id,
    );
  }
  const url = validateCatalogUrl(source.url);
  const response = await (
    options.fetch ?? defaultCatalogFetch
  )(url.href, {
    headers: { accept: "application/json" },
    ...(options.signal ? { signal: options.signal } : {}),
  });
  options.signal?.throwIfAborted();
  if (!response.ok) {
    throw new Error(
      `Plugin catalog request failed with HTTP ${response.status}`,
    );
  }
  const contentType = response.headers?.get("content-type");
  if (
    contentType &&
    !/(?:application|text)\/(?:[\w.+-]*\+)?json\b/i.test(
      contentType,
    )
  ) {
    throw new TypeError(
      `Plugin catalog returned non-JSON content type '${contentType}'`,
    );
  }
  const text = await response.text();
  options.signal?.throwIfAborted();
  if (
    new TextEncoder().encode(text).byteLength >
    ALTAIR_PLUGIN_CATALOG_MAX_BYTES
  ) {
    throw new RangeError(
      `Plugin catalog exceeds ${ALTAIR_PLUGIN_CATALOG_MAX_BYTES} bytes`,
    );
  }
  let metadata: unknown;
  try {
    metadata = JSON.parse(text) as unknown;
  } catch (error) {
    throw new TypeError(
      `Plugin catalog is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return parseAltairPluginCatalog(metadata, source.id);
};

export class AltairHttpPluginCatalogProvider
  implements VegaPluginCatalogProvider
{
  readonly id: string;
  private readonly source: Extract<
    AltairPluginCatalogSource,
    { readonly kind: "http" }
  >;
  private readonly options: LoadAltairPluginCatalogOptions;

  constructor(
    source: Extract<
      AltairPluginCatalogSource,
      { readonly kind: "http" }
    >,
    options: LoadAltairPluginCatalogOptions = {},
  ) {
    this.id = source.id;
    this.source = source;
    this.options = options;
  }

  async entries(): Promise<
    readonly VegaPluginMarketplaceEntry[]
  > {
    return (
      await loadAltairPluginCatalog(
        this.source,
        this.options,
      )
    ).plugins;
  }
}

export const mergeAltairPluginCatalogs = (
  ...catalogs: readonly AltairPluginCatalog[]
): AltairPluginCatalog => {
  const authoring = new Map<
    string,
    AltairPluginAuthoringExtension
  >();
  for (const catalog of catalogs) {
    for (const [key, extension] of Object.entries(
      catalog.extensions?.altair?.entries ?? {},
    )) {
      const existing = authoring.get(key);
      if (
        existing &&
        JSON.stringify(existing) !== JSON.stringify(extension)
      ) {
        throw new Error(
          `Conflicting Altair extension metadata for ${key}`,
        );
      }
      authoring.set(key, extension);
    }
  }
  return {
    format: ALTAIR_PLUGIN_CATALOG_FORMAT,
    formatVersion: 1,
    id:
      catalogs.map(({ id }) => id).join("+") || "empty",
    plugins: normalizeVegaPluginCatalog(
      catalogs.flatMap(({ plugins }) => plugins),
    ),
    ...(authoring.size
      ? {
          extensions: {
            altair: {
              entries: Object.fromEntries(
                [...authoring].sort(([left], [right]) =>
                  left.localeCompare(right),
                ),
              ),
            },
          },
        }
      : {}),
  };
};

export const searchAltairPluginCatalog = (
  catalog: AltairPluginCatalog,
  query: string,
): readonly VegaPluginMarketplaceEntry[] =>
  searchVegaPluginCatalog(catalog.plugins, { text: query });

export const altairPluginAuthoringExtension = (
  catalog: AltairPluginCatalog,
  entry: Pick<
    VegaPluginMarketplaceEntry,
    "id" | "version"
  >,
): AltairPluginAuthoringExtension | undefined =>
  catalog.extensions?.altair?.entries[
    altairPluginCatalogEntryKey(entry)
  ];
