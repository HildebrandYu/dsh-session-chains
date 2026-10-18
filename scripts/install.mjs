#!/usr/bin/env node
/**
 * install.mjs — 把 session-chains 掛進（或移出）DSH 的 home 層補丁。
 *
 * 為什麼用 home 層補丁而不是 profile：
 *   - `desktop` profile 由 Electron App 獨占管理，`dsh plugin --profile desktop`
 *     會被拒（"managed exclusively by the Electron app"）。
 *   - home 層（$DSH_HOME/cordis.patch.yml）是所有 profile 之後才套用的機器層，
 *     本機已有兩條同型先例：cross-memory 與 dshmarket-zh-tw。
 *   - 用 file:// 絕對路徑指向專案內檔案，所以不必動任何 profile 的 package.json、
 *     不必跑 pnpm，專案本體留在原本的目錄（可讀、可改）。
 *
 * 這個腳本寫兩段（都用各自的 BEGIN/END 哨兵包住，可重複執行）：
 *   1. `session-chains`：本插件那一列（含 config）。
 *   2. `session-chains-hmr`：把本專案的 `plugin/` 加進 `dsh-hmr` 的模組監看根目錄。
 *      沒有這一段，**改宿主半（index.mjs）不會生效**：DSH 的 HMR 只監看補丁檔，
 *      而 Node 的 ESM 快取以 URL 為鍵，已載入過的插件模組不會被重新 import
 *      （2026-10-16 實測：改檔、重啟補丁都沒用，路由一直 404）。
 *      加上這段之後，存檔即觸發 `partialReload()`：它會清 ESM loadCache 再重新 import。
 *
 * 安全設計（2026-10-16 獨立審查後補強）：
 *   - **預設 dry-run**，要真的寫入必須明加 `--apply`。
 *   - **原子寫入**：先寫 `<補丁>.tmp-<pid>` 再 rename，避免中斷時留下半截的開機設定。
 *   - 寫入前自動備份（.bak-YYYYmmddHHMMSS，同秒再加流水號，不覆蓋）。
 *   - **哨兵完整性**：BEGIN 有、END 沒有時直接拒絕寫入（舊版會當沒看到而追加第二列，
 *     造成重複路由、HUD 安靜地死掉）。
 *   - 移除時只切自己的兩段哨兵區塊，不動別人；寫入後再自查一次「剛好各一列」。
 *
 * 用法：
 *   node scripts/install.mjs                  # 只印會做什麼（dry-run）
 *   node scripts/install.mjs --apply          # 實際寫入 home 層補丁
 *   node scripts/install.mjs --remove --apply # 移除本插件的兩段區塊
 *   node scripts/install.mjs --diagnostic --apply
 *                                             # 另外打開診斷檔（預設關閉）
 *   node scripts/install.mjs --apply --force  # 內容未變也重寫，觸發 HMR 重新組合
 */
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const pluginDir = join(root, "plugin");
const home = process.env.DSH_HOME ?? join(homedir(), ".dsh");
const homePatch = join(home, "cordis.patch.yml");

const PLUGIN_ID = "session-chains";
const HMR_ID = "session-chains-hmr";
const ENTRY = join(pluginDir, "index.mjs");
const SPEC = `file://${ENTRY}`;
const BEGIN = `# >>> ${PLUGIN_ID} BEGIN`;
const END = `# <<< ${PLUGIN_ID} END`;
const HMR_BEGIN = `# >>> ${HMR_ID} BEGIN`;
const HMR_END = `# <<< ${HMR_ID} END`;

const argv = process.argv.slice(2);
const apply = argv.includes("--apply");
const remove = argv.includes("--remove");
const dryRun = !apply;
// 診斷檔預設關閉（維持設計「不寫檔」的承諾）；要驗「瀏覽器有沒有真的打到路由」時才開。
const diagnostic = argv.includes("--diagnostic");
const diagnosticFile = join(root, ".state", "last-hit.json");

/** 數一個字串在內容中出現幾次。 */
function countOf(text, needle) {
	return text.split(needle).length - 1;
}

