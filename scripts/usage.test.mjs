/**
 * usage.test.mjs — 餘額／用量路由的自動測試（原本完全沒有）。
 *
 * 這條路由的契約是「**絕不給出誤導數字**」：不知道就回 unavailable，讓前端顯示「—」，
 * 而不是回 0。三種平台回應（null／failed／ready）＋ 空錢包清單都要分別釘住，
 * 因為它們在畫面上長得一樣，錯了也沒人看得出來。
 *
 * 用法：node --test scripts/usage.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBalanceReader, createUsageHandler, fetchBalance } from "../plugin/usage-route.mjs";

/** 假的宿主 context：只需要 `get("deepseekAccount")`。 */
function ctxWith(getBalance) {
	return { get: (name) => (name === "deepseekAccount" ? { getBalance } : undefined) };
}

/** 假的 ServerResponse：記下 statusCode 與 JSON body。 */
function fakeRes() {
	const res = {
		statusCode: 0,
		headers: {},
		body: "",
		setHeader(name, value) {
			res.headers[String(name).toLowerCase()] = value;
		},
		end(chunk) {
			res.body += chunk ?? "";
		},
	};
	return res;
}

test("錢包清單是空的 → unavailable（不可顯示成 0 元）", async () => {
	const result = await fetchBalance(ctxWith(async () => ({ status: "ready", value: [], bonusWallets: [] })));
	assert.deepEqual(result, { status: "unavailable" });
});

test("未登入（null）與 failed 都是 unavailable", async () => {
	assert.deepEqual(await fetchBalance(ctxWith(async () => null)), { status: "unavailable" });
	assert.deepEqual(await fetchBalance(ctxWith(async () => ({ status: "failed" }))), { status: "unavailable" });
	// 服務本身拋錯也不能冒出去
	assert.deepEqual(
		await fetchBalance(
			ctxWith(async () => {
				throw new Error("boom");
			}),
		),
		{ status: "unavailable" },
	);
});

test("失敗不快取：第二次仍然打平台", async () => {
	let calls = 0;
	const read = createBalanceReader({
		ttlMs: 60000,
		ctx: undefined,
		now: () => 1000,
	});
	const ctx = ctxWith(async () => {
		calls += 1;
		return { status: "failed" };
	});
	await read(ctx);
	await read(ctx);
	assert.equal(calls, 2);
});

test("成功進快取：TTL 內第二次不再打平台", async () => {
	let calls = 0;
	const ctx = ctxWith(async () => {
		calls += 1;
		return { status: "ready", value: [{ currency: "CNY", balance: 1.5 }], bonusWallets: [] };
	});
	const read = createBalanceReader({ ttlMs: 60000, now: () => 1000 });
	const first = await read(ctx);
	const second = await read(ctx);
	assert.equal(calls, 1);
	assert.deepEqual(second, first);
	assert.equal(first.wallets[0].balance, 1.5);
});

test("工作區不存在時回 totals: null 與 scopeError，不回 0", async () => {
	const root = mkdtempSync(join(tmpdir(), "usage-test-"));
	const handler = createUsageHandler({
		sessionsRoot: root,
		scope: "workspace",
		workspaceSlug: "not-there",
		balanceReader: async () => ({ status: "unavailable" }),
		readRecords: () => [],
	});
	const res = fakeRes();
	await handler({ method: "GET", headers: {} }, res);
	assert.equal(res.statusCode, 200);
	const payload = JSON.parse(res.body);
	assert.equal(payload.totals, null);
	assert.equal(typeof payload.scopeError, "string");
});
