import { parseArgs } from "node:util";
import { loadConfig, saveConfig } from "./config.js";
import type { BudgetConfig } from "./config.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    help: { type: "boolean", short: "h" },
    version: { type: "boolean", short: "v" },
  },
  strict: false,
});

if (values.version) {
  const { default: pkg } = await import("../package.json", { with: { type: "json" } });
  console.log((pkg as { version: string }).version);
  process.exit(0);
}

const command = positionals[0];
const subcommand = positionals[1];

if (!command || values.help) {
  console.log(`Usage: toktrace <command> [options]

Commands:
  init              Initialize toktrace in the current project
  budget set        Set budget limits (daily/weekly token and cost caps)

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

console.error(`Unknown command: ${command}`);
process.exit(1);
