import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { loadConfig, saveConfig, defaultConfigDir } from "./config.js";
import type { AlertsConfig, BudgetConfig } from "./config.js";
import { initStore } from "./store.js";
import { createSnapshot, listSnapshots, getSnapshot } from "./snapshot.js";
import { exportSnapshot } from "./export.js";
import { compareSnapshots } from "./compare.js";
import { startDashboard } from "./dashboard.js";
import { deliverPendingAlerts } from "./alerts.js";
import { openBudgetDb } from "./budget.js";

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
  alerts set        Configure alert delivery (desktop notifications, CLI warnings)
  alerts deliver    Deliver any pending budget alerts now
  snapshot create   Create a named snapshot of recent LLM events
  snapshot list     List all snapshots
  snapshot show     Show a specific snapshot by ID
  snapshot compare  Compare two snapshots side by side
  snapshot export   Export a snapshot as a ZIP bundle (JSON + MD + metadata)
  dashboard         Launch the comparison dashboard web UI

Options:
  -h, --help     Show this help message
  -v, --version  Show version
`);
  process.exit(command || values.help ? 0 : 1);
}

if (command === "init") {
  const configDir = defaultConfigDir();
  const configPath = join(configDir, "config.json");
  const dbPath = join(configDir, "events.db");

  const configExisted = existsSync(configPath);
  const dbExisted = existsSync(dbPath);

  // Write default config if it doesn't exist, preserve existing config
  if (!configExisted) {
    saveConfig({});
  }

  // Initialize the SQLite database (creates tables if needed)
  initStore(dbPath);

  console.log(`Initialized toktrace in ${configDir}`);
  console.log(`  config: ${configPath}${configExisted ? " (already existed)" : " (created)"}`);
  console.log(`  database: ${dbPath}${dbExisted ? " (already existed)" : " (created)"}`);
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

if (command === "alerts") {
  const subcommand = positionals[1];

  if (!subcommand || subcommand === "help" || values.help) {
    console.log(`Usage: toktrace alerts <subcommand> [options]

Subcommands:
  set       Configure alert delivery channels
  deliver   Deliver any pending budget alerts now

Options for 'set':
  --desktop <on|off>   Enable/disable desktop notifications (default: on)
  --cli <on|off>       Enable/disable CLI stderr warnings (default: on)
`);
    process.exit(0);
  }

  if (subcommand === "set") {
    const { values: setValues } = parseArgs({
      args: process.argv.slice(4),
      allowPositionals: false,
      options: {
        desktop: { type: "string" },
        cli: { type: "string" },
      },
    });

    const config = loadConfig();
    const alerts: AlertsConfig = config.alerts ?? {};

    if (setValues.desktop !== undefined) {
      if (setValues.desktop !== "on" && setValues.desktop !== "off") {
        console.error("Error: --desktop must be 'on' or 'off'");
        process.exit(1);
      }
      alerts.desktop = setValues.desktop === "on";
    }

    if (setValues.cli !== undefined) {
      if (setValues.cli !== "on" && setValues.cli !== "off") {
        console.error("Error: --cli must be 'on' or 'off'");
        process.exit(1);
      }
      alerts.cli = setValues.cli === "on";
    }

    config.alerts = alerts;
    saveConfig(config);

    console.log("Alert settings updated:");
    console.log(`  desktop: ${alerts.desktop !== false ? "on" : "off"}`);
    console.log(`  cli:     ${alerts.cli !== false ? "on" : "off"}`);
    process.exit(0);
  }

  if (subcommand === "deliver") {
    const db = openBudgetDb();
    try {
      const delivered = deliverPendingAlerts(db);
      if (delivered.length === 0) {
        console.log("No pending alerts.");
      } else {
        console.log(`Delivered ${delivered.length} alert(s).`);
      }
    } finally {
      db.close();
    }
    process.exit(0);
  }

  console.error(`Unknown alerts subcommand: ${subcommand}`);
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
  compare  Compare two snapshots side by side
  export   Export a snapshot as a self-contained ZIP bundle

Options:
  --name <name>    Snapshot name (required for create and export)
  --a <id|name>    First snapshot for compare (before)
  --b <id|name>    Second snapshot for compare (after)
  --since <iso>    Only include events at or after this timestamp
  --until <iso>    Only include events at or before this timestamp
  --output <dir>   Output directory for export (defaults to cwd)
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

  if (subcommand === "export") {
    const exportArgv = subArgs.filter((a) => a !== "export");
    const parsed = parseArgs({
      args: exportArgv,
      allowPositionals: false,
      options: {
        name: { type: "string" },
        output: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    });

    if (parsed.values.help) {
      console.log(`Usage: toktrace snapshot export --name <name> [--output <dir>]

Export a snapshot as a self-contained ZIP bundle for sharing.
The bundle contains snapshot.json, report.md, and metadata.json.

Options:
  --name <name>    Snapshot name or ID to export (required)
  --output <dir>   Output directory (defaults to current directory)
  -h, --help       Show this help message
