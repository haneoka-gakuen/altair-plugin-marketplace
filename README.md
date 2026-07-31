# Altair Marketplace

Catalog search and project plugin management for Altair.

```sh
pnpm add @haneoka/altair @haneoka/altair-plugin-marketplace
```

```ts
import { altairMarketplacePlugin, altairMarketplaceServiceKey } from "@haneoka/altair-plugin-marketplace";

await host.install(altairMarketplacePlugin);
const marketplace = host.service(altairMarketplaceServiceKey);
const catalog = await marketplace?.loadCatalog({
  kind: "http",
  id: "community",
  url: "https://example.com/catalog.json",
});
```

The service installs, enables, disables, configures, and removes project plugins with dependency and permission checks. Catalog data is never executed automatically.

MPL-2.0.
