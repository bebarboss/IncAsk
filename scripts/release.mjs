// Release a new IncAsk version: bump the version, commit, tag, push → GitHub Actions builds the
// signed installers and publishes the Release + latest.json (.github/workflows/release.yml).
//   npm run release -- 0.2.0
// Needs a clean working tree on the branch you release from.
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const v = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(v ?? "")) {
  console.error("usage: npm run release -- <major.minor.patch>   e.g. npm run release -- 0.2.0");
  process.exit(1);
}
const sh = (cmd) => execSync(cmd, { stdio: "inherit" });
const out = (cmd) => execSync(cmd, { encoding: "utf8" }).trim();

if (out("git status --porcelain")) {
  console.error("มีไฟล์ที่ยังไม่ได้ commit — commit หรือ stash ก่อน");
  process.exit(1);
}
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const cmp = (a, b) => a.split(".").map(Number).reduce((r, x, i) => r || x - b.split(".").map(Number)[i], 0);
if (cmp(v, pkg.version) <= 0) {
  console.error(`เวอร์ชันใหม่ (${v}) ต้องมากกว่าเวอร์ชันปัจจุบัน (${pkg.version})`);
  process.exit(1);
}

pkg.version = v;
writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\n");
const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
lock.version = v;
if (lock.packages?.[""]) lock.packages[""].version = v;
writeFileSync("package-lock.json", JSON.stringify(lock, null, 2) + "\n");
const cargo = readFileSync("src-tauri/Cargo.toml", "utf8");
writeFileSync("src-tauri/Cargo.toml", cargo.replace(/^version = ".*"$/m, `version = "${v}"`));
sh("cargo update -p incask --offline --manifest-path src-tauri/Cargo.toml");

sh("git add package.json package-lock.json src-tauri/Cargo.toml src-tauri/Cargo.lock");
sh(`git commit -m "release v${v}"`);
sh(`git tag v${v}`);
sh("git push");
sh(`git push origin v${v}`);
console.log(`\nv${v} pushed — ดูความคืบหน้าที่แท็บ Actions ของ repo · เสร็จแล้วเครื่องที่ติดตั้งไว้จะเห็นอัปเดต`);
