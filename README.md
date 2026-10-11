# Altair Marketplace

Altair Marketplace is how a story project in
[Altair](https://github.com/haneoka-gakuen/altair) finds and manages its
plugins. It reads plugin catalogs — the official one, a community list, your
studio's private index — merges and searches them, and records in the project
which plugins it uses, at which version, with which settings and permissions.
Before a project is built or published it checks that every dependency is
present, nothing conflicts and nothing asks for a permission it was not given,
then writes a lock file so the same project builds the same way everywhere.

It only ever handles metadata. A catalog entry is never downloaded or run by
this package; installing a plugin into a project just records the choice for
the host to act on.

Catalogs use the same format as [Vega](https://github.com/haneoka-gakuen/vega)'s
marketplace, so a plugin listed once is available to both the editor and the
player. The official catalog lives in
[vega-marketplace](https://github.com/haneoka-gakuen/vega-marketplace).

## Install

```sh
pnpm add @haneoka/altair @haneoka/altair-plugin-marketplace @haneoka/vega @haneoka/vega-protocol
```

ESM only; Node 20 or a current browser.

## Use it in Altair

```ts
import { AltairPluginHost } from "@haneoka/altair/plugins";
import { altairMarketplacePlugin, altairMarketplaceServiceKey } from "@haneoka/altair-plugin-marketplace";

const host = new AltairPluginHost();
await host.install(altairMarketplacePlugin);
const marketplace = host.service(altairMarketplaceServiceKey);
```

To route catalog requests through your own client (a proxy, authentication,
caching), create the plugin with a fetch function:

```ts
import { createAltairMarketplacePlugin } from "@haneoka/altair-plugin-marketplace";

await host.install(createAltairMarketplacePlugin({ fetch: (url, init) => myFetch(url, init) }));
```

## Catalogs

```ts
const official = await marketplace.loadCatalog({
  kind: "http",
  id: "official",
  url: "https://example.org/vega-plugin-catalog.json",
});

const local = await marketplace.loadCatalog({
  kind: "static",
  id: "studio",
  plugins: [/* entries */],
});

const catalog = marketplace.mergeCatalogs([official, local]);
const hits = marketplace.search(catalog, "live2d");
```

A catalog is JSON with `format: "vega-plugin-catalog"`, `formatVersion: 1`, an
`id` and a list of `plugins`. Each entry describes one version of one plugin:

| Field | Meaning |
| --- | --- |
| `id`, `name`, `version`, `apiVersion` | Identity. `id@version` is unique within a catalog. |
| `description`, `publisher`, `tags` | Shown in search. |
| `capabilities`, `permissions` | What the plugin contributes and what it needs. |
| `dependencies`, `optionalDependencies` | Other plugins, with version ranges. |
| `externalRuntimes` | Third-party runtimes it needs, such as a Live2D SDK. |
| `targets` | Platforms it runs on. |
| `source`, `integrity` | Where the package comes from and its digest. |

Altair-specific information sits under `extensions.altair.entries`, keyed by
`id@version`: the plugin's `scope` (`authoring`, `runtime` or `host`), the
Altair versions it supports, extra authoring permissions, and plugins it
conflicts with. `authoringExtension(catalog, entry)` reads it.

HTTP catalogs are limited to 2 MiB, 10 000 entries and 4 096-character URLs.
Older catalogs using the `altair-plugin-catalog` format are still read.

## Managing a project's plugins

Every operation returns a new project and leaves the original unchanged:

```ts
let next = marketplace.install(project, "haneoka.vega-cubism", catalog, { version: "^0.1.0" });
next = marketplace.configure(next, "haneoka.vega-cubism", { textureScale: 1 });
next = marketplace.setPermissions(next, "haneoka.vega-cubism", ["network"]);
next = marketplace.setEnabled(next, "haneoka.vega-cubism", false, catalog);
next = marketplace.remove(next, "haneoka.vega-cubism", catalog);
```

`install` resolves the plugin together with everything already enabled and
throws, naming the problem, if no catalog release satisfies the version or a
dependency cannot be met. Pass `required: true` to mark a plugin the project
cannot run without. `remove` refuses to remove a required plugin or one that
another enabled plugin depends on.

## Checking before a build

```ts
const issues = marketplace.diagnose(project, catalog, {
  altairVersion: "0.1.0",
  grantedPermissions: ["network"],
});

const { lock, diagnostics } = marketplace.createLock(project, catalog, environment);
if (lock) await writeFile("vega-plugins.lock.json", marketplace.serializeLock(lock));
```

Diagnostics include Vega's own dependency checks plus these Altair codes:

| Code | Meaning |
| --- | --- |
| `altair-plugin-conflict` | Two enabled plugins declare a conflict. |
| `altair-required-plugin-disabled` | A plugin marked required is disabled. |
| `altair-version-incompatible` | The plugin does not support this Altair version. |
| `altair-version-unverified` | The plugin does not say which Altair versions it supports. |
| `altair-authoring-permission-denied` | It needs a permission the environment denies. |
| `altair-authoring-permission-review-required` | It needs a permission nobody has granted yet. |
| `altair-authoring-runtime-dependency` | An authoring plugin depends on a runtime-only plugin. |

`createLock` returns `lock: null` when there are errors, together with the
diagnostics that explain why.

## API

Everything on the service is also exported as a plain function:
`parseAltairPluginCatalog`, `loadAltairPluginCatalog`,
`mergeAltairPluginCatalogs`, `searchAltairPluginCatalog`,
`altairPluginAuthoringExtension`, `installStoryProjectPlugin`,
`setStoryProjectPluginEnabled`, `configureStoryProjectPlugin`,
`setStoryProjectPluginPermissions`, `removeStoryProjectPlugin`,
`diagnoseStoryProjectPlugins`, `createAltairPluginLock`,
`serializeAltairPluginLock`. Without the plugin host, use
`createAltairMarketplaceService(options)`.

## License

MPL-2.0. See [LICENSE](LICENSE).
