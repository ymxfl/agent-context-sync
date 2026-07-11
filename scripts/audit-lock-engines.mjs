import { readFile } from 'node:fs/promises';
import { satisfies, validRange } from 'semver';

const targetNode = '20.0.0';
const lock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'));
const incompatible = [];
let requiredCount = 0;
let optionalCount = 0;

for (const [path, metadata] of Object.entries(lock.packages)) {
  if (metadata.optional === true) {
    optionalCount += 1;
    continue;
  }

  requiredCount += 1;
  const range = metadata.engines?.node;
  if (range !== undefined && (validRange(range) === null || !satisfies(targetNode, range))) {
    incompatible.push({ path: path || '.', range, version: metadata.version ?? lock.version });
  }
}

if (incompatible.length > 0) {
  for (const entry of incompatible) {
    console.error(`${entry.path}@${entry.version} requires Node ${entry.range}`);
  }
  process.exitCode = 1;
} else {
  console.log(
    `Lock engine audit passed: ${requiredCount} required packages accept Node ${targetNode} `
      + `(${optionalCount} optional packages skipped).`,
  );
}
