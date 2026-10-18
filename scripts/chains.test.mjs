/**
 * chains.test.mjs — 交接鏈判定的自動測試（spike 補上的那一套）。
 *
 * 為什麼會有這支：spike 原本只有一支煙霧測試，**沒有測試「鏈怎麼判」**。
 * 2026-10-17 修「第一個提出交接的對話沒被列入」時，判定的輸入從
 * 「第一句話」擴大成「第一句話 ＋ 這場對話自己產出的交接提示詞」，
 * 這裡把那條規則的每一個邊界固定下來。
 *
 * 用法：node --test scripts/chains.test.mjs（或 node --test scripts/）
 */
import { mkdtempSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import assert from "node:assert/strict";
import test from "node:test";

import { extractChain, extractOutChain, groupByChain, readSessions, undecorate } from "../plugin/chains.mjs";

/** 造一則使用者訊息事件。 */
function userEvent(text, time = 0) {
	return { type: "user/message", time, data: { content: [{ type: "text", text }] } };
}

/** 造一則助理訊息事件（回答本文）。 */
function assistantEvent(text, time = 0) {
	return { type: "assistant/message", time, data: { content: [{ type: "text", text }] } };
}

/** 造一則助理訊息事件，但內容放在 reasoning（推理）part。 */
function assistantReasoningEvent(text, time = 0) {
	return { type: "assistant/message", time, data: { content: [{ type: "reasoning", text }] } };
}

// ── undecorate：把 markdown 裝飾剝掉，才認得出「一行就是標記」 ──────────────

test("undecorate 剝掉粗體、code span、條列與【】", () => {
	assert.equal(undecorate("- **鏈=dsh-token-hud**"), "鏈=dsh-token-hud");
	assert.equal(undecorate("`鏈=dsh-token-hud`"), "鏈=dsh-token-hud");
	assert.equal(undecorate("【鏈=dsh-token-hud】"), "鏈=dsh-token-hud");
	assert.equal(undecorate("> 接續 dsh-token-hud：讀 README.md"), "接續 dsh-token-hud：讀 README.md");
	assert.equal(undecorate("1. 鏈=dsh-token-hud"), "1. 鏈=dsh-token-hud");
});

// ── extractChain（既有）：只吃第一句話 ─────────────────────────────────────

test("extractChain：第一句話的三種訊號", () => {
	assert.deepEqual(extractChain("先讀這幾個檔\n鏈=dsh-token-hud\n"), { chain: "dsh-token-hud", reason: "tag" });
	assert.equal(extractChain("接續 dsh-token-hud：讀 30-CodingSkills/dsh-token-hud/README.md").chain, "dsh-token-hud");
	assert.equal(extractChain("修一下 30-CodingSkills/dsh-session-chains 的面板").chain, "dsh-session-chains");
	assert.equal(extractChain("幫我寫一份公文").chain, null);
});

// ── extractOutChain（新）：這場對話自己「交接出去」的鏈 ────────────────────

test("extractOutChain：認得助理產出的交接提示詞那一行", () => {
	const tagged = [assistantEvent("【接續提示詞】\n---\n鏈=dsh-session-chains\n先讀 30-CodingSkills/dsh-session-chains/README.md")];
	assert.equal(extractOutChain(tagged).chain, "dsh-session-chains");

	const legacy = [assistantEvent("【接續提示詞】\n---\n接續 dsh-token-hud：讀 30-CodingSkills/dsh-token-hud/README.md")];
	assert.equal(extractOutChain(legacy).chain, "dsh-token-hud");

	const bold = [assistantEvent("- **鏈=dsh-local-model**")];
	assert.equal(extractOutChain(bold).chain, "dsh-local-model");

	// 技能模板那一行帶著尾註（`鏈=<專案代號>　← 這一行是…`）：照模板寫也要認得。
	const template = [assistantEvent("鏈=dsh-local-model　← 這一行是給左側欄「交接鏈」面板自動分組用")];
	assert.equal(extractOutChain(template).chain, "dsh-local-model");

	const paren = [assistantEvent("接續 dsh-session-chains（/work/my-project/30-CodingSkills/dsh-session-chains）。")];
	assert.equal(extractOutChain(paren).chain, "dsh-session-chains");
});

test("extractOutChain：行內的順口提及不算（真實踩過的誤判）", () => {
	const prose = [
		assistantEvent(
			[
				"我在推理裡反覆寫到 `鏈=dsh-token-hud` 這個字串，",
				"1. 明確標記：鏈=<id> 或 【鏈=<id>】",
				"- **鏈代號寫進規則**：我正在用的格式是提示詞裡一行 `鏈=dsh-token-hud`。",
				"鏈=dsh-token-hud 的規則要沿用（行首剛好是標記，但尾巴是文字，不算）。",
				"接續 dsh-token-hud 的進度還沒跑完（沒有分隔符，不是提示詞）。",
				"接續提示詞必須含一行鏈代號。",
			].join("\n"),
		),
	];
	assert.equal(extractOutChain(prose).chain, null);
});

test("extractOutChain：只認助理訊息的「回答本文」（推理與工具呼叫都不算）", () => {
	const events = [
		userEvent("鏈=dsh-token-hud"),
		{ type: "tool/call", data: { content: [{ type: "text", text: "鏈=dsh-token-hud" }] } },
		{ type: "tool/result", data: { content: [{ type: "text", text: "接續 dsh-token-hud：讀 README.md" }] } },
		{ type: "user/message", data: { content: [{ type: "text", text: "【接續提示詞】\n接續 dsh-local-model：..." }] } },
		// 真實踩到：修正這條規則的那一場，推理裡「引用」了一行當例子（整行就是標記）→ 不算。
		assistantReasoningEvent("我的嚴格錨點會擋掉這種行：\n`鏈=dsh-token-hud ← 這一行是給左側欄「交接鏈」面板自動分組用`"),
	];
	assert.equal(extractOutChain(events).chain, null);
});

test("extractOutChain：同一場多次產出時，最後一次為準", () => {
	const events = [assistantEvent("鏈=dsh-token-hud"), assistantEvent("鏈=dsh-session-chains")];
	assert.equal(extractOutChain(events).chain, "dsh-session-chains");
});

// ── 整合：第一個提出交接的那一場，要落在自己開出來的那條鏈裡 ───────────────

/** 把事件陣列寫成 DSH 的 session log（單一 zstd frame 的 JSONL）。 */
function writeSessionLog(root, slug, sessionId, events) {
	const dir = join(root, slug, sessionId);
	mkdirSync(dir, { recursive: true });
	const jsonl = `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
	writeFileSync(join(dir, "session.v1.jsonl.zstd"), zstdCompressSync(Buffer.from(jsonl, "utf8")));
}

test("readSessions＋groupByChain：頭一場（自己產出提示詞的那場）也在鏈裡", () => {
	const root = mkdtempSync(join(tmpdir(), "chains-"));
	const slug = "--tmp-workspace--";

	// 第一場：一般開場，沒有鏈標記；工作到最後產出 dsh-demo 的交接提示詞。
	writeSessionLog(root, slug, "session-head", [
		userEvent("幫我做一個示範專案", 1_000),
		assistantEvent("好，先看目錄。", 2_000),
		assistantEvent("【接續提示詞】\n---\n鏈=dsh-demo\n先讀 30-CodingSkills/dsh-demo/README.md", 3_000),
		assistantEvent("【接續提示詞】\n---\n鏈=dsh-demo\n先讀 30-CodingSkills/dsh-demo/README.md", 4_000),
	]);
	// 第二場：使用者把那份提示詞貼進來（第一句話就有鏈標記）。
	writeSessionLog(root, slug, "session-next", [userEvent("【接續提示詞】\n鏈=dsh-demo\n先讀 30-CodingSkills/dsh-demo/README.md", 5_000)]);
	// 第三場：無關的對話。
	writeSessionLog(root, slug, "session-other", [userEvent("今天天氣如何", 6_000)]);

	const { sessions } = readSessions(root, { workspaceSlug: slug });
	assert.equal(sessions.length, 3);

	const byId = new Map(sessions.map((session) => [session.id, session]));
	assert.deepEqual(byId.get("session-head").chains, ["dsh-demo"]);
	assert.equal(byId.get("session-head").chain, "dsh-demo");
	assert.equal(byId.get("session-head").handoffTo, "dsh-demo");
	assert.deepEqual(byId.get("session-next").chains, ["dsh-demo"]);
	assert.equal(byId.get("session-next").handoffTo, null);
	assert.deepEqual(byId.get("session-other").chains, []);

	const chain = groupByChain(sessions).find((group) => group.chain === "dsh-demo");
	assert.equal(chain.count, 2);
	assert.deepEqual(chain.sessionIds, ["session-head", "session-next"]);
	assert.equal(groupByChain(sessions).find((group) => group.chain === null).count, 1);
});

test("groupByChain：中繼場（接手一條鏈、又開出另一條）兩邊都算", () => {
	const sessions = [
		{ id: "bridge", startedAt: 1, chain: "a", chains: ["a", "b"], chainReason: "接續", handoffTo: "b" },
		{ id: "next", startedAt: 2, chain: "b", chains: ["b"], chainReason: "tag", handoffTo: null },
		{ id: "loose", startedAt: 3, chain: null, chains: [], chainReason: "unmarked", handoffTo: null },
	];
	const groups = new Map(groupByChain(sessions).map((group) => [group.chain, group.sessionIds]));
	assert.deepEqual(groups.get("a"), ["bridge"]);
	assert.deepEqual(groups.get("b"), ["bridge", "next"]);
	assert.deepEqual(groups.get(null), ["loose"]);
});

// ── Task 1（2026-10-18）：標題 —「最後一筆 session/title 為準」 ─────────────

/** 造一則標題事件（DSH 的 title 投影就是這樣落的）。 */
function titleEvent(title, kind = "user", time = 0) {
	return { type: "session/title", time, data: { title, messageSeqs: [], source: { kind } } };
}

test("readSessions：抓最後一筆 session/title（含 source）", () => {
	const root = mkdtempSync(join(tmpdir(), "titles-"));
	writeSessionLog(root, "--w--", "s1", [
		userEvent("hi", 1),
		titleEvent("舊標題", "fallback", 2),
		titleEvent("模擬聲音工程-001", "user", 3),
	]);
	const { sessions } = readSessions(root, { workspaceSlug: "--w--" });
	assert.equal(sessions[0].title, "模擬聲音工程-001");
	assert.equal(sessions[0].titleSource, "user");
});

test("readSessions：沒有 session/title 的會話，title 與 titleSource 都是 null", () => {
	const root = mkdtempSync(join(tmpdir(), "titles-"));
	writeSessionLog(root, "--w--", "s1", [userEvent("hi", 1)]);
	const { sessions } = readSessions(root, { workspaceSlug: "--w--" });
	assert.equal(sessions[0].title, null);
	assert.equal(sessions[0].titleSource, null);
});

test("readSessions：子代理（有 subagent/descriptor）會被標記，編號時要跳過", () => {
	const root = mkdtempSync(join(tmpdir(), "sub-"));
	writeSessionLog(root, "--w--", "s1", [
		userEvent("hi", 1),
		{ type: "subagent/descriptor", time: 2, data: { label: "reviewer" } },
	]);
	writeSessionLog(root, "--w--", "s2", [userEvent("hello", 3)]);
	const { sessions } = readSessions(root, { workspaceSlug: "--w--" });
	const byId = Object.fromEntries(sessions.map((session) => [session.id, session]));
	assert.equal(byId.s1.subagent, true);
	assert.equal(byId.s2.subagent, false);
});

// ── 「最後一次有動」＝最後活動時間，不是最後一場開始時間（2026-10-18 使用者定義）──

test("readSessions：lastActiveAt 取「最後事件時間」與「檔案 mtime」較大者", () => {
	const root = mkdtempSync(join(tmpdir(), "chains-active-"));
	writeSessionLog(root, "--w--", "s1", [userEvent("hi", 1_000), assistantEvent("yo", 9_000)]);
	const file = join(root, "--w--", "s1", "session.v1.jsonl.zstd");
	// 把 mtime 壓到事件之前，才驗得到「事件時間」那一邊。
	utimesSync(file, 1, 1);
	const first = readSessions(root, { workspaceSlug: "--w--" }).sessions;
	assert.equal(first[0].startedAt, 1_000);
	assert.equal(first[0].lastActiveAt, 9_000, "最後一筆事件時間");

	// 反過來：事件很舊、檔案比較新（例如收尾事件或改寫）→ 取 mtime。
	utimesSync(file, 9.5, 9.5);
	const second = readSessions(root, { workspaceSlug: "--w--" }).sessions;
	assert.equal(second[0].lastActiveAt, 9_500, "檔案 mtime 比事件新就取 mtime");
});

test("groupByChain：鏈的 lastAt＝組內最後活動時間，排序也照它", () => {
	const sessions = [
		{ id: "a", startedAt: 100, lastActiveAt: 900, chain: "x", chains: ["x"] },
		{ id: "b", startedAt: 200, lastActiveAt: 300, chain: "x", chains: ["x"] },
		{ id: "c", startedAt: 50, lastActiveAt: 500, chain: "y", chains: ["y"] },
	];
	const groups = groupByChain(sessions);
	const x = groups.find((group) => group.chain === "x");
	const y = groups.find((group) => group.chain === "y");
	assert.equal(x.lastAt, 900, "取組內最大值（b 比較晚開始，但 a 比較晚有動）");
	assert.equal(y.lastAt, 500);
	assert.equal(groups[0].chain, "x", "最後活動較新的鏈排前面");
});

// ── 2026-10-19：同一場有多個格式版本時，要讀版本號最大的 ────────────────

test("同一場有 v4 與 v10 兩份日誌 → 讀 v10（字典序會把 v10 排在 v4 前面）", () => {
	const root = mkdtempSync(join(tmpdir(), "chains-version-"));
	const slug = "--tmp-workspace--";
	const dir = join(root, slug, "session-two-versions");
	mkdirSync(dir, { recursive: true });
	const encode = (events) => zstdCompressSync(Buffer.from(`${events.map((e) => JSON.stringify(e)).join("\n")}\n`, "utf8"));
	writeFileSync(join(dir, "session.v4.jsonl.zstd"), encode([userEvent("舊的那句話", 1_000)]));
	writeFileSync(join(dir, "session.v10.jsonl.zstd"), encode([userEvent("新的那句話", 2_000)]));

	const { sessions } = readSessions(root, { workspaceSlug: slug });
	assert.equal(sessions.length, 1);
	assert.equal(sessions[0].firstLine, "新的那句話");
});
