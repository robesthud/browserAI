/**
 * Privileged Agent Runtime Tools
 * 
 * This is the "Arena-like" layer.
 * These tools run with the REAL process rights of the Node.js process
 * (the same as the main server), not inside agent-sandbox.
 * 
 * LLM only decides WHAT to call.
 * Execution happens here with full privileges.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

function truncate(str, max = 16000) {
  if (!str) return '';
  return str.length > max ? str.slice(0, max) + '\n...[truncated]' : str;
}

function ok(result) { return { ok: true, result }; }
function err(message) { return { ok: false, error: String(message) }; }

/**
 * Path Safety Guard to prevent directory traversal or reading highly sensitive system files.
 */
function isPathSafe(filePath) {
  if (!filePath) return false;
  const resolved = path.resolve(filePath);
  
  // Strict blocked list of system directories and files
  const blockedPatterns = [
    '/etc/shadow',
    '/etc/passwd',
    '/etc/gshadow',
    '/etc/group',
    '/root/.ssh',
    '/home/user/.ssh',
    '/etc/security',
    '/var/run/secrets',
    '.git/config',
    '.git/credentials',
    '.git-credentials',
    '.netrc'
  ];

  for (const pattern of blockedPatterns) {
    if (resolved.includes(pattern)) {
      return false;
    }
  }
  return true;
}

