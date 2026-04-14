import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { loadConfig, saveConfig, defaultConfigDir } from "./config.js";
import type { AlertsConfig, BudgetConfig } from "./config.js";
import { initStore, queryEvents, queryAggregate, insertEvent, saveSuggestions } from "./store.js";
import { createSnapshot, listSnapshots, getSnapshot } from "./snapshot.js";
import { exportSnapshot } from "./export.js";
import { compareSnapshots } from "./compare.js";
import { startDashboard } from "./dashboard.js";
import { deliverPendingAlerts } from "./alerts.js";
import { openBudgetDb } from "./budget.js";
import { listPricing } from "./pricing.js";
import { runRules } from "./suggestions.js";

function readVersion(): string {
  const here = typeof __filename !== "undefined"
    ? __filename
    : fileURLToPath(import.meta.url);
  const pkgPath = join(dirname(here), "../package.json");
  return JSON.parse(readFileSync(pkgPath, "utf-8")).version;
}

function runInitLikeCommand(commandName: "init" | "install"): void {
  const configDir = defaultConfigDir();
  const configPath = join(configDir, "config.json");
  const dbPath = join(configDir, "events.db");

  const configExisted = existsSync(configPath);
  const dbExisted = existsSync(dbPath);

  if (!configExisted) {
    saveConfig({});
  }

  initStore(dbPath);

  console.log(`${commandName === "install" ? "Installed" : "Initialized"} toktrace in ${configDir}`);
  console.log(`  config: ${configPath}${configExisted ? " (already existed)" : " (created)"}`);
  console.log(`  database: ${dbPath}${dbExisted ? " (already existed)" : " (created)"}`);
  console.log("");
  console.log("Zero-code tracing:");
  console.log("  toktrace run -- npm run dev");
  console.log("  toktrace run -- node server.js");
  console.log("");
  console.log("Or add this to your own command:");
  console.log("  node --import toktrace/auto <your-entry-file>");
  console.log("");
  console.log("Verify setup:");
  console.log("  toktrace verify");
}

function runWithAutoImport(args: string[]): void {
  if (args.length === 0) {
    console.error("Usage: toktrace run -- <command>");
    process.exit(1);
  }

  const command = args.join(" ");
  const currentNodeOptions = process.env.NODE_OPTIONS?.trim() ?? "";
  const importFlag = "--import toktrace/auto";
  const nodeOptions = currentNodeOptions.includes(importFlag)
    ? currentNodeOptions
    : `${currentNodeOptions} ${importFlag}`.trim();

  const child = spawn(command, {
    stdio: "inherit",
    shell: true,
    env: {
      ...process.env,
      NODE_OPTIONS: nodeOptions,
    },
  });

  child.on("exit", (code, signal) => {
    const dbPath = join(defaultConfigDir(), "events.db");
    const totals = queryAggregate({}, dbPath);

    console.log("");
    if (totals.event_count > 0) {
      console.log(`TokTrace captured ${totals.event_count} event${totals.event_count === 1 ? "" : "s"} so far.`);
      console.log("Next: toktrace dashboard");
    } else {
      console.log("No events captured yet.");
      console.log("Try making one LLM call in your app, then run: toktrace verify");
      console.log("Or seed demo data with: toktrace seed");
    }

    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });
}

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
  console.log(readVersion());
  process.exit(0);
}

if (!command || values.help) {
  console.log(`Usage: toktrace <command> [options]

Commands:
  init              Initialize toktrace in the current project
  install           Initialize toktrace and print zero-code run command
  run               Run a command with toktrace auto-instrumentation
  verify            Verify local setup and show first-event status
  seed              Insert sample events for a quick dashboard preview
  pricing           List supported models and their token pricing
  budget set        Set budget limits (daily/weekly token and cost caps)
  alerts set        Configure alert delivery (desktop notifications, CLI warnings)
  alerts deliver    Deliver any pending budget alerts now
  proxy add         Add a proxy target for an unsupported LLM provider
  proxy list        List configured proxy targets
  proxy remove      Remove a proxy target by name
  snapshot create   Create a named snapshot of recent LLM events
  snapshot list     List all snapshots
  snapshot show     Show a specific snapshot by ID
  snapshot compare  Compare two snapshots side by side
  snapshot export   Export a snapshot as a ZIP bundle (JSON + MD + metadata)
  suggest           Run optimization rules and print suggestion cards
  dashboard         Launch the comparison dashboard web UI

Options:
  -h, --help     Show this help message
  -v, --version  Show version
`);
  process.exit(command || values.help ? 0 : 1);
}

if (command === "init") {
  runInitLikeCommand("init");
  process.exit(0);
}

