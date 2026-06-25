import type { Backend } from './backend';

// Namespace a backend so one store can hold many scopes: every key is prefixed
// on the way in and stripped on the way out; list() queries within the scope.
export function scoped(backend: Backend, prefix: string): Backend {
  return {
    put: (key, bytes) => backend.put(prefix + key, bytes),
    get: (key) => backend.get(prefix + key),
    delete: (key) => backend.delete(prefix + key),
    list: async (p) =>
      (await backend.list(prefix + p)).map((k) => k.slice(prefix.length)),
  };
}
