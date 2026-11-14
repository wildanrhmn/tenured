// Copies the committed mainnet snapshot and report into public/data so the
// dev server and the build can serve them. The copies are gitignored.

import { copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");
const out = path.resolve(import.meta.dirname, "../public/data");
mkdirSync(out, { recursive: true });
for (const f of ["snapshot.json.gz", "report.json"]) {
  copyFileSync(path.join(root, "data/mainnet", f), path.join(out, f));
}
console.log(`copied snapshot and report to ${path.relative(process.cwd(), out)}`);
