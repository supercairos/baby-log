/**
 * Baby Buddy typed API layer — public surface.
 *
 * Layers, bottom to top:
 *   generated/schema.d.ts  types generated from the v2.9.2 OpenAPI schema (never edited)
 *   connection / client    auth, connection parsing/validation, the typed fetch client
 *   children / timers /     thin typed calls over the endpoints
 *     entries / activities
 *   mutations / outbox /    offline-first write pipeline (serializable commands → durable
 *     sync / service-worker   IndexedDB queue → background flush with retry)
 *
 * The generated `paths`/`components` are intentionally NOT re-exported here — import them
 * from "./generated/schema" directly if you need raw schema types.
 */
export * from "./connection";
export * from "./errors";
export * from "./client";
export * from "./activities";
export * from "./children";
export * from "./timers";
export * from "./entries";
export * from "./timeline";
export * from "./mutations";
export * from "./outbox";
export * from "./sync";
export * from "./outbox-events";