if (command === "install") {
  runInitLikeCommand("install");
  process.exit(0);
}

if (command === "run") {
  const separator = rawArgs.indexOf("--");
  const runArgs = separator >= 0 ? rawArgs.slice(separator + 1) : rawArgs.slice(1);
  runWithAutoImport(runArgs);
}

if (command === "verify") {
  const configDir = defaultConfigDir();
  const configPath = join(configDir, "config.json");
  const dbPath = join(configDir, "events.db");
  const configExists = existsSync(configPath);
  const dbExists = existsSync(dbPath);
  const totals = dbExists ? queryAggregate({}, dbPath) : null;

  console.log("TokTrace setup check");
  console.log(`  config: ${configExists ? "ok" : "missing"} (${configPath})`);
  console.log(`  database: ${dbExists ? "ok" : "missing"} (${dbPath})`);

  if (!configExists || !dbExists) {
    console.log("");
    console.log("Run this first:");
    console.log("  toktrace install");
    process.exit(1);
  }

  const eventCount = totals?.event_count ?? 0;
  console.log(`  events captured: ${eventCount}`);

  if (eventCount === 0) {
    console.log("");
    console.log("No events yet. Next steps:");
    console.log("  1) Run your app with toktrace: toktrace run -- <your-command>");
    console.log("  2) Make at least one LLM call");
    console.log("  3) Re-run: toktrace verify");
    console.log("  Optional demo mode: toktrace seed");
    process.exit(0);
  }

  const sevenDaysAgo = new Date(Date.now() - (7 * 24 * 60 * 60 * 1000)).toISOString();
  const recentTotals = queryAggregate({ since: sevenDaysAgo }, dbPath);
  console.log(`  events (last 7d): ${recentTotals.event_count}`);
  console.log(`  total tokens: ${totals?.total_tokens.toLocaleString() ?? 0}`);
  console.log(`  estimated cost: $${(totals?.estimated_cost ?? 0).toFixed(6)}`);
  console.log("");
  console.log("Looks good. Open the dashboard:");
  console.log("  toktrace dashboard");
  process.exit(0);
}

