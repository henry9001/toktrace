import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: { index: "src/index.ts", auto: "src/auto.ts" },
    format: ["esm", "cjs"],
    dts: true,
    clean: true,
    sourcemap: true,
  },
  {
    entry: { cli: "src/cli.ts" },
    format: ["esm"],
    dts: false,
    clean: false,
    sourcemap: true,
    banner: {
      js: "#!/usr/bin/env node",
    },
  },
  {
    entry: { "cli-sea": "src/cli.ts" },
    format: ["cjs"],
    dts: false,
    clean: false,
    sourcemap: false,
    splitting: false,
    noExternal: [/.*/],
  },
]);
