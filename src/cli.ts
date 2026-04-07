import { parseArgs } from "node:util";
import { loadConfig, saveConfig } from "./config.js";
import type { BudgetConfig } from "./config.js";
import { createSnapshot, listSnapshots, getSnapshot } from "./snapshot.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    help: { type: "boolean", short: "h" },
    version: { type: "boolean", short: "v" },
  },
  strict: false,
});
const rawArgs = process.argv.slice(2);
const command = positionals[0];

// Top-level --version
if (rawArgs.includes("--version") || rawArgs.includes("-v")) {
  const { default: pkg } = await import("../package.json", { with: { type: "json" } });
  console.log((pkg as { version: string }).version);
  process.exit(0);
}

if (!command || values.help) {
  console.log(`Usage: toktrace <command> [options]

Commands:
  init              Initialize toktrace in the current project
  budget set        Set budget limits (daily/weekly token and cost caps)
  snapshot create   Create a named snapshot of recent LLM events
  snapshot list     List all snapshots
  snapshot show     Show a specific snapshot by ID

Options:
  -h, --help     Show this help message
  -v, --version  Show version
`);
  process.exit(command || values.help ? 0 : 1);
}

if (command === "init") {
  console.log("toktrace init — not yet implemented");
  process.exit(0);
}

if (command === "budget") {
  const subcommand = positionals[1];

  if (!subcommand || subcommand === "help" || values.help) {
    console.log(`Usage: toktrace budget <subcommand> [options]

Subcommands:
  set    Set budget limits

Options for 'set':
  --daily-tokens N    Daily token limit
  --weekly-tokens N   Weekly token limit
  --daily-cost N      Daily cost limit in USD (e.g. 2.00)
  --weekly-cost N     Weekly cost limit in USD (e.g. 10.00)

Omit a flag to leave that limit unchanged.
Pass 0 to a flag to remove that limit.
`);
    process.exit(0);
  }

  if (subcommand === "set") {
    const { values: setValues } = parseArgs({
      args: process.argv.slice(4),
      allowPositionals: false,
      options: {
        "daily-tokens": { type: "string" },
        "weekly-tokens": { type: "string" },
        "daily-cost": { type: "string" },
        "weekly-cost": { type: "string" },
      },
    });

    const config = loadConfig();
    const budget: BudgetConfig = config.budget ?? {};

    if (setValues["daily-tokens"] !== undefined) {
      const v = Number(setValues["daily-tokens"]);
      if (!Number.isFinite(v) || v < 0) {
        console.error("Error: --daily-tokens must be a non-negative number");
        process.exit(1);
      }
      budget.daily_token_limit = v === 0 ? undefined : v;
    }

    if (setValues["weekly-tokens"] !== undefined) {
      const v = Number(setValues["weekly-tokens"]);
      if (!Number.isFinite(v) || v < 0) {
        console.error("Error: --weekly-tokens must be a non-negative number");
        process.exit(1);
      }
      budget.weekly_token_limit = v === 0 ? undefined : v;
    }

    if (setValues["daily-cost"] !== undefined) {
      const v = Number(setValues["daily-cost"]);
      if (!Number.isFinite(v) || v < 0) {
        console.error("Error: --daily-cost must be a non-negative number");
        process.exit(1);
      }
      budget.daily_cost_limit = v === 0 ? undefined : v;
    }

    if (setValues["weekly-cost"] !== undefined) {
      const v = Number(setValues["weekly-cost"]);
      if (!Number.isFinite(v) || v < 0) {
        console.error("Error: --weekly-cost must be a non-negative number");
        process.exit(1);
      }
      budget.weekly_cost_limit = v === 0 ? undefined : v;
    }

    // Remove undefined keys so the JSON stays clean
    (Object.keys(budget) as Array<keyof BudgetConfig>).forEach((k) => {
      if (budget[k] === undefined) delete budget[k];
    });

    config.budget = Object.keys(budget).length > 0 ? budget : undefined;
    saveConfig(config);

    if (config.budget) {
      console.log("Budget limits updated:");
      if (config.budget.daily_token_limit !== undefined)
        console.log(`  daily tokens:  ${config.budget.daily_token_limit.toLocaleString()}`);
      if (config.budget.weekly_token_limit !== undefined)
        console.log(`  weekly tokens: ${config.budget.weekly_token_limit.toLocaleString()}`);
      if (config.budget.daily_cost_limit !== undefined)
        console.log(`  daily cost:    $${config.budget.daily_cost_limit.toFixed(2)}`);
      if (config.budget.weekly_cost_limit !== undefined)
        console.log(`  weekly cost:   $${config.budget.weekly_cost_limit.toFixed(2)}`);
    } else {
      console.log("All budget limits cleared.");
    }
    process.exit(0);
  }

  console.error(`Unknown budget subcommand: ${subcommand}`);
  process.exit(1);
}

