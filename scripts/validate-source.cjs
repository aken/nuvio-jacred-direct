'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const skip = new Set(['.git', 'node_modules']);
const files = [];
function collect(folder) {
  for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue;
    const full = path.join(folder, entry.name);
    if (entry.isDirectory()) collect(full);
    else if (entry.isFile()) files.push(full);
  }
}
collect(root);
let failures = 0;
for (const file of files) {
  const bytes = fs.readFileSync(file);
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] > 0x7f) {
      console.error(`Non-ASCII byte found: ${path.relative(root, file)} at offset ${i}`);
      failures++;
      break;
    }
  }
}
if (failures) process.exit(1);
console.log(`Source validation passed (${files.length} files)`);
