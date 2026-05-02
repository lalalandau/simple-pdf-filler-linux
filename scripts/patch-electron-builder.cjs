const { readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

const target = join(__dirname, "..", "node_modules", "app-builder-lib", "out", "node-module-collector", "nodeModulesCollector.js");
const source = readFileSync(target, "utf8");
const before = "shell: true, // `true`` is now required: https://github.com/electron-userland/electron-builder/issues/9488";
const after = "shell: process.platform === \"win32\", // Linux + Node 24 drops args when shell:true is used.";

if (!source.includes(after)) {
  if (!source.includes(before)) {
    throw new Error("electron-builder collector spawn configuration was not found.");
  }
  writeFileSync(target, source.replace(before, after));
}

