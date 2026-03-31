#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const CANONICAL_MODES = ['local', 'uat', 'prod'];

const repoRoot = path.resolve(__dirname, '../..');
const webRoot = path.resolve(__dirname, '..');
const nextBuildRoot = path.join(webRoot, '.next');

function runCommand(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd || repoRoot,
    stdio: options.stdio || 'pipe',
    env: options.env || process.env,
    encoding: 'utf8',
  });
}

function listenerPids(port) {
  const result = runCommand('lsof', ['-t', '-nP', `-iTCP:${port}`, '-sTCP:LISTEN']);
  if (result.status !== 0 && !String(result.stderr || '').includes('No such file')) {
    return [];
  }
  return String(result.stdout || '')
    .split(/\s+/)
    .map((value) => value.trim())
    .filter(Boolean);
}

function isManagedFrontendProcess(pid) {
  const result = runCommand('ps', ['-o', 'command=', '-p', String(pid)]);
  if (result.status !== 0) {
    return false;
  }
  const command = String(result.stdout || '');
  return command.includes('next dev') && command.includes(path.join('hushh-research', 'hushh-webapp'));
}

function stopExistingManagedFrontend() {
  const pids = listenerPids(3000);
  if (pids.length === 0) {
    return;
  }

  const safeToKill = pids.every((pid) => isManagedFrontendProcess(pid));
  if (!safeToKill) {
    console.error(
      'Port 3000 is already in use by a non-managed process. Stop it before launching the Hushh frontend.'
    );
    process.exit(1);
  }

  console.log('Stopping existing managed frontend on :3000...');
  for (const pid of pids) {
    try {
      process.kill(Number(pid), 'SIGTERM');
    } catch {
      // ignore stale pid
    }
  }
}

function cleanNextBuildArtifacts() {
  if (!fs.existsSync(nextBuildRoot)) {
    return;
  }

  console.log('Cleaning stale .next build artifacts before starting the frontend...');
  fs.rmSync(nextBuildRoot, { recursive: true, force: true });
}

function parseArgs(argv) {
  const passthrough = [];
  let profile = null;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') {
      passthrough.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith('--mode=')) {
      profile = arg.split('=', 2)[1] || null;
      continue;
    }
    if (arg === '--mode') {
      profile = argv[i + 1] || null;
      i += 1;
      continue;
    }
    if (arg.startsWith('--profile=')) {
      profile = arg.split('=', 2)[1] || null;
      continue;
    }
    if (arg === '--profile') {
      profile = argv[i + 1] || null;
      i += 1;
      continue;
    }
    passthrough.push(arg);
  }

  return { profile, passthrough };
}

function normalizeProfile(raw) {
  const normalized = String(raw || '').trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === 'local-uatdb' || normalized === 'development' || normalized === 'dev') return 'local';
  if (normalized === 'uat-remote') return 'uat';
  if (normalized === 'prod-remote' || normalized === 'production') return 'prod';
  if (CANONICAL_MODES.includes(normalized)) return normalized;
  return null;
}

function activateProfile(profile) {
  const scriptPath = path.join(repoRoot, 'scripts/env/use_profile.sh');
  const result = spawnSync('bash', [scriptPath, profile], {
    cwd: repoRoot,
    stdio: 'inherit',
    env: process.env,
  });

  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

function ensureWebDependenciesReady() {
  const packageJsonPath = path.join(webRoot, 'package.json');
  const packageLockPath = path.join(webRoot, 'package-lock.json');
  const installedLockPath = path.join(webRoot, 'node_modules', '.package-lock.json');
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  const requiredDeps = Object.keys(packageJson.dependencies || {});
  const missingDeps = requiredDeps.filter((dep) => {
    const depPackagePath = path.join(webRoot, 'node_modules', ...dep.split('/'), 'package.json');
    return !fs.existsSync(depPackagePath);
  });

  if (missingDeps.length > 0) {
    const preview = missingDeps.slice(0, 6).join(', ');
    const suffix = missingDeps.length > 6 ? ` and ${missingDeps.length - 6} more` : '';
    console.error(
      `Missing installed web dependencies: ${preview}${suffix}. ` +
        "Run 'cd hushh-webapp && npm install' before starting the dev server."
    );
    process.exit(1);
  }

  if (fs.existsSync(packageLockPath) && fs.existsSync(installedLockPath)) {
    const packageLockStat = fs.statSync(packageLockPath);
    const installedLockStat = fs.statSync(installedLockPath);
    if (packageLockStat.mtimeMs > installedLockStat.mtimeMs + 1000) {
      console.error(
        "Your installed dependencies look older than package-lock.json. " +
          "Run 'cd hushh-webapp && npm install' before starting the dev server."
      );
      process.exit(1);
    }
  }
}

async function main() {
  const { profile: argProfile, passthrough } = parseArgs(process.argv.slice(2));
  const envProfile = normalizeProfile(process.env.APP_RUNTIME_PROFILE);
  const requested = normalizeProfile(argProfile) || envProfile;
  const defaultProfile = 'uat';

  const profile = requested || defaultProfile;
  if (!requested) {
    console.log(
      `No runtime mode was specified. Defaulting to ${profile}. ` +
        'Use npm run web -- --mode=<local|uat|prod> from the repo root or npm run dev -- --mode=<local|uat|prod> in hushh-webapp for an explicit target.'
    );
  }

  if (!profile) {
    console.error('Invalid runtime mode. Use one of: local, uat, prod');
    process.exit(1);
  }

  ensureWebDependenciesReady();
  activateProfile(profile);
  stopExistingManagedFrontend();
  cleanNextBuildArtifacts();

  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const args = ['run', 'dev:next'];
  if (passthrough.length > 0) {
    args.push('--', ...passthrough);
  }

  const child = spawn(npmCmd, args, {
    cwd: webRoot,
    stdio: 'inherit',
    env: process.env,
  });

  child.on('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code || 0);
  });

  child.on('error', (error) => {
    console.error(`Failed to launch Next.js dev server: ${error.message}`);
    process.exit(1);
  });
}

main().catch((error) => {
  console.error(error?.message || error);
  process.exit(1);
});