const block = [
	"",
	`${BEGIN}（常駐 token／餘額 HUD；移除：node scripts/install.mjs --remove --apply）`,
	// 這一行讓每次 --apply 都產生不同內容：補丁內容相同時 DSH 不會重新組合。
	`# 掛載時間：${new Date().toISOString()}`,
	"# 瀏覽器半（client.js）沿著這個 entry 往上找 plugin/package.json 的 dsh.client，",
	"# 所以 name 必須指向 plugin/index.mjs，不是專案根目錄。",
	"# scope: all ＝ 所有工作區（建議）。改成 workspace 時**必須**一併設 workspaceSlug，",
	"# 否則宿主只知道自己的 cwd（App 的 cwd 是 profile 目錄）→ 會算不出東西。",
	"# diagnosticFile：每次路由被呼叫就覆寫這個檔（證明瀏覽器真的打到了）；平常請留空。",
	"- insert:",
	`    - id: ${PLUGIN_ID}`,
	`      name: '${SPEC}'`,
	"      config:",
	"        scope: all",
	...(diagnostic ? [`        diagnosticFile: ${diagnosticFile}`] : []),
	`${END}`,
	"",
].join("\n");

const hmrBlock = [
	"",
	`${HMR_BEGIN}（讓 dsh-hmr 監看本專案的 plugin/；移除本插件時會一併移除）`,
	"# 沒有這一段，改宿主半（plugin/index.mjs）不會生效：DSH 的 HMR 預設 root 是空的，",
	"# 只監看補丁檔；而 Node 的 ESM 快取以 URL 為鍵，不會重新 import 已載入的模組。",
	"# 這一段只覆寫 root，其餘（ignored／debounce）由 dsh-hmr 自己的 schema 補預設值。",
	"- id: hmr",
	"  name: '@deepseek-ai/dsh-hmr'",
	"  config:",
	"    root:",
	`      - ${pluginDir}`,
	`${HMR_END}`,
	"",
].join("\n");

/** 印一行。 */
function log(line) {
	console.log(line);
}

/**
 * 從內容中切掉某個哨兵區塊；找不到就回傳原字串。
 * @param text - 補丁全文
 * @param begin - 起始哨兵
 * @param end - 結束哨兵
 * @returns 切掉後的全文
 * @throws 只有 BEGIN 沒有 END 時（哨兵壞掉，硬寫下去會變成重複的一列）
 */
function stripBlock(text, begin, end) {
	const from = text.indexOf(begin);
	if (from < 0) return text;
	const to = text.indexOf(end, from);
	if (to < 0) throw new Error(`哨兵不完整：找到「${begin}」但找不到對應的「${end}」`);
	return `${text.slice(0, from)}${text.slice(to + end.length)}`;
}

// ── 前置檢查 ──────────────────────────────────────────────────────────────
const problems = [];
if (!existsSync(ENTRY)) problems.push(`缺少 ${ENTRY}`);
if (!existsSync(join(pluginDir, "client.js"))) problems.push(`缺少 ${join(pluginDir, "client.js")}`);
if (!existsSync(home)) problems.push(`找不到 DSH_HOME（${home}）`);
if (problems.length > 0) {
	console.error("✗ 前置檢查失敗：");
	for (const problem of problems) console.error(`  - ${problem}`);
	process.exit(1);
}

log(`DSH_HOME　：${home}`);
log(`補丁檔　　：${homePatch}`);
log(`外掛 entry：${SPEC}`);
log(`HMR root　：${pluginDir}`);
log(`模式　　　：${dryRun ? "dry-run（不寫入；要寫入請加 --apply）" : "實際寫入"}${remove ? "＋移除" : ""}`);
log(`診斷檔　　：${diagnostic ? diagnosticFile : "關閉（要開請加 --diagnostic）"}`);
log("");

const before = existsSync(homePatch) ? readFileSync(homePatch, "utf8") : "";
const hadBlock = before.includes(BEGIN) || before.includes(HMR_BEGIN);
let after = before;

try {
	if (remove) {
		if (!hadBlock) {
			log("- 補丁檔沒有本插件的區塊，無事可做。");
			process.exit(0);
		}
		after = stripBlock(stripBlock(before, BEGIN, END), HMR_BEGIN, HMR_END)
			.replace(/\n{3,}/g, "\n\n")
			.replace(/\n*$/, "\n");
	} else {
		if (hadBlock) {
			log("- 補丁檔已有本插件的區塊 → 先切掉舊的再加新的（更新路徑／config）。");
			after = stripBlock(stripBlock(before, BEGIN, END), HMR_BEGIN, HMR_END);
		}
		after = `${after.replace(/\n*$/, "\n")}${block}${hmrBlock}`;
	}
} catch (error) {
	console.error(`✗ ${error.message}`);
	console.error("  補丁檔一字未動。請人工檢查哨兵註解（BEGIN／END 必須成對）。");
	process.exit(1);
}

