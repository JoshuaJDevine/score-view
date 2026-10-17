// Downloads the Bitwig extension API jar (com.bitwig:extension-api:25) from Bitwig's public Maven repository into
// lib/ when it is missing. Runs on `npm install` (postinstall); build.sh and tools/check-java.mjs need it.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const JAR = path.join(ROOT, 'lib', 'extension-api-25.jar');
const URL_ = 'https://maven.bitwig.com/com/bitwig/extension-api/25/extension-api-25.jar';

if (fs.existsSync(JAR)) process.exit(0);
const res = await fetch(URL_);
if (!res.ok) { console.error(`fetch-api: ${URL_} -> HTTP ${res.status}`); process.exit(1); }
fs.mkdirSync(path.dirname(JAR), { recursive: true });
fs.writeFileSync(JAR, Buffer.from(await res.arrayBuffer()));
console.log(`fetch-api: saved ${path.relative(ROOT, JAR)}`);
