import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultAgentSkillRoots, discoverAgentSkills, listAgentSkillFiles, parseAgentSkill } from '../src/agent-skills.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('Agent Skills specification', () => {
  it('parses full YAML metadata and keeps allowed-tools informational', () => {
    const parsed = parseAgentSkill(`---\nname: release-check\ndescription: >-\n  Run release checks safely across packages.\nlicense: MIT\ncompatibility: Requires Node.js 22+\nmetadata:\n  author: octocode\n  version: "1"\nallowed-tools: Bash(git:*) Read\n---\n# Release\n\nRun the checks.`, 'release-check');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.skill.description).toBe('Run release checks safely across packages.');
    expect(parsed.skill.metadata).toEqual({ author: 'octocode', version: '1' });
    expect(parsed.skill.allowedTools).toBe('Bash(git:*) Read');
  });

  it.each([
    ['bad directory name', 'valid-name', 'other-name'],
    ['consecutive hyphens', 'bad--name', 'bad--name'],
    ['non-string metadata', 'valid-name', 'valid-name', 'metadata:\n  version: 1\n'],
  ])('rejects %s', (_label, name, directory, extra = '') => {
    const parsed = parseAgentSkill(`---\nname: ${name}\ndescription: Valid description.\n${extra}---\n# Body`, directory);
    expect(parsed.ok).toBe(false);
  });

  it('discovers standard roots, rejects malformed skills, and preserves root precedence', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-skills-'));
    roots.push(root);
    const projectRoot = path.join(root, 'project', '.agents', 'skills');
    const userRoot = path.join(root, 'home', '.agents', 'skills');
    for (const [base, description] of [[userRoot, 'user'], [projectRoot, 'project']] as const) {
      const dir = path.join(base, 'release-check');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: release-check\ndescription: ${description} skill\n---\n# Release`);
    }
    const invalid = path.join(projectRoot, 'BAD');
    fs.mkdirSync(invalid, { recursive: true });
    fs.writeFileSync(path.join(invalid, 'SKILL.md'), '---\nname: BAD\ndescription: bad\n---\n# Bad');

    const result = discoverAgentSkills([userRoot, projectRoot]);
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0]?.description).toBe('project skill');
    expect(result.errors).toHaveLength(1);
  });

  it('skips support-file symlinks without hiding later files', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-skill-files-'));
    roots.push(root);
    fs.writeFileSync(path.join(root, 'SKILL.md'), '# Skill');
    fs.writeFileSync(path.join(root, 'z-details.md'), '# Details');
    fs.symlinkSync(path.join(root, 'z-details.md'), path.join(root, 'a-link.md'));

    expect(listAgentSkillFiles(root)).toEqual(['z-details.md']);
  });

  it('discovers project Skill roots from the repository root through a nested working directory', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-skill-roots-'));
    roots.push(root);
    fs.mkdirSync(path.join(root, '.git'));
    const nested = path.join(root, 'packages', 'app');
    fs.mkdirSync(nested, { recursive: true });

    const discovered = defaultAgentSkillRoots(nested, path.join(root, 'home'), path.join(root, 'octocode-home'));

    expect(discovered).toContain(path.join(root, '.agents', 'skills'));
    expect(discovered).toContain(path.join(root, 'packages', '.agents', 'skills'));
    expect(discovered).toContain(path.join(nested, '.agents', 'skills'));
    expect(discovered.indexOf(path.join(root, '.agents', 'skills')))
      .toBeLessThan(discovered.indexOf(path.join(nested, '.agents', 'skills')));
  });
});
