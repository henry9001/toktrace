import { parseArgs } from "node:util";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    help: { type: "boolean", short: "h" },
    version: { type: "boolean", short: "v" },
  },
});

if (values.version) {
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  const pkg = require("../package.json") as { version: string };
  console.log(pkg.version);
  process.exit(0);
}

const command = positionals[0];

if (!command || values.help) {
  console.log(`Usage: toktrace <command> [options]

Commands:
  init    Initialize toktrace in the current project

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

console.error(`Unknown command: ${command}`);
process.exit(1);
