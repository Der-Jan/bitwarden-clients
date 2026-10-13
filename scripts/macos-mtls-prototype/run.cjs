// Build only the probe and common selection modules; do not install the whole monorepo.
const { buildSync } = require("esbuild");
const { copyFileSync, mkdtempSync } = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const { spawnSync } = require("node:child_process");
const output = mkdtempSync(join(tmpdir(), "bw-mtls-build-"));
buildSync({
  entryPoints: [join(__dirname, "main.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["electron"],
  outfile: join(output, "main.cjs"),
});
for (const file of ["index.html", "renderer.js", "preload.cjs"]) {
  copyFileSync(join(__dirname, file), join(output, file));
}
const environment = { ...process.env };
delete environment.ELECTRON_RUN_AS_NODE;
const automatic = process.argv.includes("--automatic");
const result = spawnSync(
  require("electron"),
  [join(output, "main.cjs"), "-ApplePersistenceIgnoreState", "YES", ...process.argv.slice(2)],
  {
    stdio: "inherit",
    env: environment,
    timeout: automatic ? 40_000 : undefined,
    killSignal: "SIGKILL",
  },
);
if (result.error) {
  console.error("probe-process-failed-or-timed-out");
}
process.exit(result.status ?? 1);
