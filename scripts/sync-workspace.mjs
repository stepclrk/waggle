/**
 * Workspace linker for filesystems without symlink support (this repo lives on
 * exFAT, where symlinks/junctions/hardlinks all fail). Copies each built
 * workspace package into its dependents' node_modules.
 *
 * Usage: node scripts/sync-workspace.mjs   (root `pnpm build` runs this first)
 * If the repo ever moves to NTFS, delete this and use `workspace:*` deps.
 */

import { cp, rm, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** package name -> its dependents */
const LINKS = {
  "@waggle/core": ["packages/server", "packages/client", "packages/cli", "packages/mcp"],
  "@waggle/client": ["packages/cli", "packages/mcp"],
};

const SOURCE_DIRS = {
  "@waggle/core": "packages/core",
  "@waggle/client": "packages/client",
};

for (const [name, dependents] of Object.entries(LINKS)) {
  const srcDir = path.join(root, SOURCE_DIRS[name]);
  if (!existsSync(path.join(srcDir, "dist"))) {
    // Not built yet — skip. The root build calls sync between build steps
    // (core → sync → client → sync → rest), so a package is synced once its
    // dist exists on a later pass. Failing here would break a clean build.
    console.error(`sync-workspace: ${name} not built yet, skipping`);
    continue;
  }
  const pkg = JSON.parse(await readFile(path.join(srcDir, "package.json"), "utf8"));

  for (const dep of dependents) {
    const depDir = path.join(root, dep);
    if (!existsSync(depDir)) continue;
    const target = path.join(depDir, "node_modules", ...name.split("/"));
    await rm(target, { recursive: true, force: true });
    await mkdir(target, { recursive: true });
    await cp(path.join(srcDir, "dist"), path.join(target, "dist"), { recursive: true });
    await cp(path.join(srcDir, "package.json"), path.join(target, "package.json"));
    console.log(`linked ${name}@${pkg.version} -> ${dep}`);
  }
}
