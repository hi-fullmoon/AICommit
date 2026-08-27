import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(PROJECT_ROOT, 'bin', 'aicommit.js');
const DEMO_ROOT = '/tmp/aicommit-readme-terminal';
const SCENARIOS = new Set(['commit', 'doctor', 'split-plan', 'split-apply']);

function run(file, args, cwd) {
  return execFileSync(file, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function git(cwd, args) {
  return run('git', args, cwd);
}

function createRepo(name, initialFiles) {
  const repo = join(DEMO_ROOT, name);
  mkdirSync(repo, { recursive: true });
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.name', 'AICommit Demo']);
  git(repo, ['config', 'user.email', 'demo@example.com']);
  for (const [path, contents] of Object.entries(initialFiles)) {
    writeFileSync(join(repo, path), contents);
  }
  git(repo, ['add', '.']);
  git(repo, ['commit', '-qm', 'chore: initialize demo']);
  return repo;
}

function startProvider(response) {
  const server = createServer((request, reply) => {
    request.resume();
    request.on('end', () => {
      reply.writeHead(200, { 'content-type': 'application/json' });
      reply.end(JSON.stringify(response));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function writeConfig(home, port) {
  writeFileSync(
    join(home, '.aicommit.config.json'),
    JSON.stringify({
      schemaVersion: 1,
      defaultProvider: 'demo',
      providers: {
        demo: {
          providerType: 'custom',
          apiUrl: `http://127.0.0.1:${port}/v1/chat/completions`,
          apiKey: '',
          defaultModel: 'default',
          models: { default: { modelId: 'readme-demo-model' } },
        },
      },
      language: 'en',
      reasoning: { mode: 'off' },
    }),
  );
}

function runCli(args, { cwd, home, visible = true }) {
  if (visible) {
    process.stdout.write('\u001b[2J\u001b[H');
    process.stdout.write(`$ aicommit ${args.join(' ')}\n`);
  }
  return new Promise((resolve, reject) => {
    const { NO_COLOR: _noColor, ...terminalEnvironment } = process.env;
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd,
      env: {
        ...terminalEnvironment,
        CI: '1',
        FORCE_COLOR: '3',
        HOME: home,
        TERM: process.env.TERM || 'xterm-256color',
        USERPROFILE: home,
      },
      stdio: visible ? 'inherit' : 'ignore',
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`aicommit ${args.join(' ')} exited ${code}`));
    });
  });
}

function prepareCommitRepo(name = 'commit') {
  const repo = createRepo(name, { 'src.js': 'export const value = 1;\n' });
  writeFileSync(join(repo, 'src.js'), 'export const value = 2;\nexport const ready = true;\n');
  writeFileSync(
    join(repo, 'test.js'),
    "import { ready } from './src.js';\nif (!ready) throw new Error('not ready');\n",
  );
  git(repo, ['add', '.']);
  return repo;
}

function prepareSplitRepo() {
  const repo = createRepo('split', { 'app.js': 'export const value = 1;\n' });
  writeFileSync(join(repo, 'app.js'), 'export const value = 2;\n');
  writeFileSync(join(repo, 'extra.js'), 'export const extra = true;\n');
  git(repo, ['add', '.']);
  return repo;
}

async function runCommit(home) {
  const repo = prepareCommitRepo();
  const server = await startProvider({
    model: 'readme-demo-model',
    choices: [
      { message: { content: 'feat(core): expose readiness state' }, finish_reason: 'stop' },
    ],
    usage: { prompt_tokens: 321, completion_tokens: 9, total_tokens: 330 },
  });
  try {
    writeConfig(home, server.address().port);
    await runCli(['--yes', '--no-reasoning'], { cwd: repo, home });
  } finally {
    await closeServer(server);
  }
}

async function runDoctor(home) {
  const repo = createRepo('doctor', { 'app.js': 'export const ready = true;\n' });
  const server = await startProvider({
    model: 'readme-demo-model',
    choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 },
  });
  try {
    writeConfig(home, server.address().port);
    await runCli(['doctor'], { cwd: repo, home });
  } finally {
    await closeServer(server);
  }
}

async function prepareSplitPlan(home, repo, planPath, visible) {
  const server = await startProvider({
    model: 'readme-demo-model',
    choices: [
      {
        message: {
          content: JSON.stringify([
            { subject: 'fix: update application value', files: ['app.js'] },
            { subject: 'feat: add extra module', files: ['extra.js'] },
          ]),
        },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 280, completion_tokens: 42, total_tokens: 322 },
  });
  try {
    writeConfig(home, server.address().port);
    await runCli(
      ['split', 'plan', '--scope=staged', `--file=${planPath}`, '--yes', '--no-reasoning'],
      { cwd: repo, home, visible },
    );
  } finally {
    await closeServer(server);
  }
}

async function runSplit(home, scenario) {
  const repo = prepareSplitRepo();
  const planPath = join(DEMO_ROOT, 'split-plan.json');
  await prepareSplitPlan(home, repo, planPath, scenario === 'split-plan');
  if (scenario === 'split-apply') {
    unlinkSync(join(home, '.aicommit.config.json'));
    await runCli(['split', 'apply', `--file=${planPath}`, '--yes'], { cwd: repo, home });
  }
}

async function main() {
  const scenario = process.argv[2];
  if (!SCENARIOS.has(scenario)) {
    process.stderr.write(
      'Usage: node scripts/readme-terminal-demo.mjs <commit|doctor|split-plan|split-apply>\n',
    );
    process.exitCode = 1;
    return;
  }
  rmSync(DEMO_ROOT, { recursive: true, force: true });
  const home = join(DEMO_ROOT, 'home');
  mkdirSync(home, { recursive: true });
  try {
    if (scenario === 'commit') await runCommit(home);
    else if (scenario === 'doctor') await runDoctor(home);
    else await runSplit(home, scenario);
  } finally {
    rmSync(DEMO_ROOT, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
