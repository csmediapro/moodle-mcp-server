#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

function readJson(path) {
  return JSON.parse(readFileSync(resolve(root, path), "utf8"));
}

function fail(message) {
  failures.push(message);
}

function checkEqual(label, actual, expected) {
  if (actual !== expected) {
    fail(`${label}: expected ${expected}, found ${actual ?? "missing"}`);
  }
}

const failures = [];
const serverPackage = readJson("packages/server/package.json");
const version = serverPackage.version;

if (!version) {
  fail("packages/server/package.json has no version");
}

for (const path of [
  "package.json",
  "packages/server/package.json",
  "packages/client/package.json",
]) {
  const pkg = readJson(path);
  checkEqual(`${path} version`, pkg.version, version);
}

const lock = readJson("package-lock.json");
for (const key of ["", "packages/server", "packages/client"]) {
  checkEqual(`package-lock ${key || "."} version`, lock.packages?.[key]?.version, version);
}

const serverJson = readJson("server.json");
checkEqual("server.json version", serverJson.version, version);

const npmPackage = serverJson.packages?.find((pkg) => pkg.registryType === "npm");
checkEqual("server.json npm package identifier", npmPackage?.identifier, serverPackage.name);
checkEqual("server.json npm package version", npmPackage?.version, version);

const changelog = readFileSync(resolve(root, "CHANGELOG.md"), "utf8");
if (!new RegExp(`^## ${version.replaceAll(".", "\\.")}\\b`, "m").test(changelog)) {
  fail(`CHANGELOG.md is missing a ## ${version} entry`);
}

if (failures.length > 0) {
  console.error("Version sync check failed:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log(`Version sync check passed for moodle-mcp-server-aql v${version}`);
