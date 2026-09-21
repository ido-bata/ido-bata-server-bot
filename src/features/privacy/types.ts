/**
 * Shared result type for per-consumer delete adapters. Mirrors the shape
 * `ConsentService.clear` expects when cascading per-scope delete fns.
 */
export type DeleteResult = { ok: true } | { ok: false; error: string };
