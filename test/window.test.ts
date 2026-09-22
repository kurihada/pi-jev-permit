/**
 * A `pause` or a `shadow` window is not a judgement, so it is not a decision record — but it has to be
 * **in the log**, because a stretch with no shadow decisions otherwise cannot be told apart from a
 * stretch with no window open. That is not hypothetical: it happened the first time a window was run,
 * the log showed zero shadow records, and the ambiguity was read as "the window produced nothing"
 * rather than "nothing was refused".
 *
 * The regression worth pinning is the second half: a new record kind must not inflate the counts that
 * `/jev-permit stats` prints.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { formatStats } from "../index.ts";
import { appendLog, loadUsage, readLogRecords } from "../src/jev.ts";

test("a window round-trips through the log, and stats do not count it as a judgement", () => {
  const dir = mkdtempSync(join(tmpdir(), "jev-permit-window-"));
  try {
    const ts = new Date(0).toISOString();
    appendLog(dir, { kind: "window", ts, window: "shadow", action: "open", durationMs: 1_800_000 });
    appendLog(dir, {
      kind: "decision",
      ts,
      tool: "bash",
      layer: "jev",
      status: "allowed",
      reason: "allowed",
      summary: "ls",
      transport: "test",
    });

    const records = readLogRecords(dir);
    assert.equal(records.length, 2, "one file, both kinds, read back");

    const window = records.find((record) => record["kind"] === "window");
    assert.equal(window?.["action"], "open");
    assert.equal(window?.["window"], "shadow");
    assert.equal(window?.["durationMs"], 1_800_000, "how long it runs is the point of logging it");

    const stats = formatStats(records, loadUsage(dir, 0));
    assert.equal(/window/.test(stats), false, "a window is not a decision and must not be counted as one");
    assert.match(stats, /jev/, "and the judgement next to it still is");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
