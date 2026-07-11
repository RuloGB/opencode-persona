import * as fs from "node:fs";
import * as path from "node:path";

export const ROLES = ["developer", "architect", "analyst", "qa"] as const;

export type Role = (typeof ROLES)[number];

export const ROLE_LABEL: Record<Role, string> = {
  developer: "Developer",
  architect: "Software Architect",
  analyst: "Analyst",
  qa: "QA",
};

const ROLE_INSTRUCTIONS_DIR = path.join("harness", "user-roles");

// File names are a compatibility contract with existing projects: do not rename.
const ROLE_FILE: Record<Role, string> = {
  developer: "DEV.md",
  architect: "ARQ.md",
  analyst: "BA.md",
  qa: "QA.md",
};

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

export function findProjectRoot(startDir: string): string | null {
  let dir = path.resolve(startDir);
  while (true) {
    if (fs.existsSync(path.join(dir, ROLE_INSTRUCTIONS_DIR))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function buildRoleContext(role: Role, projectRoot: string | null): string {
  const instructions = readRoleInstructions(role, projectRoot);
  if (instructions) {
    return `Active role instructions (${role} — ${ROLE_LABEL[role]}):\n\n${instructions}`;
  }
  return (
    `User role: ${role} (${ROLE_LABEL[role]}). ` +
    `harness/user-roles/${ROLE_FILE[role]} was not found in this project; use the default behavior.`
  );
}

function readRoleInstructions(role: Role, projectRoot: string | null): string | null {
  if (!projectRoot) return null;
  const filePath = path.join(projectRoot, ROLE_INSTRUCTIONS_DIR, ROLE_FILE[role]);
  try {
    return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf-8") : null;
  } catch {
    return null;
  }
}