if (command === "seed") {
  const parsedSeed = parseArgs({
    args: rawArgs.slice(1),
    allowPositionals: false,
    options: {
      count: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });

  if (parsedSeed.values.help) {
    console.log(`Usage: toktrace seed [--count N]

Insert sample token events so the dashboard has immediate data.

Options:
  --count N     Number of sample events to insert (default: 30, max: 500)
  -h, --help    Show this help message
`);
    process.exit(0);
  }

  const requestedCount = parsedSeed.values.count ? Number(parsedSeed.values.count) : 30;
  if (!Number.isFinite(requestedCount) || requestedCount <= 0) {
    console.error("Error: --count must be a positive number");
    process.exit(1);
  }
  const count = Math.min(Math.floor(requestedCount), 500);
  const dbPath = join(defaultConfigDir(), "events.db");
  initStore(dbPath);

  const now = Date.now();
  const models = ["gpt-4o-mini", "gpt-4.1-mini", "claude-sonnet-4-6"];
  const providers = ["openai", "openai", "anthropic"];
  const routes = ["/chat", "/summarize", "/support-agent"];

  for (let i = 0; i < count; i += 1) {
    const m = i % models.length;
    const input = 250 + ((i * 37) % 1200);
    const output = 80 + ((i * 19) % 600);
    const total = input + output;
    const timestamp = new Date(now - ((count - i) * 90_000)).toISOString();
    insertEvent({
      id: randomUUID(),
      timestamp,
      model: models[m],
      provider: providers[m],
      input_tokens: input,
      output_tokens: output,
      total_tokens: total,
      estimated_cost: total * 0.0000015,
      latency_ms: 120 + ((i * 43) % 1900),
      prompt_hash: `seed_${(i % 8).toString(16)}${(i % 13).toString(16)}`,
      app_tag: routes[i % routes.length],
      env: "dev",
      tool_calls: i % 3 === 0 ? JSON.stringify([{ name: "search", args: { q: "seed" } }]) : null,
      context_size_tokens: input,
      tool_call_count: i % 3 === 0 ? 1 : 0,
    }, dbPath);
  }

  console.log(`Inserted ${count} sample events into ${dbPath}`);
  console.log("Next:");
  console.log("  toktrace dashboard");
  process.exit(0);
}

if (command === "pricing") {
  const pricingArgs = rawArgs.slice(rawArgs.indexOf("pricing") + 1);
  const parsedPricing = parseArgs({
    args: pricingArgs,
    allowPositionals: false,
    options: {
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });

  if (parsedPricing.values.help) {
    console.log(`Usage: toktrace pricing [--json]

List all supported models with their per-1k-token pricing (input and output).

Options:
  --json       Output as JSON array
  -h, --help   Show this help message
`);
    process.exit(0);
  }

  const entries = listPricing();

  if (parsedPricing.values.json) {
    console.log(JSON.stringify(entries, null, 2));
    process.exit(0);
  }

  console.log(`${"MODEL".padEnd(32)} ${"PROVIDER".padEnd(12)} ${"INPUT/1k".padStart(12)} ${"OUTPUT/1k".padStart(12)}`);
  console.log("─".repeat(70));

  let lastProvider = "";
  for (const e of entries) {
    if (e.provider !== lastProvider && lastProvider !== "") {
      console.log("");
    }
    lastProvider = e.provider;
    const inp = `$${e.input_per_1k.toFixed(6)}`;
    const out = `$${e.output_per_1k.toFixed(6)}`;
    console.log(`${e.model.padEnd(32)} ${e.provider.padEnd(12)} ${inp.padStart(12)} ${out.padStart(12)}`);
  }
  console.log(`\n${entries.length} models supported. Unknown models return $0 cost estimate.`);
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

if (command === "proxy") {
  const subcommand = positionals[1];

  if (!subcommand || subcommand === "help" || values.help) {
    console.log(`Usage: toktrace proxy <subcommand> [options]

Subcommands:
  add      Add a proxy target for a generic HTTP LLM provider
  list     List all configured proxy targets
  remove   Remove a proxy target by name

Options for 'add':
  --name <name>            Provider name, e.g. "mistral" (required)
  --url <pattern>          URL substring to match, e.g. "api.mistral.ai" (required)
  --model-path <path>      Dot-path to model in response JSON (default: "model")
  --input-path <path>      Dot-path to input token count (default: "usage.prompt_tokens")
  --output-path <path>     Dot-path to output token count (default: "usage.completion_tokens")

Options for 'remove':
  --name <name>            Provider name to remove (required)
`);
    process.exit(0);
  }

  if (subcommand === "add") {
    const { values: addValues } = parseArgs({
      args: process.argv.slice(4),
      allowPositionals: false,
      options: {
        name: { type: "string" },
        url: { type: "string" },
        "model-path": { type: "string" },
        "input-path": { type: "string" },
        "output-path": { type: "string" },
      },
    });

    if (!addValues.name) {
      console.error("Error: --name is required");
      process.exit(1);
    }
    if (!addValues.url) {
      console.error("Error: --url is required");
      process.exit(1);
    }

    const config = loadConfig();
    const targets = config.proxy_targets ?? [];

    // Replace existing target with same name
    const existing = targets.findIndex((t) => t.name === addValues.name);
    const target = {
      name: addValues.name,
      urlPattern: addValues.url,
      ...(addValues["model-path"] ? { modelPath: addValues["model-path"] } : {}),
      ...(addValues["input-path"] ? { inputTokensPath: addValues["input-path"] } : {}),
      ...(addValues["output-path"] ? { outputTokensPath: addValues["output-path"] } : {}),
    };

    if (existing >= 0) {
      targets[existing] = target;
      console.log(`Updated proxy target: ${addValues.name}`);
    } else {
      targets.push(target);
      console.log(`Added proxy target: ${addValues.name}`);
    }

    config.proxy_targets = targets;
    saveConfig(config);

    console.log(`  URL pattern:   ${target.urlPattern}`);
    console.log(`  Model path:    ${target.modelPath ?? "model"}`);
    console.log(`  Input path:    ${target.inputTokensPath ?? "usage.prompt_tokens"}`);
    console.log(`  Output path:   ${target.outputTokensPath ?? "usage.completion_tokens"}`);
    process.exit(0);
  }

  if (subcommand === "list") {
    const config = loadConfig();
    const targets = config.proxy_targets ?? [];

    if (targets.length === 0) {
      console.log("No proxy targets configured.");
      console.log("  Add one with: toktrace proxy add --name mistral --url api.mistral.ai");
      process.exit(0);
    }

    console.log(`${"NAME".padEnd(20)}  ${"URL PATTERN".padEnd(35)}  ${"MODEL PATH".padEnd(15)}  ${"INPUT PATH".padEnd(25)}  OUTPUT PATH`);
    console.log("─".repeat(120));
    for (const t of targets) {
      console.log(
        `${t.name.padEnd(20)}  ${t.urlPattern.padEnd(35)}  ${(t.modelPath ?? "model").padEnd(15)}  ${(t.inputTokensPath ?? "usage.prompt_tokens").padEnd(25)}  ${t.outputTokensPath ?? "usage.completion_tokens"}`
      );
    }
    process.exit(0);
  }

  if (subcommand === "remove") {
    const { values: rmValues } = parseArgs({
      args: process.argv.slice(4),
      allowPositionals: false,
      options: {
        name: { type: "string" },
      },
    });

    if (!rmValues.name) {
      console.error("Error: --name is required");
      process.exit(1);
    }

    const config = loadConfig();
    const targets = config.proxy_targets ?? [];
    const before = targets.length;
    config.proxy_targets = targets.filter((t) => t.name !== rmValues.name);

    if (config.proxy_targets.length === before) {
      console.error(`Error: no proxy target found with name: ${rmValues.name}`);
      process.exit(1);
    }

    if (config.proxy_targets.length === 0) {
      config.proxy_targets = undefined;
    }

    saveConfig(config);
    console.log(`Removed proxy target: ${rmValues.name}`);
    process.exit(0);
  }

  console.error(`Unknown proxy subcommand: ${subcommand}`);
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

    exportSnapshot({
      name,
      outDir: parsed.values.output,
    }).then((result) => {
      console.log(`Snapshot exported: ${result.zipPath}`);
      console.log(`  Name:      ${result.snapshot.name}`);
      console.log(`  Events:    ${result.snapshot.summary.event_count}`);
      console.log(`  Contains:  snapshot.json, report.md, metadata.json`);
      process.exit(0);
    }).catch((err) => {
      console.error(`Error: ${(err as Error).message}`);
      process.exit(1);
    });
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

if (command === "suggest") {
  const suggestArgs = rawArgs.slice(rawArgs.indexOf("suggest") + 1);
  const parsed = parseArgs({
    args: suggestArgs,
    allowPositionals: false,
    options: {
      json: { type: "boolean" },
      since: { type: "string" },
      until: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });

  if (parsed.values.help) {
    console.log(`Usage: toktrace suggest [--json] [--since <iso>] [--until <iso>]

Run all optimization rules against recorded LLM events and print suggestion cards.
New suggestions are persisted for display in the dashboard.

Options:
  --json           Output as JSON array
  --since <iso>    Only include events at or after this ISO timestamp
  --until <iso>    Only include events at or before this ISO timestamp
  -h, --help       Show this help message
`);
    process.exit(0);
  }

  const events = queryEvents({
    since: parsed.values.since,
    until: parsed.values.until,
  });

  if (events.length === 0) {
    if (parsed.values.json) {
      console.log("[]");
    } else {
      console.log("No events found. Record some LLM calls first, then re-run.");
    }
    process.exit(0);
  }

  const cards = runRules(events);
  const saved = saveSuggestions(cards);

  if (parsed.values.json) {
    console.log(JSON.stringify(cards, null, 2));
  } else if (cards.length === 0) {
    console.log(`Analyzed ${events.length} events — no suggestions.`);
  } else {
    console.log(`Analyzed ${events.length} events — ${cards.length} suggestion(s):\n`);
    for (const card of cards) {
      const pct = Math.round(card.confidence * 100);
      console.log(`  [${card.rule}] ${card.title}  (${pct}% confidence)`);
      console.log(`    Impact: ${card.impact}`);
      console.log(`    Action: ${card.action}`);
      console.log("");
    }
    if (saved > 0) {
      console.log(`${saved} new suggestion(s) saved.`);
    }
  }
  process.exit(0);
}

if (command === "dashboard") {
  const dashArgs = rawArgs.slice(rawArgs.indexOf("dashboard") + 1);
  const parsed = parseArgs({
    args: dashArgs,
    allowPositionals: false,
    options: {
      port: { type: "string" },
      "no-open": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });

  if (parsed.values.help) {
    console.log(`Usage: toktrace dashboard [--port <number>] [--no-open]

Launch the TokTrace dashboard and open it in your browser.
If the default port is in use, the next available port is tried automatically.

Options:
  --port <number>  Port to listen on (default: 4242, auto-increments if taken)
  --no-open        Don't open the browser automatically
  -h, --help       Show this help message
`);
    process.exit(0);
  }

  const port = parsed.values.port ? Number(parsed.values.port) : undefined;
  if (port !== undefined && (!Number.isFinite(port) || port < 1 || port > 65535)) {
    console.error("Error: --port must be a number between 1 and 65535");
    process.exit(1);
  }

  startDashboard({ port, open: !parsed.values["no-open"] });
  // Server keeps the process alive — no process.exit() here
} else if (
  command !== "init" &&
  command !== "install" &&
  command !== "run" &&
  command !== "pricing" &&
  command !== "budget" &&
  command !== "alerts" &&
  command !== "proxy" &&
  command !== "snapshot" &&
  command !== "suggest"
) {
  console.error(`Unknown command: ${command}`);
  process.exit(1);
}
