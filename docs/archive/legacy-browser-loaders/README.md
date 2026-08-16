# Retired browser cloud loaders

These files are exact historical browser-side implementations retired from active `assets/` during Architecture Convergence Phase 0.

Archived implementations:

- `private-cloud-query-v1.js`
- `private-cloud-warehouse-v3.js`
- `private-cloud-warehouse-v4.js`
- `generated-inline-script-09.js`
- `generated-inline-script-11.js`

They previously implemented or supported the GitHub Pages / Warehouse browser transport, password/session credential handling, legacy shop-scope UI, Raw-file import, and Warehouse query compatibility.

The canonical Cloudflare Native browser path is now:

```text
assets/cloudflare-native-api-v1.js
assets/cloudflare-native-query-bridge-v1.js
assets/cloudflare-native-data-panel-v1.js
```

The Native data panel uses the Cloudflare Access browser session and same-origin Native APIs. Cloud Raw import is intentionally fail-closed until it is migrated; local file import remains a separate browser workflow.

The root `index.html` may still contain legacy script-tag markers as migration input. The canonical Native builder removes those tags before producing `dist-cloudflare-native/`, and the corresponding legacy implementation files are no longer active source assets.
