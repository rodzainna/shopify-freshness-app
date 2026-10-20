import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { TestProject } from "vitest/node";

// Starts every run from an empty test database with the real migrations.
export default function setup(project: TestProject) {
  const root = project.config.root;
  const database = join(root, "prisma/test.sqlite");
  // A journal left by a crashed run would be replayed into the new database.
  for (const file of [database, `${database}-journal`]) {
    rmSync(file, { force: true });
  }

  const prisma = join(root, "node_modules/.bin/prisma");
  const schema = join(root, "prisma/schema.prisma");
  // "pipe" puts Prisma's error output in the thrown message.
  execFileSync(prisma, ["migrate", "deploy", "--schema", schema], {
    env: { ...process.env, ...project.config.env },
    stdio: "pipe",
  });
}