if (command === "snapshot") {
  const subArgs = rawArgs.slice(rawArgs.indexOf("snapshot") + 1);
  const subcommand = subArgs.find((a) => !a.startsWith("-"));

  if (!subcommand || subcommand === "help" || subArgs.includes("--help") || subArgs.includes("-h")) {
    console.log(`Usage: toktrace snapshot <subcommand> [options]

Subcommands:
  create   Create a named snapshot of current LLM event data
  list     List all snapshots
  show     Show a specific snapshot by ID

Options:
  --name <name>    Snapshot name (required for create)
  --since <iso>    Only include events at or after this timestamp
  --until <iso>    Only include events at or before this timestamp
  -h, --help       Show this help message
`);
    process.exit(0);
  }

  if (subcommand === "create") {
    const createArgv = subArgs.filter((a) => a !== "create");
    const parsed = parseArgs({
      args: createArgv,
      allowPositionals: false,
      options: {
        name: { type: "string" },
        since: { type: "string" },
        until: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    });

    if (parsed.values.help) {
      console.log(`Usage: toktrace snapshot create --name <name> [--since <iso>] [--until <iso>]

Create a named snapshot of LLM events for before/after comparison.

Options:
  --name <name>    Snapshot name, e.g. "before-refactor" (required)
  --since <iso>    Only include events at or after this ISO timestamp
  --until <iso>    Only include events at or before this ISO timestamp
  -h, --help       Show this help message
`);
      process.exit(0);
    }

    const name = parsed.values.name;
    if (!name) {
      console.error("Error: --name is required for snapshot create");
      console.error("  Example: toktrace snapshot create --name before-refactor");
      process.exit(1);
    }

    const snapshot = createSnapshot({
      name,
      since: parsed.values.since,
      until: parsed.values.until,
    });

    console.log(`Snapshot created: ${snapshot.snapshot_id}`);
    console.log(`  Name:       ${snapshot.name}`);
    console.log(`  Captured:   ${snapshot.captured_at}`);
    console.log(`  Events:     ${snapshot.event_ids.length}`);
    if (snapshot.window_start) {
      console.log(`  Window:     ${snapshot.window_start} → ${snapshot.window_end}`);
    }
    console.log(`  Tokens:     ${snapshot.summary.total_tokens.toLocaleString()} total (${snapshot.summary.total_input_tokens.toLocaleString()} in / ${snapshot.summary.total_output_tokens.toLocaleString()} out)`);
    console.log(`  Est. cost:  $${snapshot.summary.total_estimated_cost.toFixed(6)}`);
    if (snapshot.summary.suggestions.length > 0) {
      console.log(`  Suggestions:`);
      for (const s of snapshot.summary.suggestions) {
        console.log(`    • ${s}`);
      }
    }
    process.exit(0);
  }

  if (subcommand === "list") {
    const snapshots = listSnapshots();
    if (snapshots.length === 0) {
      console.log("No snapshots found. Create one with: toktrace snapshot create --name <name>");
      process.exit(0);
    }
    console.log(`${"ID".padEnd(38)}  ${"NAME".padEnd(30)}  ${"CAPTURED AT".padEnd(24)}  EVENTS`);
    console.log("─".repeat(100));
    for (const s of snapshots) {
      console.log(`${s.snapshot_id.padEnd(38)}  ${s.name.padEnd(30)}  ${s.captured_at.padEnd(24)}  ${s.event_ids.length}`);
    }
    process.exit(0);
  }

  if (subcommand === "show") {
    const id = subArgs.find((a) => !a.startsWith("-") && a !== "show");
    if (!id) {
      console.error("Error: snapshot ID required");
      console.error("  Usage: toktrace snapshot show <id>");
      process.exit(1);
    }
    const snapshot = getSnapshot(id);
    if (!snapshot) {
      console.error(`Error: no snapshot found with ID: ${id}`);
      process.exit(1);
    }
    console.log(JSON.stringify(snapshot, null, 2));
    process.exit(0);
  }

  console.error(`Unknown snapshot subcommand: ${subcommand}`);
  console.error("  Use: toktrace snapshot create|list|show");
  process.exit(1);
}

console.error(`Unknown command: ${command}`);
process.exit(1);
