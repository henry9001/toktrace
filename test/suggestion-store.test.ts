import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  initStore,
  saveSuggestions,
  getSuggestions,
  dismissSuggestion,
  actionSuggestion,
  suggestionContentHash,
} from "../src/store.js";
import type { SuggestionCard } from "../src/types.js";

function makeCard(overrides: Partial<SuggestionCard> = {}): SuggestionCard {
  return {
    rule: "test-rule",
    title: "Test suggestion",
    impact: "Some impact description",
    action: "Do something about it",
    confidence: 0.75,
    ...overrides,
  };
}

describe("suggestion persistence", () => {
  let tmpDir: string;
  let dbPath: string;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "toktrace-sug-test-"));
    dbPath = join(tmpDir, "events.db");
    initStore(dbPath);
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("suggestionContentHash produces a stable 16-char hex string", () => {
    const card = makeCard();
    const h1 = suggestionContentHash(card);
    const h2 = suggestionContentHash(card);
    assert.equal(h1, h2, "same card should produce same hash");
    assert.equal(h1.length, 16);
    assert.ok(/^[0-9a-f]+$/.test(h1), "hash should be hex");
  });

  it("different cards produce different hashes", () => {
    const a = suggestionContentHash(makeCard({ title: "A" }));
    const b = suggestionContentHash(makeCard({ title: "B" }));
    assert.notEqual(a, b);
  });

  it("saveSuggestions stores cards and getSuggestions retrieves them", () => {
    const cards = [makeCard(), makeCard({ rule: "other-rule", title: "Other" })];
    const inserted = saveSuggestions(cards, dbPath);
    assert.equal(inserted, 2);

    const all = getSuggestions({}, dbPath);
    assert.equal(all.length, 2);
    assert.ok(all.every((s) => s.status === "active"));
    assert.ok(all.every((s) => s.created_at.length > 0));
    assert.ok(all.every((s) => s.id.startsWith("sug_")));
  });

  it("deduplicates by rule + content_hash", () => {
    const card = makeCard({ rule: "dedup-test", title: "Unique title for dedup" });
    saveSuggestions([card], dbPath);
    const countBefore = getSuggestions({}, dbPath).length;

    // Insert the same card again
    saveSuggestions([card], dbPath);
    const countAfter = getSuggestions({}, dbPath).length;
    assert.equal(countAfter, countBefore, "duplicate card should not create a new row");
  });

  it("updates confidence on duplicate insert", () => {
    const card = makeCard({ rule: "confidence-update", title: "Confidence test", confidence: 0.5 });
    saveSuggestions([card], dbPath);

    const before = getSuggestions({}, dbPath).find((s) => s.rule === "confidence-update");
    assert.ok(before);
    assert.equal(before.confidence, 0.5);

    // Re-insert with higher confidence
    saveSuggestions([{ ...card, confidence: 0.9 }], dbPath);
    const after = getSuggestions({}, dbPath).find((s) => s.rule === "confidence-update");
    assert.ok(after);
    assert.equal(after.confidence, 0.9);
  });

  it("saveSuggestions returns 0 for empty array", () => {
    assert.equal(saveSuggestions([], dbPath), 0);
  });

  it("getSuggestions filters by status", () => {
    const active = getSuggestions({ status: "active" }, dbPath);
    assert.ok(active.length > 0);
    assert.ok(active.every((s) => s.status === "active"));

    const dismissed = getSuggestions({ status: "dismissed" }, dbPath);
    assert.ok(dismissed.every((s) => s.status === "dismissed"));
  });

  it("dismissSuggestion sets status to dismissed", () => {
    const card = makeCard({ rule: "dismiss-test", title: "Dismiss me" });
    saveSuggestions([card], dbPath);

    const stored = getSuggestions({}, dbPath).find((s) => s.rule === "dismiss-test");
    assert.ok(stored);

    const result = dismissSuggestion(stored.id, dbPath);
    assert.ok(result, "should return true for existing row");

    const updated = getSuggestions({}, dbPath).find((s) => s.id === stored.id);
    assert.ok(updated);
    assert.equal(updated.status, "dismissed");
    assert.ok(updated.updated_at >= stored.updated_at);
  });

  it("actionSuggestion sets status to actioned", () => {
    const card = makeCard({ rule: "action-test", title: "Action me" });
    saveSuggestions([card], dbPath);

    const stored = getSuggestions({}, dbPath).find((s) => s.rule === "action-test");
    assert.ok(stored);

    const result = actionSuggestion(stored.id, dbPath);
    assert.ok(result);

    const updated = getSuggestions({}, dbPath).find((s) => s.id === stored.id);
    assert.ok(updated);
    assert.equal(updated.status, "actioned");
  });

  it("dismissSuggestion returns false for non-existent id", () => {
    const result = dismissSuggestion("sug_nonexistent", dbPath);
    assert.equal(result, false);
  });

  it("actionSuggestion returns false for non-existent id", () => {
    const result = actionSuggestion("sug_nonexistent", dbPath);
    assert.equal(result, false);
  });
});
