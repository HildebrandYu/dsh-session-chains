/**
 * rename.test.mjs — 「鏈代號改名」的自動測試（TDD 的那一半）。
 *
 * 使用者的需求：面板上的鏈標籤要能用滑鼠點一下改名（例：`40-MediaProduction` → `模擬聲音工程`），
 * 而且**改完之後仍然抓得到**（既有對話、既有文件都用舊代號）。
 * 兩條硬性條件因此被固定下來：
 *   1. `鏈=` 這個標記要**吃中文代號**（原本只吃英數 → 中文代號會完全抓不到）。
 *   2. 改名是「舊代號 → 新名稱」的**對照表**，不是把舊資料改寫；分組時把舊代號映射到新名稱。
 *
 * 用法：node --test scripts/rename.test.mjs
 */
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import assert from "node:assert/strict";
import test from "node:test";

import { extractChain, extractOutChain, groupByChain } from "../plugin/chains.mjs";
import { applyAliases, applyAssignments, canonicalOf, loadStore, normalizeName, renderRegistry, saveStore, toggleInList, updateAliases } from "../plugin/aliases.mjs";
import { createAssignHandler, createFlagHandler, createHandler, createNextPromptHandler, createRenameHandler, createTitlesHandler } from "../plugin/index.mjs";

/** 造一則使用者訊息事件。 */
function userEvent(text, time = 0) {
	return { type: "user/message", time, data: { content: [{ type: "text", text }] } };
}

/** 造一則助理訊息事件（回答本文）。 */
function assistantEvent(text, time = 0) {
	return { type: "assistant/message", time, data: { content: [{ type: "text", text }] } };
}

