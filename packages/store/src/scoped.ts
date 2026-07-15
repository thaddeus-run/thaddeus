import type { Backend } from './backend';

// Namespace a backend so one store can hold many scopes: every key is prefixed
// on the way in and stripped on the way out; list() queries within the scope.
export function scoped(backend: Backend, prefix: string): Backend {
  const putIfAbsent = backend.putIfAbsent?.bind(backend);
  return {
    put: (key, bytes) => backend.put(prefix + key, bytes),
    ...(putIfAbsent === undefined
      ? {}
      : {
          putIfAbsent: (key: string, bytes: Uint8Array) =>
            putIfAbsent(prefix + key, bytes),
        }),
    get: (key) => backend.get(prefix + key),
    delete: (key) => backend.delete(prefix + key),
    openScan: async (p) => {
      const scan = await backend.openScan(prefix + p);
      return {
        read: async (maxEntries: number) => {
          const page = await scan.read(maxEntries);
          return {
            keys: page.keys.map((key) => key.slice(prefix.length)),
            done: page.done,
          };
        },
        close: () => scan.close(),
      };
    },
    list: async (p) =>
      (await backend.list(prefix + p)).map((k) => k.slice(prefix.length)),
  };
}
