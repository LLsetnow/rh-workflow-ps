const { readdirSync } = require('node:fs');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');
let failed = false;
for (const directory of ['plugin', 'static', 'tests']) {
  for (const filename of readdirSync(directory)) {
    if (!/\.(?:js|cjs)$/.test(filename)) continue;
    const path = join(directory, filename);
    const result = spawnSync(process.execPath, ['--check', path], { encoding: 'utf8' });
    if (result.status) { process.stderr.write(result.stderr); failed = true; }
  }
}
if (failed) process.exit(1);
console.log('JavaScript syntax checks passed.');