`);
      process.exit(0);
    }

    const name = parsed.values.name;
    if (!name) {
      console.error("Error: --name is required for snapshot export");
      console.error("  Example: toktrace snapshot export --name before-refactor");
      process.exit(1);
    }

    try {
      const result = await exportSnapshot({
        name,
        outDir: parsed.values.output,
      });
      console.log(`Snapshot exported: ${result.zipPath}`);
      console.log(`  Name:      ${result.snapshot.name}`);
      console.log(`  Events:    ${result.snapshot.summary.event_count}`);
      console.log(`  Contains:  snapshot.json, report.md, metadata.json`);
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exit(1);
    }
    process.exit(0);
  }

  if (subcommand === "compare") {
    const compareArgv = subArgs.filter((a) => a !== "compare");
    const parsed = parseArgs({
      args: compareArgv,
      allowPositionals: false,
      options: {
        a: { type: "string" },
        b: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    });

    if (parsed.values.help) {
      console.log(`Usage: toktrace snapshot compare --a <id|name> --b <id|name>

Compare two snapshots side by side showing deltas for tokens, cost, and top spenders.

Options:
  --a <id|name>    First snapshot — before (required)
  --b <id|name>    Second snapshot — after (required)
  -h, --help       Show this help message
`);
      process.exit(0);
    }

    if (!parsed.values.a || !parsed.values.b) {
      console.error("Error: both --a and --b are required for snapshot compare");
      console.error("  Example: toktrace snapshot compare --a before-refactor --b after-refactor");
      process.exit(1);
    }

    try {
      const result = compareSnapshots(parsed.values.a, parsed.values.b);
      const d = result.delta;

      console.log(`Comparing: "${result.snapshot_a.name}" vs "${result.snapshot_b.name}"\n`);

      const fmtDelta = (dv: { before: number; after: number; absolute: number; percent: number | null }, prefix = "", decimals = 0) => {
        const fmt = (n: number) => decimals > 0 ? `${prefix}${n.toFixed(decimals)}` : `${prefix}${n.toLocaleString()}`;
        const sign = dv.absolute > 0 ? "+" : dv.absolute < 0 ? "" : " ";
        const pct = dv.percent != null ? ` (${dv.percent > 0 ? "+" : ""}${dv.percent.toFixed(1)}%)` : "";
        return `${fmt(dv.before)}  →  ${fmt(dv.after)}  ${sign}${decimals > 0 ? `${prefix}${dv.absolute.toFixed(decimals)}` : `${prefix}${dv.absolute.toLocaleString()}`}${pct}`;
      };

      console.log("  Total tokens:    " + fmtDelta(d.total_tokens));
      console.log("  Input tokens:    " + fmtDelta(d.total_input_tokens));
      console.log("  Output tokens:   " + fmtDelta(d.total_output_tokens));
      console.log("  Est. cost:       " + fmtDelta(d.total_estimated_cost, "$", 6));
      console.log("  Events:          " + fmtDelta(d.event_count));

      if (result.top_spenders.length > 0) {
        console.log("\nTop Spenders:");
        for (const s of result.top_spenders) {
          const sign = s.absolute > 0 ? "+" : s.absolute < 0 ? "" : " ";
          const pct = s.percent != null ? ` (${s.percent > 0 ? "+" : ""}${s.percent.toFixed(1)}%)` : "";
          console.log(`  ${s.model.padEnd(30)} $${s.before_cost.toFixed(6)} → $${s.after_cost.toFixed(6)}  ${sign}$${s.absolute.toFixed(6)}${pct}`);
        }
      }

      if (result.suggestions_a.length > 0 || result.suggestions_b.length > 0) {
        console.log("\nSuggestions:");
        if (result.suggestions_a.length > 0) {
          console.log("  Before:");
          for (const s of result.suggestions_a) console.log(`    • ${s}`);
        }
        if (result.suggestions_b.length > 0) {
          console.log("  After:");
          for (const s of result.suggestions_b) console.log(`    • ${s}`);
        }
      }
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exit(1);
    }
    process.exit(0);
  }

  console.error(`Unknown snapshot subcommand: ${subcommand}`);
  console.error("  Use: toktrace snapshot create|list|show|compare|export");
  process.exit(1);
}

if (command === "dashboard") {
  const dashArgs = rawArgs.slice(rawArgs.indexOf("dashboard") + 1);
  const parsed = parseArgs({
    args: dashArgs,
    allowPositionals: false,
    options: {
      port: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });

  if (parsed.values.help) {
    console.log(`Usage: toktrace dashboard [--port <number>]

Launch the snapshot comparison dashboard in your browser.

Options:
  --port <number>  Port to listen on (default: 3000)
  -h, --help       Show this help message
`);
    process.exit(0);
  }

  const port = parsed.values.port ? Number(parsed.values.port) : undefined;
  if (port !== undefined && (!Number.isFinite(port) || port < 1 || port > 65535)) {
    console.error("Error: --port must be a number between 1 and 65535");
    process.exit(1);
  }

  startDashboard({ port });
  // Server keeps the process alive — no process.exit() here
} else {
  console.error(`Unknown command: ${command}`);
  process.exit(1);
}
