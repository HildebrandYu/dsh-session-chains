#!/usr/bin/env node
/**
 * probe.mjs — 對「正在跑的 DSH」查證：我們的 client bundle 是否已被組進 boot graph。
 *
 * 這是**不需要人眼**的端到端驗證，用兩個獨立來源交叉確認。
 *
 * ── 來源 A（主要）：HMR 事件流裡的 boot graph
 *   `@deepseek-ai/dsh-client-hmr` 把 HMR 事件流掛在 `/plugins/events`（SSE），
 *   而且**不受 cookie 認證保護**（實測無 cookie 可得 200）。它會推送完整的圖：
 *     data: {"type":"graph","graph":{"rev":"…","entries":[{"id":"…","url":"plugins/??…","rev":"…"}]}}
 *   這一串就是宿主實際上餵給頁面的清單（`bootInjections(this.composed)`）。
 *   **id 出現在裡面 ⇒ 補丁被吃到、manifest 解析成功、bundle 已被廣告給頁面。**
 *
 * ── 來源 B（交叉確認）：抓那個 bundle
 *   用圖裡給的 url 直接抓回來，確認它是我們的檔案（不是別的列）。
 *   若 SSE 不通，退回到自己算 rev：
 *     rev = sha1("plugin-artifact" + "\0" + `${byteLen(mtimeMs)}:${mtimeMs}` + …).slice(0,12)
 *   （演算法同上游 `artifactRevision`；`bundleResource` 是拿 pathname+search 精確比對，
 *     所以 URL 有 200 ⇒ 這一列真的在組合表裡。）
 *
 * 用法：
 *   node scripts/probe.mjs                 # 預設 127.0.0.1:19387
 *   DSH_WEB_URL=http://127.0.0.1:1234 node scripts/probe.mjs
 */
import { statSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const clientPath = join(root, "plugin", "client.js");
const pkg = JSON.parse((await import("node:fs")).readFileSync(join(root, "plugin", "package.json"), "utf8"));
const id = pkg.name;

const base = (process.env.DSH_WEB_URL ?? "http://127.0.0.1:19387").replace(/\/$/, "");
const GRAPH_TIMEOUT_MS = 8000;

/** 與上游 framedHash 完全相同：sha1(domain \0 (byteLen(part):part)*) 取前 12 hex。 */
function framedHash(domain, parts) {
	const hash = createHash("sha1").update(domain).update("\0");
	for (const part of parts) hash.update(`${String(Buffer.byteLength(part))}:`).update(part);
	return hash.digest("hex").slice(0, 12);
}

/** 與上游 artifactRevision 完全相同。 */
function artifactRevision(baseline) {
	return framedHash("plugin-artifact", [String(baseline.mtimeMs), String(baseline.ctimeMs), String(baseline.size)]);
}

/**
 * 從 HMR SSE 讀到第一個 graph 事件。
 * @returns {{rev: string, entry: object|undefined, count: number}|undefined}
 */
async function readLiveGraph() {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), GRAPH_TIMEOUT_MS);
	try {
		const response = await fetch(`${base}/plugins/events`, { signal: controller.signal });
		if (!response.ok || response.body === null) return undefined;
		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			let index;
			while ((index = buffer.indexOf("\n")) >= 0) {
				const line = buffer.slice(0, index).trim();
				buffer = buffer.slice(index + 1);
				if (!line.startsWith("data: ")) continue;
				let event;
				try {
					event = JSON.parse(line.slice(6));
				} catch {
					continue;
				}
				if (event.type !== "graph" || event.graph === undefined) continue;
				const entries = event.graph.entries ?? [];
				return {
					rev: event.graph.rev,
					entry: entries.find((candidate) => candidate?.id === id),
					count: entries.length,
				};
			}
		}
		return undefined;
	} catch {
		return undefined;
	} finally {
		clearTimeout(timer);
		controller.abort();
	}
}