export const PRIVILEGED_TOOLS = {
  // === Direct Bash (like my main tool) ===
  host_bash: {
    description: 'Run ANY shell command DIRECTLY on the host with full process privileges (same as external Arena agent). No sandbox. Use for git, ssh, docker, file operations, etc.',
    params: {
      command: { type: 'string', required: true },
      cwd: { type: 'string', optional: true },
      timeout_sec: { type: 'number', optional: true, default: 120 },
    },
    handler: async ({ command, cwd, timeout_sec = 120 }) => {
      const workdir = cwd || process.cwd();
      const timeoutMs = Math.min(900000, Math.max(5000, Number(timeout_sec) * 1000));

      // Extra security audit for highly destructive command patterns
      const isDestructive = /(rm\s+-rf\s+\/|rm\s+-rf\s+\*|mkfs|dd\s+if|>\s*\/dev\/sd)/i.test(command);
      if (isDestructive) {
        return err('Security Violation: Destructive operations on system root or disk devices are strictly blocked.');
      }

      return new Promise((resolve) => {
        const proc = spawn('bash', ['-c', command], {
          cwd: workdir,
          env: { ...process.env },
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        let stdout = '', stderr = '';
        let killed = false;

        const timer = setTimeout(() => {
          killed = true;
          try { proc.kill('SIGKILL'); } catch {}
        }, timeoutMs);

        proc.stdout.on('data', (d) => { stdout += d.toString(); });
        proc.stderr.on('data', (d) => { stderr += d.toString(); });

        proc.on('close', (code) => {
          clearTimeout(timer);
          resolve(ok({
            stdout: truncate(stdout),
            stderr: truncate(stderr),
            exitCode: killed ? -1 : (code ?? -1),
            cwd: workdir,
            killed,
          }));
        });

        proc.on('error', (e) => {
          clearTimeout(timer);
          resolve(err(e.message));
        });
      });
    },
  },

  // === Direct file operations ===
  host_read_file: {
    description: 'Read any file on the host filesystem directly (full privileges).',
    params: {
      path: { type: 'string', required: true },
    },
    handler: async ({ path: filePath }) => {
      if (!isPathSafe(filePath)) {
        return err(`Security Access Denied: Access to sensitive system path "${filePath}" is restricted.`);
      }
      try {
        const content = await fs.readFile(filePath, 'utf8');
        return ok({ path: filePath, content: truncate(content, 20000), size: content.length });
      } catch (e) {
        return err(e.message);
      }
    },
  },

  host_write_file: {
    description: 'Write any file on the host filesystem directly.',
    params: {
      path: { type: 'string', required: true },
      content: { type: 'string', required: true },
    },
    handler: async ({ path: filePath, content }) => {
      if (!isPathSafe(filePath)) {
        return err(`Security Access Denied: Writing to sensitive system path "${filePath}" is restricted.`);
      }
      try {
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, content);
        return ok({ path: filePath, bytesWritten: content.length });
      } catch (e) {
        return err(e.message);
      }
    },
  },

  // === Direct Git with token support ===
  host_git_push: {
    description: 'Direct git commit + push with explicit token (exactly like external agent). Token can be passed in the call.',
    params: {
      message: { type: 'string', required: true },
      token: { type: 'string', optional: true, description: 'GitHub PAT (ghp_...)' },
      repo: { type: 'string', optional: true },
      branch: { type: 'string', optional: true, default: 'main' },
      cwd: { type: 'string', optional: true },
    },
    handler: async ({ message, token = '', repo = '', branch = 'main', cwd }) => {
      const workdir = cwd || process.cwd();
      const GITHUB_TOKEN = token || process.env.GITHUB_TOKEN || '';

      if (!GITHUB_TOKEN) return err('No GitHub token provided');

      let targetRepo = repo;
      if (!targetRepo) {
        // Try to detect from current remote
        try {
          const remProc = spawn('git', ['remote', 'get-url', 'origin'], { cwd: workdir });
          let remOut = '';
          remProc.stdout.on('data', d => remOut += d);
          await new Promise(r => remProc.on('close', r));
          const m = remOut.match(/github\.com[:/]([^/]+\/[^/\s]+?)(?:\.git)?$/i);
          if (m) targetRepo = m[1];
        } catch {}
      }

      if (!targetRepo) return err('Could not determine repo. Pass "repo": "owner/name"');

      const clean = targetRepo.replace(/^https?:\/\//i, '').replace(/\.git$/, '');
      const pushUrl = `https://x-access-token:${GITHUB_TOKEN}@github.com/${clean}.git`;

      const commands = [
        `git config user.name "BrowserAI Agent" || true`,
        `git config user.email "agent@browserai.local" || true`,
        `git add -A`,
        `git commit -m "${message.replace(/"/g, '\\"')}" || true`,
        `git remote set-url origin "${pushUrl}"`,
        `git push origin ${branch}`,
      ];

      const fullCommand = commands.join(' && ');

      return new Promise((resolve) => {
        const proc = spawn('bash', ['-c', fullCommand], { cwd: workdir });
        let out = '', errOut = '';
        proc.stdout.on('data', d => out += d);
        proc.stderr.on('data', d => errOut += d);
        proc.on('close', code => {
          resolve(ok({
            stdout: truncate(out),
            stderr: truncate(errOut),
            exitCode: code,
            pushed: code === 0,
            usedDirectToken: true,
          }));
        });
      });
    },
  },

  // === Direct SSH ===
  host_ssh: {
    description: 'Run command over SSH directly with full privileges (same as external agent).',
    params: {
      host: { type: 'string', required: true },
      user: { type: 'string', optional: true, default: 'root' },
      command: { type: 'string', required: true },
      key: { type: 'string', optional: true },
      timeout_sec: { type: 'number', optional: true, default: 60 },
    },
    handler: async ({ host, user = 'root', command, key, timeout_sec = 60 }) => {
      const keyPath = key || process.env.OPS_SSH_KEY || '/data/ops/timeweb_ed25519';
      const timeoutMs = Number(timeout_sec) * 1000;

      return new Promise((resolve) => {
        const sshCmd = ['ssh', '-i', keyPath, '-o', 'StrictHostKeyChecking=no', '-o', 'BatchMode=yes', `${user}@${host}`, command];
        const proc = spawn('ssh', sshCmd.slice(1), { timeout: timeoutMs });

        let stdout = '', stderr = '';
        proc.stdout.on('data', d => stdout += d);
        proc.stderr.on('data', d => stderr += d);

        proc.on('close', code => resolve(ok({ stdout: truncate(stdout), stderr: truncate(stderr), exitCode: code, host })));
        proc.on('error', e => resolve(err(e.message)));
      });
    },
  },

  // === Direct Docker (host level) ===
  host_docker: {
    description: 'Run docker commands directly on the host (ps, logs, compose, etc.).',
    params: {
      command: { type: 'string', required: true },
    },
    handler: async ({ command }) => {
      return new Promise((resolve) => {
        const proc = spawn('docker', command.split(/\s+/));
        let stdout = '', stderr = '';
        proc.stdout.on('data', d => stdout += d);
        proc.stderr.on('data', d => stderr += d);
        proc.on('close', code => resolve(ok({ stdout: truncate(stdout), stderr: truncate(stderr), exitCode: code })));
      });
    },
  },
};

export default PRIVILEGED_TOOLS;