/** 把事件陣列寫成 session log。 */
function writeSessionLog(root, slug, sessionId, events) {
	const dir = join(root, slug, sessionId);
	mkdirSync(dir, { recursive: true });
	const jsonl = `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
	writeFileSync(join(dir, "session.v1.jsonl.zstd"), zstdCompressSync(Buffer.from(jsonl, "utf8")));
}

/** 假 req：GET 沒有 body；POST 用非同步迭代器餵 body（真 IncomingMessage 也是這樣讀）。 */
function fakeReq({ method = "GET", headers = {}, body = "" } = {}) {
	return {
		method,
		headers,
		async *[Symbol.asyncIterator]() {
			if (body !== "") yield Buffer.from(body, "utf8");
		},
	};
}

/** 假 res：收 statusCode／標頭／body。 */
function fakeRes() {
	return {
		headers: {},
		statusCode: 0,
		body: "",
		ended: false,
		setHeader(name, value) {
			this.headers[String(name).toLowerCase()] = value;
		},
		end(chunk) {
			if (chunk !== undefined && chunk !== null) this.body += String(chunk);
			this.ended = true;
		},
	};
}

// ── 條件 1：中文代號抓得到 ────────────────────────────────────────────────

test("鏈= 吃中文代號（改名前只吃英數，中文會完全抓不到）", () => {
	assert.deepEqual(extractChain("先讀這幾個檔\n模擬聲音工程\n鏈=模擬聲音工程\n"), {
		chain: "模擬聲音工程",
		reason: "tag",
	});
	assert.equal(extractChain("鏈=模擬聲音工程　← 這一行是給面板分組用").chain, "模擬聲音工程");
	assert.equal(extractChain("接續 模擬聲音工程（/work/my-project/40-MediaProduction）。").chain, "模擬聲音工程");
	assert.equal(
		extractOutChain([assistantEvent("【接續提示詞】\n---\n鏈=模擬聲音工程\n先讀 40-MediaProduction/README.md")]).chain,
		"模擬聲音工程",
	);
	// 行內的順口提及仍然不算（既有護欄不能被放寬破壞）。
	assert.equal(extractChain("我在想 鏈=模擬聲音工程 這個代號好不好").chain, null);
});

// ── 條件 2：改名＝對照表，不是改寫舊資料 ──────────────────────────────────

test("normalizeName：空白／空字串／`=`／換行／過長一律不接受", () => {
	assert.equal(normalizeName("  模擬聲音工程  "), "模擬聲音工程");
	assert.equal(normalizeName("dsh-token-hud"), "dsh-token-hud");
	assert.equal(normalizeName(""), null);
	assert.equal(normalizeName("   "), null);
	assert.equal(normalizeName("a=b"), null);
	assert.equal(normalizeName("a\nb"), null);
	assert.equal(normalizeName("x".repeat(61)), null);
	assert.equal(normalizeName(undefined), null);
});

test("updateAliases：舊代號指向新名稱，而且不會留下兩段跳", () => {
	const first = updateAliases({}, "40-MediaProduction", "模擬聲音工程");
	assert.equal(canonicalOf("40-MediaProduction", first), "模擬聲音工程");
	assert.equal(canonicalOf("模擬聲音工程", first), "模擬聲音工程");

	// A→B，之後 B→C：A 必須直接指向 C，否則會變成兩段跳。
	const second = updateAliases(first, "模擬聲音工程", "聲音工程");
	assert.equal(canonicalOf("40-MediaProduction", second), "聲音工程");
	assert.equal(canonicalOf("模擬聲音工程", second), "聲音工程");
	assert.equal(second["模擬聲音工程"], "聲音工程");
});

test("兩條不同的鏈改成同一個名字 → 併成一條（使用者問的「互相關聯」）", () => {
	const aliases = updateAliases(updateAliases({}, "alpha", "同名"), "beta", "同名");
	const sessions = [
		{ id: "s1", chain: "alpha", chains: ["alpha"] },
		{ id: "s2", chain: "beta", chains: ["beta"] },
	];
	const mapped = applyAliases(sessions, aliases);
	assert.deepEqual(mapped.map((session) => session.chain), ["同名", "同名"]);
	const groups = groupByChain(mapped);
	assert.equal(groups.length, 1, "兩條鏈必須合成一組");
	assert.deepEqual(groups[0].sessionIds, ["s1", "s2"]);
});

test("applyAliases：把舊代號映射成新名稱，並保留原代號供 tooltip 用", () => {
	const sessions = [{ id: "a", chain: "40-MediaProduction", chains: ["40-MediaProduction"], chainReason: "handoff-out" }];
	const [mapped] = applyAliases(sessions, { "40-MediaProduction": "模擬聲音工程" });
	assert.equal(mapped.chain, "模擬聲音工程");
	assert.deepEqual(mapped.chains, ["模擬聲音工程"]);
	assert.deepEqual(mapped.chainsRaw, ["40-MediaProduction"], "原代號要留著，面板才顯示得出「舊代號」");
});

test("renderRegistry：對照表是可讀的 markdown（人看＋AI 依它寫提示詞）", () => {
	const markdown = renderRegistry({ "40-MediaProduction": "模擬聲音工程" }, [{ chain: "模擬聲音工程", count: 2 }], 1_700_000_000_000);
	assert.match(markdown, /模擬聲音工程/u);
	assert.match(markdown, /40-MediaProduction/u);
	assert.match(markdown, /2 場/u);
});

test("renderRegistry：列出**所有**鏈（含從沒改過名的）—— 13.6 說代號以這份為準，查不到就等於沒答案", () => {
	const markdown = renderRegistry(
		{ "40-MediaProduction": "模擬聲音工程", "交接練": "交接鏈", "dsh-session-chains": "交接鏈" },
		[
			{ chain: "模擬聲音工程", count: 4 },
			{ chain: "交接鏈", count: 3 },
			{ chain: "翻譯介面", count: 1 },
			{ chain: null, count: 36 },
		],
		1_700_000_000_000,
	);
	const rows = markdown.split("\n").filter((line) => line.startsWith("|"));
	// 表頭 1 ＋ 分隔線 1 ＋ 三條鏈 3
	assert.equal(rows.length, 5, `列數應為 5，實際 ${rows.length}：\n${markdown}`);
	assert.equal(rows.filter((line) => line.includes("交接鏈")).length, 1, "同一條鏈的兩個舊代號只能佔一列（舊版會印兩列）");
	const chainRow = rows.find((line) => line.includes("交接鏈") && line.includes("|"));
	assert.match(chainRow, /交接練/u);
	assert.match(chainRow, /dsh-session-chains/u);
	assert.match(chainRow, /3 場/u, "場次要取目前分組，不是改名當時的數字");
	const never = rows.find((line) => line.includes("翻譯介面"));
	assert.ok(never !== undefined, "從沒改過名的鏈也要出現");
	assert.match(never, /—/u, "沒改過名：舊代號欄是 —");
	assert.match(never, /1 場/u);
	assert.ok(!markdown.includes("未標記"), "未標記那一組（chain=null）不是一條鏈，不進表");
});

test("renderRegistry：場次數即時（改名前後都跟著分組走，不會停在改名那一刻）", () => {
	const chainsNow = [{ chain: "交接鏈", count: 3 }];
	const first = renderRegistry({ "交接練": "交接鏈" }, chainsNow, 1, {});
	assert.match(first, /3 場/u);
	const later = renderRegistry({ "交接練": "交接鏈" }, [{ chain: "交接鏈", count: 5 }], 2, {});
	assert.match(later, /5 場/u, "同一份對照表、後來的分組 → 場次要跟著變");
});

// ── 路由：GET 看得到、POST 改得動 ─────────────────────────────────────────

/** 造一個只有兩場對話、且都用舊代號的 sessions 目錄。 */
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "rename-"));
	const slug = "--tmp-workspace--";
	writeSessionLog(root, slug, "session-head", [
		userEvent("幫我做聲音工程", 1_000),
		assistantEvent("【接續提示詞】\n---\n鏈=40-MediaProduction\n先讀 40-MediaProduction/README.md", 2_000),
	]);
	writeSessionLog(root, slug, "session-next", [userEvent("【接續提示詞】\n鏈=40-MediaProduction\n先讀 40-MediaProduction/README.md", 3_000)]);
	const work = mkdtempSync(join(tmpdir(), "rename-work-"));
	return {
		sessionsRoot: root,
		workspaceSlug: slug,
		aliasesFile: join(work, ".state", "aliases.json"),
		registryFile: join(work, "鏈代號.md"),
		work,
	};
}

test("GET：套用對照表後，兩場舊代號的對話合成一條新名稱的鏈", async () => {
	const paths = fixture();
	const handler = createHandler({ sessionsRoot: paths.sessionsRoot, workspaceSlug: paths.workspaceSlug, ...paths });
	const res = fakeRes();
	handler(fakeReq({ method: "GET" }), res);
	assert.equal(res.statusCode, 200);
	const payload = JSON.parse(res.body);
	assert.equal(payload.chains.length, 1);
	assert.equal(payload.chains[0].chain, "40-MediaProduction", "還沒改名：原代號");

	// 改名（走真正的 POST 路由，跟面板同一條路）
	const renamed = await rename(paths, "40-MediaProduction", "模擬聲音工程");
	assert.equal(renamed.statusCode, 200);

	const after = fakeRes();
	handler(fakeReq({ method: "GET" }), after);
	const result = JSON.parse(after.body);
	assert.equal(result.chains.length, 1);
	assert.equal(result.chains[0].chain, "模擬聲音工程");
	assert.equal(result.chains[0].count, 2, "舊代號的兩場必須跟著進新名稱那一組");
	assert.deepEqual(result.chains[0].sessions[0].chainsRaw, ["40-MediaProduction"]);
});

/** 呼叫 POST 改名路由（handler 是 async：await 就會等 body 讀完、檔案寫完）。 */
async function rename(paths, from, to) {
	const handler = createRenameHandler({ sessionsRoot: paths.sessionsRoot, workspaceSlug: paths.workspaceSlug, ...paths });
	const res = fakeRes();
	await handler(fakeReq({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ from, to }) }), res);
	return res;
}

test("POST 改名：寫入對照表與 鏈代號.md，並擋掉壞輸入", async () => {
	const paths = fixture();
	const response = await rename(paths, "40-MediaProduction", "模擬聲音工程");
	assert.equal(response.statusCode, 200);
	assert.equal(JSON.parse(response.body).ok, true);
	assert.ok(existsSync(paths.aliasesFile), "對照表要落地");
	assert.equal(JSON.parse(readFileSync(paths.aliasesFile, "utf8")).aliases["40-MediaProduction"], "模擬聲音工程");
	assert.ok(existsSync(paths.registryFile), "對照表 md 要落地");
	assert.match(readFileSync(paths.registryFile, "utf8"), /模擬聲音工程/u);

	// 壞輸入：空名稱、含 `=`、非 JSON content-type、GET 打這條路。
	const bad = await rename(paths, "40-MediaProduction", "  ");
	assert.equal(bad.statusCode, 400);
	const withEquals = await rename(paths, "40-MediaProduction", "a=b");
	assert.equal(withEquals.statusCode, 400);

	const handler = createRenameHandler({ sessionsRoot: paths.sessionsRoot, workspaceSlug: paths.workspaceSlug, ...paths });
	const wrongType = fakeRes();
	await handler(fakeReq({ method: "POST", headers: { "content-type": "text/plain" }, body: "{}" }), wrongType);
	assert.equal(wrongType.statusCode, 415);

	const wrongMethod = fakeRes();
	await handler(fakeReq({ method: "GET" }), wrongMethod);
	assert.equal(wrongMethod.statusCode, 405);
});

// ── 歸鏈：把「未標記」的對話手動指定到一條鏈（使用者：沒加標記的其實同一個話題） ──

/** 造一個有「已歸鏈」與「未標記」兩種對話的 sessions 目錄。 */
function fixtureLoose() {
	const root = mkdtempSync(join(tmpdir(), "assign-"));
	const slug = "--tmp-workspace--";
	writeSessionLog(root, slug, "session-chained", [userEvent("【接續提示詞】\n鏈=dsh-demo\n先讀 README", 1_000)]);
	writeSessionLog(root, slug, "session-loose-a", [userEvent("我們來聊聊聲音工程", 2_000)]);
	writeSessionLog(root, slug, "session-loose-b", [userEvent("聲音工程的第二段", 3_000)]);
	const work = mkdtempSync(join(tmpdir(), "assign-work-"));
	return {
		sessionsRoot: root,
		workspaceSlug: slug,
		aliasesFile: join(work, ".state", "aliases.json"),
		registryFile: join(work, "鏈代號.md"),
		work,
	};
}

/** 呼叫 POST 歸鏈路由。 */
async function assign(paths, sessionId, chain) {
	const handler = createAssignHandler({ sessionsRoot: paths.sessionsRoot, workspaceSlug: paths.workspaceSlug, ...paths });
	const res = fakeRes();
	await handler(
		fakeReq({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId, chain }) }),
		res,
	);
	return res;
}

/** 打一次 GET 路由並回傳 payload。 */
function getPayload(paths) {
	const res = fakeRes();
	createHandler({ sessionsRoot: paths.sessionsRoot, workspaceSlug: paths.workspaceSlug, ...paths })(fakeReq({ method: "GET" }), res);
	return JSON.parse(res.body);
}

test("歸鏈：把未標記的兩場指定成同一條鏈 → 合成一組（＝使用者要的『關聯』）", async () => {
	const paths = fixtureLoose();
	assert.equal(getPayload(paths).chains.find((group) => group.chain === null).count, 2, "一開始兩場都未標記");

	assert.equal((await assign(paths, "session-loose-a", "模擬聲音工程")).statusCode, 200);
	assert.equal((await assign(paths, "session-loose-b", "模擬聲音工程")).statusCode, 200);

	const after = getPayload(paths);
	const chain = after.chains.find((group) => group.chain === "模擬聲音工程");
	assert.ok(chain !== undefined, "兩場手動歸鏈的對話必須合成一條鏈");
	assert.deepEqual(chain.sessionIds, ["session-loose-a", "session-loose-b"]);
	const unmarked = after.chains.find((group) => group.chain === null);
	assert.ok(unmarked === undefined || unmarked.count === 0, "未標記要清空（整組消失或 0 場都算）");
	assert.equal(chain.sessions[0].assignedChain, "模擬聲音工程", "要標記這是手動歸的");
});

test("歸鏈：指到『既有』的鏈等於關聯兩批對話", async () => {
	const paths = fixtureLoose();
	await assign(paths, "session-loose-a", "dsh-demo");
	const merged = getPayload(paths).chains.find((group) => group.chain === "dsh-demo");
	assert.deepEqual(merged.sessionIds, ["session-chained", "session-loose-a"]);
	assert.equal(loadStore(paths.aliasesFile).sessionChains["session-loose-a"], "dsh-demo");
});

test("歸鏈：留白送出＝取消指定（回到自動判定）；壞輸入被擋", async () => {
	const paths = fixtureLoose();
	await assign(paths, "session-loose-a", "模擬聲音工程");
	assert.equal(loadStore(paths.aliasesFile).sessionChains["session-loose-a"], "模擬聲音工程");

	assert.equal((await assign(paths, "session-loose-a", "")).statusCode, 200, "留白＝取消指定，不是錯誤");
	assert.equal(loadStore(paths.aliasesFile).sessionChains["session-loose-a"], undefined);
	assert.equal(getPayload(paths).chains.find((group) => group.chain === "模擬聲音工程"), undefined, "取消後回到未標記");

	assert.equal((await assign(paths, "", "x")).statusCode, 400, "缺 sessionId");
	assert.equal((await assign(paths, "s1", "a=b")).statusCode, 400, "含 = 的名稱");
});

test("applyAssignments：手動指定覆寫自動判定，但沒有指定的場次原樣不動", () => {
	const sessions = [
		{ id: "a", chain: "auto", chains: ["auto"], chainRaw: "auto" },
		{ id: "b", chain: null, chains: [] },
	];
	const mapped = applyAssignments(sessions, { a: "手動", b: "手動" });
	assert.equal(mapped[0].chain, "手動");
	assert.deepEqual(mapped[0].chains, ["手動"]);
	assert.equal(mapped[0].chainRaw, "auto", "自動判定的結果要留著（看得出它原本屬於哪條鏈）");
	assert.equal(mapped[0].assignedChain, "手動");
	assert.deepEqual(applyAssignments(sessions, {}), sessions, "沒有指定就不動");
});

// ── 同時在兩條鏈（中繼場）：使用者要能指定「只留在這一條」 ────────────────

test("歸鏈：一場同時屬於兩條鏈時，指定一條＝只留在那一條（使用者回報的「同時在兩條鏈」）", () => {
	const sessions = [
		{ id: "bridge", chain: "a", chains: ["a", "b"], handoffTo: "b" },
		{ id: "plain", chain: "a", chains: ["a"] },
	];
	const groups = new Map(groupByChain(applyAssignments(sessions, { bridge: "b" }, {})).map((group) => [group.chain, group.sessionIds]));
	assert.deepEqual(groups.get("b"), ["bridge"]);
	assert.deepEqual(groups.get("a"), ["plain"], "指定之後不可以再同時出現在兩條鏈");
});

test("applyAssignments：指定的名字也要過對照表（舊代號 → 現用名稱）", () => {
	const sessions = [{ id: "x", chain: null, chains: [] }];
	const mapped = applyAssignments(sessions, { x: "dsh-demo" }, { "dsh-demo": "示範專案" });
	assert.equal(mapped[0].chain, "示範專案");
	assert.equal(mapped[0].assignedChain, "示範專案");
});

test("歸鏈：打『舊代號』要落在現用名稱，不可生出影子鏈（2026-10-17 實測踩到）", async () => {
	const paths = fixtureLoose();
	// dsh-demo 先改名成「示範專案」。
	saveStore(paths.aliasesFile, { aliases: updateAliases({}, "dsh-demo", "示範專案"), sessionChains: {} });
	assert.equal((await assign(paths, "session-loose-a", "dsh-demo")).statusCode, 200);

	const after = getPayload(paths);
	assert.equal(after.chains.find((group) => group.chain === "dsh-demo"), undefined, "不可以多出一條叫舊代號的影子鏈");
	const merged = after.chains.find((group) => group.chain === "示範專案");
	assert.ok(merged !== undefined, "指定的舊代號要落在改名後的現用名稱");
	assert.deepEqual(merged.sessionIds, ["session-chained", "session-loose-a"]);
});

test("對照表檔案同時保存三張表（改名／歸鏈／原標題備份互不覆蓋）", () => {
	const paths = fixtureLoose();
	const store = {
		aliases: updateAliases({}, "40-MediaProduction", "模擬聲音工程"),
		sessionChains: { s1: "模擬聲音工程" },
		titles: { s1: "原本的標題" },
		pinned: ["模擬聲音工程"],
		archived: [],
	};
	assert.equal(saveStore(paths.aliasesFile, store).ok, true);
	assert.deepEqual(loadStore(paths.aliasesFile), store);
});


// ── 2026-10-19：置頂／封存（寫入路徑之四）──────────────────────────────

/** 呼叫置頂／封存路由。 */
async function flag(paths, kind, chain, on) {
	const handler = createFlagHandler({ kind })({ sessionsRoot: paths.sessionsRoot, workspaceSlug: paths.workspaceSlug, ...paths });
	const res = fakeRes();
	await handler(
		fakeReq({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chain, on }) }),
		res,
	);
	return { status: res.statusCode, payload: JSON.parse(res.body || "{}") };
}

test("POST pin：置頂寫進 store，payload 帶 pinned；取消後清掉", async () => {
	const paths = fixtureLoose();
	await assign(paths, "session-loose-a", "dsh-demo");

	const first = await flag(paths, "pinned", "dsh-demo", true);
	assert.equal(first.status, 200);
	assert.deepEqual(first.payload.pinned, ["dsh-demo"]);
	assert.deepEqual(loadStore(paths.aliasesFile).pinned, ["dsh-demo"]);

	const off = await flag(paths, "pinned", "dsh-demo", false);
	assert.deepEqual(off.payload.pinned, []);
	assert.deepEqual(loadStore(paths.aliasesFile).pinned, []);
});

test("POST archive：封存只寫 store，不動任何 session 資料；還原後清單變空", async () => {
	const paths = fixtureLoose();
	await assign(paths, "session-loose-a", "dsh-demo");

	const on = await flag(paths, "archived", "dsh-demo", true);
	assert.equal(on.status, 200);
	assert.deepEqual(on.payload.archived, ["dsh-demo"]);
	// 封存不是刪除：那一場還在 payload 的 sessions 裡
	assert.ok(on.payload.sessions.some((session) => session.id === "session-loose-a"));
	// 兩張清單互不干擾
	assert.deepEqual(on.payload.pinned, []);

	const off = await flag(paths, "archived", "dsh-demo", false);
	assert.deepEqual(off.payload.archived, []);
});

test("置頂／封存用舊代號按也生效（先過對照表）", async () => {
	const paths = fixtureLoose();
	await assign(paths, "session-loose-a", "40-MediaProduction");
	await rename(paths, "40-MediaProduction", "模擬聲音工程");

	const res = await flag(paths, "pinned", "40-MediaProduction", true);
	assert.equal(res.status, 200);
	// 舊代號要落成改名後的現用名稱，否則是幽靈置頂
	assert.deepEqual(res.payload.pinned, ["模擬聲音工程"]);
});

test("空名字或超長名字 → 400，不會寫壞 store", async () => {
	const paths = fixtureLoose();
	const empty = await flag(paths, "pinned", "", true);
	assert.equal(empty.status, 400);
	const long = await flag(paths, "archived", "x".repeat(61), true);
	assert.equal(long.status, 400);
	assert.deepEqual(loadStore(paths.aliasesFile).pinned, []);
});

// ── Task 3（2026-10-18）：自動編號 —— store 第三張表、payload、回報路由 ──────

/** 呼叫 POST 標題回報路由。 */
async function postTitles(paths, body) {
	const handler = createTitlesHandler({ sessionsRoot: paths.sessionsRoot, workspaceSlug: paths.workspaceSlug, ...paths });
	const res = fakeRes();
	await handler(
		fakeReq({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
		res,
	);
	return res;
}


test("store：pinned／archived 去重、排序固定，壞值忽略", () => {
	const paths = fixtureLoose();
	const store = {
		aliases: {},
		sessionChains: {},
		titles: {},
		pinned: ["B", "A", "A", "", 3],
		archived: ["Z"],
	};
	assert.equal(saveStore(paths.aliasesFile, store).ok, true);
	const loaded = loadStore(paths.aliasesFile);
	assert.deepEqual(loaded.pinned, ["A", "B"], "去重、移除空字串與非字串、排序固定");
	assert.deepEqual(loaded.archived, ["Z"]);
	// toggleInList：加與拿掉都不會動到原本的陣列
	assert.deepEqual(toggleInList(loaded.pinned, "C", true), ["A", "B", "C"]);
	assert.deepEqual(toggleInList(loaded.archived, "Z", false), []);
});

test("store：titles 第三張表可存可讀，且不影響其他兩張", () => {
	const paths = fixtureLoose();
	const store = {
		aliases: updateAliases({}, "dsh-demo", "示範專案"),
		sessionChains: { s1: "示範專案" },
		titles: { s1: "我原本的標題" },
		pinned: [],
		archived: ["示範專案"],
	};
	assert.equal(saveStore(paths.aliasesFile, store).ok, true);
	assert.deepEqual(loadStore(paths.aliasesFile), store);
});

test("GET：payload 帶 numbering（同鏈 3 場 → 3 筆，依時間 001..003）", async () => {
	const paths = fixtureLoose();
	await assign(paths, "session-loose-a", "dsh-demo");
	await assign(paths, "session-loose-b", "dsh-demo");

	const payload = getPayload(paths);
	assert.ok(payload.numbering !== undefined, "payload 要有 numbering");
	assert.equal(payload.numbering.items.length, 3);
	const byId = Object.fromEntries(payload.numbering.items.map((item) => [item.sessionId, item.to]));
	assert.deepEqual(byId, {
		"session-chained": "dsh-demo-001",
		"session-loose-a": "dsh-demo-002",
		"session-loose-b": "dsh-demo-003",
	});
	assert.equal(payload.numbering.needsConfirm, false);
});

test("POST titles：寫入備份，第二次不覆蓋第一次的原標題", async () => {
	const paths = fixtureLoose();
	await assign(paths, "session-loose-a", "dsh-demo");

	const first = await postTitles(paths, {
		applied: [{ sessionId: "session-loose-a", from: "我們來聊聊聲音工程", to: "dsh-demo-002" }],
	});
	assert.equal(first.statusCode, 200);
	assert.equal(loadStore(paths.aliasesFile).titles["session-loose-a"], "我們來聊聊聲音工程");

	const second = await postTitles(paths, {
		applied: [{ sessionId: "session-loose-a", from: "dsh-demo-002", to: "dsh-demo-003" }],
	});
	assert.equal(second.statusCode, 200);
	assert.equal(
		loadStore(paths.aliasesFile).titles["session-loose-a"],
		"我們來聊聊聲音工程",
		"備份只記第一次（重編後不能把中間值當成原標題）",
	);
});

test("POST titles：還原成功時把備份清掉（不留孤兒）", async () => {
	const paths = fixtureLoose();
	saveStore(paths.aliasesFile, { aliases: {}, sessionChains: {}, titles: { "session-loose-a": "我原本的標題" } });

	const res = await postTitles(paths, {
		applied: [{ sessionId: "session-loose-a", from: "dsh-demo-003", to: "我原本的標題" }],
	});
	assert.equal(res.statusCode, 200);
	assert.equal(loadStore(paths.aliasesFile).titles["session-loose-a"], undefined, "還原後不該再有備份");
});

test("POST titles：順手把 鏈代號.md 的場次刷新（新的一場進鏈時就是場次變動的時刻）", async () => {
	const paths = fixtureLoose();
	await assign(paths, "session-loose-a", "dsh-demo");
	// 模擬「對照表停在舊的數字」：先寫一份過期的檔案（0 場），再看 POST titles 有沒有把它修回來。
	writeFileSync(paths.registryFile, "| dsh-demo | — | 0 場 |\n", "utf8");
	const response = await postTitles(paths, {
		applied: [{ sessionId: "session-loose-a", from: "我們來聊聊聲音工程", to: "dsh-demo-002" }],
	});
	assert.equal(response.statusCode, 200);
	const markdown = readFileSync(paths.registryFile, "utf8");
	assert.match(markdown, /dsh-demo/u);
	assert.match(markdown, /2 場/u, "套用編號後，對照表要看得到目前的場次（session-chained ＋ 剛歸鏈的 loose-a）");
	assert.ok(!/0 場/u.test(markdown), "不可以停在改名／歸鏈那一刻的舊數字");
});

test("POST titles：壞輸入被擋（缺 sessionId／非 JSON／GET）", async () => {
	const paths = fixtureLoose();
	assert.equal((await postTitles(paths, { applied: [{ from: "a", to: "b" }] })).statusCode, 400);

	const handler = createTitlesHandler({ sessionsRoot: paths.sessionsRoot, workspaceSlug: paths.workspaceSlug, ...paths });
	const wrongType = fakeRes();
	await handler(fakeReq({ method: "POST", headers: { "content-type": "text/plain" }, body: "{}" }), wrongType);
	assert.equal(wrongType.statusCode, 415);

	const wrongMethod = fakeRes();
	await handler(fakeReq({ method: "GET" }), wrongMethod);
	assert.equal(wrongMethod.statusCode, 405);
});

test("取消歸鏈後：payload 的 numbering.restores 帶回原標題", async () => {
	const paths = fixtureLoose();
	await assign(paths, "session-loose-a", "dsh-demo");
	saveStore(paths.aliasesFile, {
		aliases: {},
		sessionChains: { "session-loose-a": "dsh-demo" },
		titles: { "session-loose-a": "我原本的標題" },
	});

	// 模擬「已經改過名」：把標題寫進該場的 log（最後一筆 session/title）
	const dir = join(paths.sessionsRoot, paths.workspaceSlug, "session-loose-a");
	writeSessionLog(paths.sessionsRoot, paths.workspaceSlug, "session-loose-a", [
		userEvent("我們來聊聊聲音工程", 2_000),
		{ type: "session/title", time: 2_500, data: { title: "dsh-demo-002", messageSeqs: [], source: { kind: "user" } } },
	]);
	assert.ok(existsSync(dir));

	// 取消歸鏈（留白）
	assert.equal((await assign(paths, "session-loose-a", "")).statusCode, 200);
	const payload = getPayload(paths);
	assert.deepEqual(payload.numbering.restores, [
		{ sessionId: "session-loose-a", from: "dsh-demo-002", to: "我原本的標題" },
	]);
});

// ── 2026-10-18：子代理不要進交接鏈（使用者：這類用完就封存待查即可）──────────

/** 造一個「同一條鏈裡有一場子代理」的 sessions 目錄。 */
function fixtureWithSubagent() {
	const root = mkdtempSync(join(tmpdir(), "subagent-"));
	const slug = "--tmp-workspace--";
	writeSessionLog(root, slug, "session-chained", [userEvent("【接續提示詞】\n鏈=dsh-demo\n先讀 README", 1_000)]);
	writeSessionLog(root, slug, "session-sub", [
		userEvent("【接續提示詞】\n鏈=dsh-demo\n先讀 README", 2_000),
		{ type: "subagent/descriptor", time: 2_100, data: { label: "reviewer" } },
	]);
	writeSessionLog(root, slug, "session-later", [userEvent("【接續提示詞】\n鏈=dsh-demo\n先讀 README", 3_000)]);
	const work = mkdtempSync(join(tmpdir(), "subagent-work-"));
	return {
		sessionsRoot: root,
		workspaceSlug: slug,
		aliasesFile: join(work, ".state", "aliases.json"),
		registryFile: join(work, "鏈代號.md"),
		work,
	};
}

test("子代理不進交接鏈：payload 不含它、鏈裡不算它、編號也不佔號", () => {
	const paths = fixtureWithSubagent();
	const payload = getPayload(paths);

	assert.equal(
		payload.sessions.some((session) => session.id === "session-sub"),
		false,
		"子代理不該出現在 sessions（左側欄本來也不列它們）",
	);
	const chain = payload.chains.find((group) => group.chain === "dsh-demo");
	assert.deepEqual(chain.sessionIds, ["session-chained", "session-later"], "鏈裡只有真正的對話");
	assert.equal(chain.count, 2);
	assert.equal(
		payload.numbering.items.some((item) => item.sessionId === "session-sub"),
		false,
		"編號計畫也不能包含子代理",
	);
	assert.deepEqual(
		payload.numbering.items.map((item) => item.to),
		["dsh-demo-002", "dsh-demo-001"],
		"後面的場次不因為子代理而跳號",
	);
});

test("子代理不會出現在未標記那一組（它們根本不該被列進面板）", () => {
	const paths = fixtureWithSubagent();
	const payload = getPayload(paths);
	const unmarked = payload.chains.find((group) => group.chain === null);
	assert.equal(unmarked === undefined || unmarked.sessions.every((session) => session.subagent !== true), true);
});

test("接續提示詞路由：GET 讀檔、POST clear 刪檔；沒有檔案回 null", async () => {
	const dir = mkdtempSync(join(tmpdir(), "chains-prompt-"));
	const file = join(dir, "next-prompt.txt");
	const handler = createNextPromptHandler({ file });

	const empty = fakeRes();
	await handler(fakeReq({ method: "GET" }), empty);
	assert.equal(empty.statusCode, 200);
	assert.equal(JSON.parse(empty.body).prompt, null, "沒有檔案＝還沒有交接詞");

	writeFileSync(file, "先讀交接單\n鏈=測試", "utf8");
	const got = fakeRes();
	await handler(fakeReq({ method: "GET" }), got);
	assert.equal(JSON.parse(got.body).prompt, "先讀交接單\n鏈=測試");

	const cleared = fakeRes();
	await handler(
		fakeReq({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clear: true }) }),
		cleared,
	);
	assert.equal(cleared.statusCode, 200);
	assert.equal(existsSync(file), false, "用完就刪，不會重複貼舊的");
});

// ── 2026-10-19 ponytail 稽核補的釘子 ─────────────────────────────────────

test("store 壞檔：先備份再回空表（下一次寫入不會永久覆蓋）", () => {
	const work = mkdtempSync(join(tmpdir(), "store-corrupt-"));
	const file = join(work, ".state", "aliases.json");
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, "{ 這不是 JSON", "utf8");

	const store = loadStore(file);
	assert.deepEqual(store.aliases, {}, "壞檔等同空表");
	assert.equal(existsSync(file), false, "壞檔已被移走，不會被下一次寫入覆蓋");

	const backups = readdirSync(dirname(file)).filter((name) => name.startsWith("aliases.json.corrupt-"));
	assert.equal(backups.length, 1, "留了一份備份");
	assert.equal(readFileSync(join(dirname(file), backups[0]), "utf8"), "{ 這不是 JSON");
});

test("POST titles：超過 8 KB 的回報不會被 body 上限擋掉（150 筆）", async () => {
	const paths = fixtureLoose();
	const applied = Array.from({ length: 150 }, (_, index) => ({
		sessionId: `session-bulk-${index}`,
		from: `原本的標題第 ${index} 場`,
		to: `dsh-bulk-${String(index + 1).padStart(3, "0")}`,
	}));
	const payload = JSON.stringify({ applied });
	assert.ok(payload.length > 8192, `這個 payload 要真的超過 8 KB（實際 ${payload.length}）`);

	const res = await postTitles(paths, { applied });
	assert.equal(res.statusCode, 200);
	assert.equal(Object.keys(loadStore(paths.aliasesFile).titles).length, 150);
});

test("POST pin：名字含空白 → 400，不可安靜釘到不存在的鏈", async () => {
	const paths = fixtureLoose();
	const handler = createFlagHandler({ kind: "pinned" })({
		sessionsRoot: paths.sessionsRoot,
		workspaceSlug: paths.workspaceSlug,
		...paths,
	});
	const res = fakeRes();
	await handler(
		fakeReq({
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ chain: "交接 鏈", on: true }),
		}),
		res,
	);
	assert.equal(res.statusCode, 400);
	assert.deepEqual(loadStore(paths.aliasesFile).pinned, [], "壞名字不可以寫進 pinned");
});
