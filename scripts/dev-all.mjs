#!/usr/bin/env node

import { spawn } from "node:child_process";

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const targets = [
  { name: "api", args: ["run", "dev:api"] },
  { name: "web", args: ["run", "dev:web"] },
];

let shuttingDown = false;
const children = targets.map((target) => {
  const child = spawn(npmCommand, target.args, {
    env: process.env,
    stdio: "inherit",
  });

  child.on("exit", (code, signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    const reason = signal ? `signal ${signal}` : `exit code ${code ?? 0}`;
    console.error(`[dev:${target.name}] stopped with ${reason}`);
    stopChildren();
    process.exitCode = code ?? 1;
  });

  child.on("error", (error) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`[dev:${target.name}] failed to start: ${error.message}`);
    stopChildren();
    process.exitCode = 1;
  });

  return child;
});

function stopChildren(signal = "SIGTERM") {
  for (const child of children) {
    if (!child.killed) child.kill(signal);
  }
}

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  stopChildren(signal);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
