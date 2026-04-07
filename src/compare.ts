import { getSnapshot, getSnapshotByName } from "./store.js";
import type { Snapshot, SnapshotComparison, DeltaValue, TopSpenderDelta } from "./types.js";

function findSnapshot(nameOrId: string, dbPath?: string): Snapshot | null {
  return getSnapshotByName(nameOrId, dbPath) ?? getSnapshot(nameOrId, dbPath);
}

function delta(before: number, after: number): DeltaValue {
  return {
    before,
    after,
    absolute: after - before,
    percent: before !== 0 ? ((after - before) / before) * 100 : null,
  };
}

export function compareSnapshots(
  idA: string,
  idB: string,
  dbPath?: string,
): SnapshotComparison {
  const a = findSnapshot(idA, dbPath);
  if (!a) throw new Error(`Snapshot not found: ${idA}`);
  const b = findSnapshot(idB, dbPath);
  if (!b) throw new Error(`Snapshot not found: ${idB}`);

  const sa = a.summary;
  const sb = b.summary;

  const models = new Set([
    ...sa.top_spenders.map((s) => s.model),
    ...sb.top_spenders.map((s) => s.model),
  ]);

  const top_spenders: TopSpenderDelta[] = [];
  for (const model of models) {
    const beforeCost = sa.top_spenders.find((s) => s.model === model)?.total_cost ?? 0;
    const afterCost = sb.top_spenders.find((s) => s.model === model)?.total_cost ?? 0;
    top_spenders.push({
      model,
      before_cost: beforeCost,
      after_cost: afterCost,
      absolute: afterCost - beforeCost,
      percent: beforeCost !== 0 ? ((afterCost - beforeCost) / beforeCost) * 100 : null,
    });
  }
  top_spenders.sort((a, b) => Math.abs(b.absolute) - Math.abs(a.absolute));

  return {
    snapshot_a: a,
    snapshot_b: b,
    delta: {
      total_tokens: delta(sa.total_tokens, sb.total_tokens),
      total_input_tokens: delta(sa.total_input_tokens, sb.total_input_tokens),
      total_output_tokens: delta(sa.total_output_tokens, sb.total_output_tokens),
      total_estimated_cost: delta(sa.total_estimated_cost, sb.total_estimated_cost),
      event_count: delta(sa.event_count, sb.event_count),
    },
    top_spenders,
    suggestions_a: sa.suggestions,
    suggestions_b: sb.suggestions,
  };
}