const markers = [
	["載入器包裝", "window.__ModuleLoader__.load("],
	["bundle id 一致", `id: "${id}"`],
	["註冊到底部按鈕插槽", "sidebar.footer.action"],
	["註冊到浮層插槽", "shell.overlay"],
	["匯出 apply", "exports.apply"],
	// 路徑不加開頭斜線（頁面 origin 是 dsh-app://app，寫死會解析成別的位址而靜默失效）。
	["URL 走 transport 規則", 'new URL("local/session-chains", base)'],
	// 點一列要能切換對話：內建插件用的是同一個 API。
	["用 uiWorkspace.openSession 切換對話", "uiWorkspace"],
	// 改名入口：供應的 bundle 必須帶改名端點（走同一套 transport URL 規則）。
	["帶改名端點（session-chains.rename）", "local/session-chains.rename"],
	// 歸鏈入口（未標記的舊對話用）：同一套規則。
	["帶歸鏈端點（session-chains.assign）", "local/session-chains.assign"],
	// 鏈的起點（自己產出提示詞的那一場）要有標記，否則中繼場看起來像重複的一列。
	["標出鏈的起點", "session.handoffTo === chain.chain"],
	// 「你在這裡」：兩個來源都要在 bundle 裡（DOM 是主、uiWorkspace 服務是備援）。
	["目前這一場：讀側邊欄 DOM", 'data-row-key^="session:"'],
	["目前這一場：備援讀 uiWorkspace", "selection?.getSnapshot?.()"],
	["目前這一場：亮底與字標", ["data-current-row", "你在這裡"]],
	["標題列說出你在哪條鏈", "data-current-hint"],
	// 中繼場（同時在兩條鏈）：要說出「也在哪裡」並給一鍵收斂。
	["中繼場：說出也在哪條鏈＋只留在這條", ["data-multi-chain", "data-pin-button"]],
	// 側邊欄卡片（2026-10-18）：收合列 ＋ 逐鏈摺疊 ＋ 編號徽章。
	["側邊欄卡片：收合列", ["data-session-chains-card", "data-card-strip"]],
	["側邊欄卡片：逐鏈摺疊", "data-chain-row"],
	["側邊欄卡片：場次編號徽章", "data-card-number"],
	// 2026-10-18：卡片上就地改名（使用者回報「變更主題只能再進去下一層」）。
	["側邊欄卡片：就地改名", ["data-card-chain-rename", "data-card-chain-input"]],
	// 2026-10-18：上方「工作區／會話」區塊可折疊（加了卡片之後它太佔空間）。
	["上方工作區：那一列的上下箭頭", ["data-sc-ws-toggle", "data-sc-ws-fold", "sectionHeader"]],
	// 2026-10-18：交接強制提醒（超過 CLAUDE.md 13.5 門檻就壓一條橫幅，不是只有右下角變色）。
	["交接強制提醒", ["data-handoff-guard", "conversation.composer.dock", "CLAUDE.md 13.6", "handoffAnchor"]],
	// 2026-10-18：可調設定＋第一次接入的「整理舊對話」建議（要打包出去，這兩塊必須在 bundle 裡）。
	["設定與首次整理", ["data-sc-settings", "data-sc-suggest", "readSettings"]],
	// 2026-10-18：原本獨立外掛的 HUD 已併入（餘額／今日／本週／本月／本場）。
	["常駐 HUD（併入）", ["data-token-hud", "session-chains.usage", "formatBalance"]],
	// 自動編號：套用邏輯與回報端點都要在 bundle 裡。
	["自動編號：套用與回報", ["applyNumberingPlan", "session-chains.titles"]],
];

console.log(`插件 id ：${id}`);
console.log(`bundle  ：${clientPath}`);
console.log(`端點    ：${base}`);
console.log("");

let url;
const graph = await readLiveGraph();

if (graph !== undefined) {
	console.log(`[A] HMR boot graph：rev ${graph.rev}，共 ${graph.count} 條`);
	if (graph.entry === undefined) {
		console.log(`✗ 圖裡**沒有** ${id} 這一列。`);
		console.log("  → 補丁可能還沒被 HMR 吃到，或 entry 路徑不符合 locatePkgJson 規則。");
		console.log("    先跑 node scripts/verify.mjs，再看「設定 → 插件 → 插件清單」有沒有同步失敗。");
		process.exit(1);
	}
	console.log(`✓ 圖裡有 ${id}`);
	console.log(`  url：${graph.entry.url}`);
	console.log(`  rev：${graph.entry.rev}`);
	url = new URL(graph.entry.url.replace(/^\/?/, "/"), `${base}/`).href;
} else {
	console.log("[A] HMR boot graph：讀不到（SSE 不通或逾時）→ 退回用 metadata 自算 rev");
	const baseline = statSync(clientPath);
	const rev = artifactRevision(baseline);
	url = `${base}/plugins/??${id}/client.js&rev=${rev}`;
	console.log(`    自算 rev：${rev}`);
}

console.log("");
console.log(`[B] 抓 bundle：${url}`);
let response;
try {
	response = await fetch(url);
} catch (error) {
	console.error(`✗ 連不上 —— ${error.message}`);
	process.exit(2);
}
const body = await response.text();
console.log(`    HTTP ${response.status}　${body.length} bytes`);
if (response.status !== 200) {
	console.log("✗ 宿主沒有供應這個 bundle。");
	process.exit(1);
}

let bad = 0;
for (const [label, needle] of markers) {
	// needle 允許是陣列＝每個子字串都必須出現（用來一次驗一整組相關事實）。
	const ok = Array.isArray(needle) ? needle.every((part) => body.includes(part)) : body.includes(needle);
	if (!ok) bad += 1;
	console.log(`    ${ok ? "✓" : "✗"} ${label}`);
}

console.log("");
if (bad === 0) {
	console.log("結論：宿主已把本插件的瀏覽器半組進 boot graph 並供應給頁面。");
	console.log("剩下的只有「瀏覽器有沒有把它畫出來」——那需要人眼或 DevTools。");
} else {
	console.log(`結論：有 ${bad} 個標記對不上，供應的內容可能不是我們預期的檔案。`);
	process.exit(1);
}
