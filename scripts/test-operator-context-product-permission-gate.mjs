import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../assets/cloudflare-native-operator-context-v1.js', import.meta.url), 'utf8');

async function runScenario(capabilities) {
  let productReads = 0;
  const document = {
    readyState: 'loading',
    body: {},
    head: { appendChild() {} },
    documentElement: { lang: 'en' },
    addEventListener() {},
    querySelector() { return null; },
    createElement() {
      return {
        dataset: {},
        className: '',
        id: '',
        textContent: '',
        setAttribute() {},
        appendChild() {},
        insertAdjacentElement() {},
      };
    },
  };

  const sandbox = {
    document,
    console,
    Event: class Event {},
    CustomEvent: class CustomEvent {
      constructor(type, options) { this.type = type; this.detail = options?.detail; }
    },
    MutationObserver: class MutationObserver { observe() {} },
    queueMicrotask,
    dispatchEvent() {},
    addEventListener() {},
    CloudflareNativeAPI: {
      async capabilities() { return capabilities; },
      async listProducts() {
        productReads += 1;
        return { items: [] };
      },
      async productKeywords() { return { items: [] }; },
    },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'cloudflare-native-operator-context-v1.js' });
  await sandbox.CloudflareOperatorContext.refreshCatalogs();
  return productReads;
}

assert.equal(
  await runScenario({ globalPermissions: ['analytics.read'], storePermissions: { Store01: ['analytics.read'] } }),
  0,
  'analytics-only operator context must not request the product catalog',
);

assert.equal(
  await runScenario({ globalPermissions: [], storePermissions: {} }),
  0,
  'operator context must fail closed when products.read is absent',
);

assert.equal(
  await runScenario({ globalPermissions: ['products.read'], storePermissions: {} }),
  1,
  'global products.read must retain product catalog behavior',
);

assert.equal(
  await runScenario({ globalPermissions: [], storePermissions: { Store02: ['products.read'] } }),
  1,
  'store-assigned products.read must retain product catalog behavior',
);

assert.doesNotMatch(source, /products\.manage[^\n]*canReadProductCatalog/);
assert.doesNotMatch(source, /amazon|sync\.run|optimization/i, 'permission gate must not introduce Amazon, Sync, or optimization authority');

console.log(JSON.stringify({
  ok: true,
  contract: 'operator-context-product-permission-gate-v1',
  analyticsOnlyProductReads: 0,
  productReadBehaviorRetained: true,
}, null, 2));
