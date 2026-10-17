// Browser-safe wire protocol version shared by the server, the client library,
// and the CLI. Keep this file free of imports so `@thaddeus.run/server/protocol`
// stays importable from browsers.

/**
 * Wire protocol version. Raise it when a change to request signing, routes, or
 * DTOs would break an older client or server (see ARCHITECTURE.md).
 */
export const PROTOCOL_VERSION = 1;

/** Request header a client sends to declare the protocol it speaks. */
export const PROTOCOL_HEADER = 'x-thaddeus-protocol';

/** Response header carrying the server's release version. */
export const SERVER_VERSION_HEADER = 'x-thaddeus-version';
