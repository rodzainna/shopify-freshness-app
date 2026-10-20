import { execSync } from "node:child_process";
import { rmSync } from "node:fs";
import type { TestProject } from "vitest/node";

// Starts every run from an empty test database with the real migrations.
export default function setup(project: TestProject) {
  rmSync("prisma/test.sqlite", { force: true });
  execSync("npx prisma migrate deploy", {
    env: { ...process.env, ...project.config.env },
    stdio: "ignore",
  });
}
