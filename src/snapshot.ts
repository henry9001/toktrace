import { randomUUID } from "node:crypto";
import { queryEvents, insertSnapshot, listSnapshots, getSnapshot, buildSummary } from "./store.js";
import type { Snapshot } from "./types.js";

export interface CreateSnapshotOptions {
  name: string;
  /** ISO timestamp — only include events at or after this time */
  since?: string;
  /** ISO timestamp — only include events at or before this time */
  until?: string;
  dbPath?: string;
}

export function createSnapshot(opts: CreateSnapshotOptions): Snapshot {
  const capturedAt = new Date().toISOString();
  const events = queryEvents({ since: opts.since, until: opts.until }, opts.dbPath);

  const windowStart = events.length > 0 ? events[0].ts : opts.since ?? null;
  const windowEnd = events.length > 0 ? events[events.length - 1].ts : opts.until ?? null;

  const snapshot: Snapshot = {
    snapshot_id: randomUUID(),
    name: opts.name,
    captured_at: capturedAt,
    window_start: windowStart,
    window_end: windowEnd,
    event_ids: events.map((e) => e.id),
    summary: buildSummary(events),
  };

  insertSnapshot(snapshot, opts.dbPath);
  return snapshot;
}

export { listSnapshots, getSnapshot };