// 寫入前自查（只適用於掛載；移除時這些字串本來就該是 0 次）：
// 自己的兩段各自剛好一組，且 session-chains 只有一列。
// **不可以**在全檔數 `- id: hmr`：別的插件（例如 token-hud）也會插自己的 hmr 區塊，
// 全檔就會有 2 個以上（2026-10-16 實測：本 spike 第一次掛載就撞到這個自查）。
// 改成驗「我們自己那一段 hmr 區塊」在檔案裡剛好出現一次。
const sanity = remove ? [] : [
	["# >>> session-chains BEGIN", 1],
	["# <<< session-chains END", 1],
	["# >>> session-chains-hmr BEGIN", 1],
	["# <<< session-chains-hmr END", 1],
	["- id: session-chains\n", 1],
	[hmrBlock, 1],
];
for (const [needle, expected] of sanity) {
	const actual = countOf(after, needle);
	if (actual !== expected) {
		console.error(`✗ 自查失敗：\`${needle}\` 應該出現 ${expected} 次，實際 ${actual} 次。`);
		process.exit(1);
	}
}

if (after === before) {
	if (!(apply && argv.includes("--force"))) {
		log("沒有任何變更。");
		log("（要強制重寫以觸發 HMR，請加 --force：node scripts/install.mjs [--diagnostic] --apply --force）");
		process.exit(0);
	}
	// --force：內容沒變也重寫一次，只為了讓 chokidar 收到 change 事件 → DSH 重新組合。
	log("補丁內容未變，--force：重寫同內容以觸發 HMR 重新組合。");
}

log(dryRun ? "【將寫入的內容 diff 摘要】" : "【寫入】");
log(`  本插件區塊行數：${block.split("\n").length}`);
log(`  HMR 區塊行數　：${hmrBlock.split("\n").length}`);
log(`  結果總行數：${before.split("\n").length} -> ${after.split("\n").length}`);

if (dryRun) {
	// dry-run 仍把「組合後的結果」寫進工作區內的預覽檔，方便先驗 YAML 是否合法。
	const previewDir = join(root, ".preview");
	mkdirSync(previewDir, { recursive: true });
	const preview = join(previewDir, "cordis.patch.yml");
	writeFileSync(preview, after);
	log(`\n預覽已寫入：${preview}`);
	log("（dry-run：沒有動到 DSH_HOME 底下的任何檔案。）");
	process.exit(0);
}

const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
if (existsSync(homePatch)) {
	// 時間戳只到秒，同一秒連跑兩次會撞名 → 撞到就加流水號，不覆蓋既有備份。
	let bak = `${homePatch}.bak-${stamp}`;
	for (let suffix = 2; existsSync(bak); suffix += 1) bak = `${homePatch}.bak-${stamp}-${suffix}`;
	try {
		cpSync(homePatch, bak);
	} catch (error) {
		// 備份失敗（例如權限不足）就**不要動正式檔**，並把原因說清楚（不要丟一整段堆疊）。
		console.error(`✗ 備份失敗，補丁檔一字未動：${error.message}`);
		process.exit(1);
	}
	log(`✓ 已備份 ${homePatch} -> ${bak}`);
}
// 原子寫入：先寫暫存檔再 rename。這支檔案是 DSH 的開機設定，半截的內容會讓它起不來。
const temporary = `${homePatch}.tmp-${process.pid}`;
try {
	writeFileSync(temporary, after);
	renameSync(temporary, homePatch);
} catch (error) {
	try {
		rmSync(temporary, { force: true });
	} catch {
		// 暫存檔清不掉就算了，重點是不要把半截內容留在正式路徑。
	}
	console.error(`✗ 寫入失敗：${error.message}`);
	process.exit(1);
}
log(`✓ 已寫入 ${homePatch}（原子寫入）`);
log("");
log("下一步：");
log("  1. 等 DSH 偵測補丁變更並重新組合（實測約數秒）；沒跟上就重新整理頁面（Cmd+R）。");
log("  2. 看輸入框下方那條是否出現 HUD 行（驗證：cat .state/last-hit.json）。");
log("  3. 移除：node scripts/install.mjs --remove --apply");
