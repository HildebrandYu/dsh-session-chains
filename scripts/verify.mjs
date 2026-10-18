#!/usr/bin/env node
/**
 * verify.mjs — 安裝前／後的靜態驗證。
 *
 * 它**不會**證明「畫面畫得出來」（那只有人眼能證明），但它會把 DSH 宿主端
 * 決定「要不要送瀏覽器半、送哪一個檔案」的那幾條規則，用同一套演算法
 * 在我們自己的檔案上跑一遍。規則來源（本機 app.asar）：
 *   @deepseek-ai/dsh-client-modules/lib/index.js
 *     · resolveMeta()       — 讀 package.json 的 dsh.client，要求 platform === "web"
 *     · locatePkgJson()     — entry 是 file:/絕對路徑時，從該檔往上找最近的 package.json
 *     · nearestPackage()    — 逐層往上找，比對 name
 *     · clientExportOf()    — exports["./client"] 需為字串，或含字串 default 的物件
 *     · clientPath = join(dirname(pkgPath), clientRel)
 *
 * 用法：node scripts/verify.mjs
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const entry = join(root, "plugin", "index.mjs");
const home = process.env.DSH_HOME ?? join(homedir(), ".dsh");
const homePatch = join(home, "cordis.patch.yml");

let failed = 0;

/** 記一行結果。 */
function check(ok, label, extra = "") {
	console.log(`${ok ? "✓" : "✗"} ${label}${extra ? `　— ${extra}` : ""}`);
	if (!ok) failed += 1;
}

/** 模仿 nearestPackage()：從某個檔案所在目錄逐層往上找最近的 package.json。 */
function nearestPackage(filePath, expectedName) {
	let dir = dirname(filePath);
	for (;;) {
		const candidate = join(dir, "package.json");
		if (existsSync(candidate)) {
			try {
				const name = JSON.parse(readFileSync(candidate, "utf8")).name;
				if (typeof name === "string" && (expectedName === undefined || name === expectedName)) {
					return { path: candidate, packageName: name };
				}
			} catch {
				/* 壞掉的 manifest 直接跳過，與上游一致 */
			}
		}
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

console.log(`驗證標的：${root}`);
console.log(`DSH_HOME：${home}\n`);

// ── 1. 宿主 entry ─────────────────────────────────────────────────────────
check(existsSync(entry), "宿主 entry 存在", entry);

// ── 2. leastPackage 走訪（上游 locatePkgJson 對 file:/絕對路徑的行為） ────
const located = nearestPackage(entry, undefined);
check(located !== undefined, "從 entry 往上找得到最近的 package.json", located?.path ?? "找不到");

// ── 3. manifest 宣告 ──────────────────────────────────────────────────────
let pkg = null;
if (located !== undefined) {
	pkg = JSON.parse(readFileSync(located.path, "utf8"));
	const decl = pkg.dsh?.client;
	check(decl !== undefined, "package.json 有 dsh.client 宣告");
	check(decl?.platform === "web", 'dsh.client.platform === "web"', String(decl?.platform));

	const clientField = pkg.exports?.["./client"];
	const clientRel = typeof clientField === "string" ? clientField : clientField?.default;
	check(typeof clientRel === "string", 'exports["./client"] 是字串或含字串 default');

	if (typeof clientRel === "string") {
		const clientPath = join(dirname(located.path), clientRel);
		check(existsSync(clientPath), "client bundle 檔案存在", clientPath);

		// ── 4. bundle 形狀 ──────────────────────────────────────────────────
		if (existsSync(clientPath)) {
			const text = readFileSync(clientPath, "utf8");
			check(text.includes("window.__ModuleLoader__.load("), "bundle 走 window.__ModuleLoader__.load()");
			const idMatch = text.match(/id:\s*["']([^"']+)["']/);
			check(idMatch?.[1] === pkg.name, "bundle 的 id 等於 package.json 的 name", `${idMatch?.[1]} vs ${pkg.name}`);
			check(/exports\.apply\s*=/.test(text), "bundle 匯出 apply");
			check(/sidebar\.footer\.action/.test(text), "bundle 註冊到 sidebar.footer.action（底部按鈕）");
			check(/shell\.overlay/.test(text), "bundle 註冊到 shell.overlay（浮層面板）");
			const firstLine = text.split("\n")[0];
			check(!firstLine.trimStart().startsWith("import "), "bundle 不是 ESM（第一行不是 import）");
		}
	}
}

// ── 5. home 層補丁狀態 ────────────────────────────────────────────────────
const patch = existsSync(homePatch) ? readFileSync(homePatch, "utf8") : "";
const spec = `file://${entry}`;
const registered = patch.includes(spec);
check(true, "home 層補丁現況", registered ? "已註冊本插件" : "尚未註冊（等 install.mjs --apply）");
if (registered) {
	check(patch.includes("- id: session-chains"), "補丁內有 session-chains 這一列");
}

console.log("");
if (failed === 0) {
	console.log("結論：靜態檢查全部通過。剩下的只有「畫面是否真的出現」需要人眼確認。");
} else {
	console.log(`結論：有 ${failed} 項未通過，先修好再安裝。`);
	process.exit(1);
}
