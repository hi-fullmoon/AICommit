import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TEMPLATE_PATH = join(PROJECT_ROOT, 'Formula', 'aicommit.rb.template');
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const SHA256 = /^[a-f0-9]{64}$/;
const FORMULA_CLASS = /^[A-Z][A-Za-z0-9]*$/;

async function regularFile(path, label) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a regular non-symlink file: ${path}`);
  }
  return stat;
}

async function digest(path) {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
}

function rubyString(value) {
  return JSON.stringify(value).replaceAll('#{', '\\#{');
}

export async function renderHomebrewFormula({ version, sha256, url, formulaClass = 'Aicommit' }) {
  if (!SEMVER.test(version || '')) throw new Error('Formula version must be semantic.');
  if (!SHA256.test(sha256 || '')) throw new Error('Formula sha256 must be 64 lowercase hex.');
  if (!FORMULA_CLASS.test(formulaClass || '')) throw new Error('Invalid Homebrew formula class.');
  const parsedUrl = new URL(url);
  if (!['https:', 'file:'].includes(parsedUrl.protocol)) {
    throw new Error('Formula URL must use HTTPS or a local file URL for smoke tests.');
  }
  const template = await readFile(TEMPLATE_PATH, 'utf8');
  const rendered = template
    .replaceAll('__FORMULA_CLASS__', formulaClass)
    .replaceAll('__URL_LITERAL__', rubyString(url))
    .replaceAll('__VERSION__', version)
    .replaceAll('__SHA256__', sha256);
  if (/__[A-Z_]+__/.test(rendered)) throw new Error('Formula template has unresolved fields.');
  return rendered;
}

export async function prepareReleaseAssets({
  tarballPath,
  outputDirectory = dirname(tarballPath),
  sbomPath = null,
  formulaUrl = null,
  formulaName = 'aicommit.rb',
  formulaClass = 'Aicommit',
}) {
  const manifest = JSON.parse(await readFile(join(PROJECT_ROOT, 'package.json'), 'utf8'));
  if (!SEMVER.test(manifest.version || '')) throw new Error('package.json has an invalid version.');
  const tarball = resolve(tarballPath);
  await regularFile(tarball, 'npm tarball');
  const expectedName = `aicommit-${manifest.version}.tgz`;
  if (basename(tarball) !== expectedName) {
    throw new Error(`Expected npm tarball ${expectedName}, got ${basename(tarball)}.`);
  }
  if (!/^[a-z0-9-]+\.rb$/.test(formulaName) || !FORMULA_CLASS.test(formulaClass)) {
    throw new Error('Invalid Homebrew formula output name or class.');
  }
  const output = resolve(outputDirectory);
  await mkdir(output, { recursive: true });
  const packagedTarball = join(output, expectedName);
  if (packagedTarball !== tarball) await copyFile(tarball, packagedTarball);
  const tarballSha256 = await digest(packagedTarball);
  const registryUrl = `https://registry.npmjs.org/aicommit/-/${expectedName}`;
  const formula = await renderHomebrewFormula({
    version: manifest.version,
    sha256: tarballSha256,
    url: formulaUrl || registryUrl,
    formulaClass,
  });
  const formulaPath = join(output, formulaName);
  await writeFile(formulaPath, formula, 'utf8');

  const assets = [packagedTarball, formulaPath];
  if (sbomPath) {
    const sbom = resolve(sbomPath);
    await regularFile(sbom, 'SBOM');
    const packagedSbom = join(output, basename(sbom));
    if (packagedSbom !== sbom) await copyFile(sbom, packagedSbom);
    assets.push(packagedSbom);
  }
  const checksums = [];
  for (const asset of assets) checksums.push(`${await digest(asset)}  ${basename(asset)}`);
  const checksumsPath = join(output, 'SHA256SUMS');
  await writeFile(checksumsPath, `${checksums.sort().join('\n')}\n`, 'utf8');
  return {
    version: manifest.version,
    tarballPath: packagedTarball,
    tarballSha256,
    formulaPath,
    checksumsPath,
    formulaUrl: formulaUrl || registryUrl,
    assets,
  };
}

function option(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return null;
  if (!args[index + 1]) throw new Error(`${name} requires a value.`);
  return args[index + 1];
}

async function main() {
  const args = process.argv.slice(2);
  const tarballPath = option(args, '--tarball');
  if (!tarballPath) throw new Error('Usage: release-assets.mjs --tarball <path> [--sbom <path>]');
  const result = await prepareReleaseAssets({
    tarballPath,
    sbomPath: option(args, '--sbom'),
    outputDirectory: option(args, '--output') || dirname(resolve(tarballPath)),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
