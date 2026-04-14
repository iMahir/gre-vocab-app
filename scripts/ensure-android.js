/* eslint-disable no-console */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function readJson(jsonPath) {
  return JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
}

function commandFor(bin) {
  // Prefer shell resolution on Windows (more robust across Node versions).
  if (process.platform === 'win32') return bin;
  return bin;
}

function run(command, args, options) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    ...options,
  });
  if (result.error) {
    throw result.error;
  }
  if (typeof result.status === 'number' && result.status !== 0) {
    throw new Error(`${command} exited with code ${result.status}`);
  }
}

function parseReactNativeVersion(pkgJson) {
  const rnVersion =
    (pkgJson.dependencies && pkgJson.dependencies['react-native']) ||
    (pkgJson.devDependencies && pkgJson.devDependencies['react-native']);
  const match = String(rnVersion || '').match(/\d+\.\d+\.\d+/);
  if (!match) {
    throw new Error(
      `Unable to parse react-native version from package.json (value: ${JSON.stringify(rnVersion)})`
    );
  }
  return match[0];
}

function main() {
  const repoRoot = path.resolve(__dirname, '..');
  const androidPath = path.join(repoRoot, 'android');

  if (fs.existsSync(androidPath)) {
    console.log('✅ android/ already exists; nothing to do.');
    return;
  }

  const pkgJson = readJson(path.join(repoRoot, 'package.json'));
  const appJsonPath = path.join(repoRoot, 'app.json');
  const appJson = fs.existsSync(appJsonPath) ? readJson(appJsonPath) : null;

  const appName = String(appJson?.name || 'main');
  const rnVersion = parseReactNativeVersion(pkgJson);
  const packageName = 'com.imahir.grevocabapp';

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gre-vocab-native-'));

  try {
    console.log(`Generating Android native project (rn=${rnVersion}, name=${appName})...`);
    run(commandFor('npx'), [
      '@react-native-community/cli',
      'init',
      appName,
      '--version',
      rnVersion,
      '--directory',
      tmpDir,
      '--package-name',
      packageName,
      '--skip-install',
      '--skip-git-init',
    ]);

    const generatedAndroid = path.join(tmpDir, 'android');
    if (!fs.existsSync(generatedAndroid)) {
      throw new Error(`Expected generated android folder not found at: ${generatedAndroid}`);
    }

    fs.cpSync(generatedAndroid, androidPath, { recursive: true });
    console.log('✅ Generated android/ successfully.');
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore temp cleanup failures
    }
  }
}

main();
