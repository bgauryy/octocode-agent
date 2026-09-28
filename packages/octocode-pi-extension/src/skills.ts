import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

/**
 * Pi already loads skills from ~/.agents/skills, ~/.pi/agent/skills and the
 * project's .agents/skills and .pi/skills. Octocode adds the directories other
 * agents use (Claude Code, Codex) so one skill install works everywhere.
 * Install Octocode skills with `npx octocode skill --add <name>`.
 */
export function extraSkillDirs(cwd: string, home = os.homedir(), projectTrusted = true): string[] {
  return [
    path.join(home, '.claude', 'skills'),
    path.join(home, '.codex', 'skills'),
    path.join(home, '.octocode', 'skills'),
    // Like Pi's own project skills, project directories load only for trusted projects.
    ...(projectTrusted ? [path.join(cwd, '.claude', 'skills')] : []),
  ].filter((dir) => {
    try {
      return fs.statSync(dir).isDirectory();
    } catch {
      return false;
    }
  });
}

export function registerSkills(pi: ExtensionAPI): void {
  pi.on('resources_discover', async (event, ctx) => ({ skillPaths: extraSkillDirs(event.cwd, undefined, ctx.isProjectTrusted()) }));
}
