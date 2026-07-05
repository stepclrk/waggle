/**
 * Publish-time manifest shim (exFAT-safe workspace publishing).
 *
 * Locally, @waggle/* siblings are NOT declared as dependencies — declaring them
 * forces pnpm to symlink, which fails on exFAT (see scripts/sync-workspace.mjs).
 * But a PUBLISHED tarball must declare them or it's broken on install. So the
 * `prepack` hook injects the correct sibling deps (pinned to ^<this version>)
 * and `postpack` restores the clean, symlink-free manifest.
 *
 *   node ../../scripts/pack-manifest.mjs inject | restore
 *
 * Runs with cwd = the package being packed (npm/pnpm lifecycle contract).
 */

import { readFileSync, writeFileSync, existsSync, rmSync, copyFileSync } from "node:fs";

const mode = process.argv[2];
const PKG = "package.json";
const BAK = "package.json.packbak";

// Which sibling @waggle packages each package needs at runtime.
const SIBLINGS = {
  "@waggle/client": ["@waggle/core"],
  "@waggle/cli": ["@waggle/core", "@waggle/client"],
  "@waggle/mcp": ["@waggle/core", "@waggle/client"],
};

if (mode === "inject") {
  const pkg = JSON.parse(readFileSync(PKG, "utf8"));
  const siblings = SIBLINGS[pkg.name] ?? [];
  copyFileSync(PKG, BAK); // exact-restore backup
  const deps = { ...(pkg.dependencies ?? {}) };
  for (const s of siblings) deps[s] = `^${pkg.version}`;
  // Deterministic key order so the published manifest is stable.
  pkg.dependencies = Object.fromEntries(Object.keys(deps).sort().map((k) => [k, deps[k]]));
  // prepack/postpack are dev-only plumbing — don't ship them in the tarball.
  if (pkg.scripts) {
    delete pkg.scripts.prepack;
    delete pkg.scripts.postpack;
  }
  writeFileSync(PKG, JSON.stringify(pkg, null, 2) + "\n");
  console.error(`[pack-manifest] ${pkg.name}: injected ${siblings.join(", ") || "(none)"} @ ^${pkg.version}`);
} else if (mode === "restore") {
  if (existsSync(BAK)) {
    copyFileSync(BAK, PKG);
    rmSync(BAK);
    console.error("[pack-manifest] restored clean manifest");
  }
} else {
  console.error("usage: pack-manifest.mjs inject|restore");
  process.exit(1);
}
