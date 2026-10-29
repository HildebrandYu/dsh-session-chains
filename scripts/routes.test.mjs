/**
 * routes.test.mjs — 寫入路由的「信封」與回應形狀（2026-10-29 架構審查的兩條建議）。
 *
 * 為什麼要有這一支：候選 2（信封）與候選 1（payload 形狀）都是**去重**，
 * 而去重的價值只有在「六條路由真的回同一份東西」被測住之後才成立 ——
 * 否則下一次新增一條寫入路由時，重複會安靜地長回來（這已經發生過一次：
 * 只改了 POST 那支的置頂，GET 沒改，畫面看起來就是按不動）。
 *
 * 這裡測的是**形狀**，不是業務規則：業務規則在 rename.test.mjs。
 * 用法：node --test scripts/routes.test.mjs
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import assert from "node:assert/strict";
import test from "node:test";

import { saveStore } from "../plugin/aliases.mjs";
import { createAssignHandler, createFlagHandler, createHandler, createRenameHandler, createTitlesHandler } from "../plugin/index.mjs";

/** 造一則使用者訊息事件。 */
function userEvent(text, time = 0) {
	return { type: "user/message", time, data: { content: [{ type: "text", text }] } };
}

/** 把事件陣列寫成 session log。 */
function writeSessionLog(root, slug, sessionId, events) {
	const dir = join(root, slug, sessionId);
	mkdirSync(dir, { recursive: true });
	const jsonl = `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
	writeFileSync(join(dir, "session.v1.jsonl.zstd"), zstdCompressSync(Buffer.from(jsonl, "utf8")));
}

/** 假 req：POST 用非同步迭代器餵 body。 */
function fakeReq({ method = "GET", headers = {}, body = "" } = {}) {
	return {
		method,
		headers,
		async *[Symbol.asyncIterator]() {
			if (body !== "") yield Buffer.from(body, "utf8");
		},
	};
}

/** 假 res。 */
function fakeRes() {
	return {
		headers: {},
		statusCode: 0,
		body: "",
		setHeader(name, value) {
			this.headers[String(name).toLowerCase()] = value;
		},
		end(chunk) {
			if (chunk !== undefined && chunk !== null) this.body += String(chunk);
		},
	};
}

/** 兩場已歸鏈的對話 ＋ 一份「舊代號」的置頂／封存 ＋ 兩筆標題備份。 */
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "routes-"));
	const slug = "--tmp-workspace--";
	const first = userEvent("【接續提示詞】\n鏈=dsh-demo\n先讀 README", 1_000);
	writeSessionLog(root, slug, "session-a", [first]);
	writeSessionLog(root, slug, "session-b", [userEvent("【接續提示詞】\n鏈=dsh-demo\n先讀 README", 2_000)]);
	const work = mkdtempSync(join(tmpdir(), "routes-work-"));
	const aliasesFile = join(work, ".state", "aliases.json");
	saveStore(aliasesFile, {
		aliases: { "40-MediaProduction": "模擬聲音工程" },
		sessionChains: {},
		titles: { "session-a": "我原本的標題", "session-b": "另一場的標題" },
		// 舊代號的置頂：回應必須是 canonical 名，否則面板比對不到、看起來就是按不動。
		pinned: ["40-MediaProduction"],
		archived: ["40-MediaProduction"],
	});
	return { sessionsRoot: root, workspaceSlug: slug, aliasesFile, registryFile: join(work, "鏈代號.md"), work };
}

/** 六條路由（讀取 ＋ 五條寫入），每一條都回一個 handler 與「怎麼打它」。 */
function routes(paths, { maxAuto = 10 } = {}) {
	const options = { sessionsRoot: paths.sessionsRoot, workspaceSlug: paths.workspaceSlug, ...paths, maxAuto };
	const json = (value) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value) });
	return [
		{ name: "GET", handler: createHandler(options), req: () => ({ method: "GET" }) },
		{ name: "rename", handler: createRenameHandler(options), req: () => json({ from: "40-MediaProduction", to: "模擬聲音工程" }) },
		{ name: "assign", handler: createAssignHandler(options), req: () => json({ sessionId: "session-a", chain: "dsh-demo" }) },
		{ name: "pin", handler: createFlagHandler({ kind: "pinned" })(options), req: () => json({ chain: "模擬聲音工程", on: true }) },
		{ name: "archive", handler: createFlagHandler({ kind: "archived" })(options), req: () => json({ chain: "模擬聲音工程", on: true }) },
		{ name: "titles", handler: createTitlesHandler(options), req: () => json({ applied: [{ sessionId: "session-a", from: "舊", to: "dsh-demo-001" }] }) },
	];
}

/** 打一條路由，回傳 `{status, payload}`。 */
async function hit(route) {
	const res = fakeRes();
	await route.handler(fakeReq(route.req()), res);
	return { status: res.statusCode, payload: JSON.parse(res.body || "{}") };
}

test("六條路由回同一份 payload 形狀（只有 GET 多帶 sessionsRoot）", async () => {
	const paths = fixture();
	const seen = [];
	for (const route of routes(paths)) {
		const { status, payload } = await hit(route);
		assert.equal(status, 200, `${route.name} 應該成功`);
		// 每條路由各自打一份新的 fixture，鍵集合必須一模一樣。
		seen.push({ name: route.name, keys: Object.keys(payload).sort() });
	}
	const shared = seen[0].keys.filter((key) => key !== "sessionsRoot");
	assert.ok(shared.includes("sessionsRoot") === false);
	for (const entry of seen) {
		const keys = entry.name === "GET" ? entry.keys.filter((key) => key !== "sessionsRoot") : entry.keys;
		assert.deepEqual(keys, shared, `${entry.name} 的形狀與 GET 不一致：${keys.join(",")}`);
	}
	// 這份形狀就是面板與卡片吃的東西；少了任何一個鍵前端就會安靜地不顯示。
	for (const key of ["ok", "generatedAt", "version", "files", "aliases", "sessionChains", "titles", "pinned", "archived", "sessions", "chains", "suggestions", "numbering"]) {
		assert.ok(shared.includes(key), `payload 少了 ${key}`);
	}
});

test("置頂／封存一律回 canonical 名（改過名之後，舊名字的置頂仍然生效）", async () => {
	const paths = fixture();
	for (const route of routes(paths)) {
		const { payload } = await hit(route);
		assert.deepEqual(payload.pinned, ["模擬聲音工程"], `${route.name} 的 pinned 要是 canonical 名`);
		assert.deepEqual(payload.archived, ["模擬聲音工程"], `${route.name} 的 archived 要是 canonical 名`);
	}
});

test("maxAuto 在每一條寫入路由都生效（改名那條以前漏傳，退回預設 10）", async () => {
	const paths = fixture();
	// 兩場都有標題備份 → 兩場都算「重編」；maxAuto=1 時超過上限，應該要人確認。
	for (const route of routes(paths, { maxAuto: 1 })) {
		const { payload } = await hit(route);
		assert.equal(payload.numbering.renumbered, 2, `${route.name} 應該算出 2 場重編`);
		assert.equal(payload.numbering.needsConfirm, true, `${route.name} 沒有套用 maxAuto=1`);
	}
});

test("信封：405／415／400 由同一個地方決定，每條寫入路由一致", async () => {
	const paths = fixture();
	const writeRoutes = routes(paths).filter((route) => route.name !== "GET");
	const cases = [
		{ label: "GET 打寫入路由", req: { method: "GET" }, status: 405 },
		{ label: "非 JSON content-type", req: { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" }, status: 415 },
		{ label: "壞掉的 JSON", req: { method: "POST", headers: { "content-type": "application/json" }, body: "{" }, status: 400 },
	];
	for (const route of writeRoutes) {
		for (const testCase of cases) {
			const res = fakeRes();
			await route.handler(fakeReq(testCase.req), res);
			assert.equal(res.statusCode, testCase.status, `${route.name}／${testCase.label}`);
		}
	}
});

test("信封：body 上限（改名 8KB、標題回報 64KB）", async () => {
	const paths = fixture();
	const big = JSON.stringify({ from: "a", to: "b", padding: "x".repeat(9000) });
	const res = fakeRes();
	await createRenameHandler({ sessionsRoot: paths.sessionsRoot, workspaceSlug: paths.workspaceSlug, ...paths })(fakeReq({ method: "POST", headers: { "content-type": "application/json" }, body: big }), res);
	assert.equal(res.statusCode, 400);
	assert.match(JSON.parse(res.body).error, /too large/u);

	// 標題回報走自己的上限：200 筆 × 約 140 bytes ≈ 28KB → 超過 8KB 但不到 64KB，必須成功。
	const applied = Array.from({ length: 200 }, (_, index) => ({
		sessionId: `session-${index}`,
		from: "x".repeat(60),
		to: `dsh-demo-${String(index).padStart(3, "0")}`,
	}));
	const titles = fakeRes();
	await createTitlesHandler({ sessionsRoot: paths.sessionsRoot, workspaceSlug: paths.workspaceSlug, ...paths })(fakeReq({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ applied }) }), titles);
	assert.equal(titles.statusCode, 200, "標題回報的上限不能被信封的 8KB 蓋掉");
});

test("信封：存檔失敗 → 500，而且不會假裝成功", async () => {
	const paths = fixture();
	// 把 store 路徑指到「一個檔案底下」→ mkdir 失敗，saveStore 回 ok:false。
	const blocker = join(paths.work, "blocker");
	writeFileSync(blocker, "not a directory\n", "utf8");
	const broken = { ...paths, aliasesFile: join(blocker, "aliases.json") };
	for (const route of routes(broken).filter((entry) => entry.name !== "GET")) {
		const res = fakeRes();
		await route.handler(fakeReq(route.req()), res);
		assert.equal(res.statusCode, 500, `${route.name} 存檔失敗要回 500`);
		assert.equal(JSON.parse(res.body).ok, false);
	}
});
