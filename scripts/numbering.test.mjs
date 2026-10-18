/**
 * numbering.test.mjs — 自動編號的規則（Task 2）。
 *
 * 使用者的要求（2026-10-18 核可）：
 *   「同一條鏈的會話依時間順序真的改名成 模擬聲音工程-001、-002…；
 *     而且**手動把舊對話併進同一條鏈時，所有編號都可能要變動**。」
 * 所以這裡固定三件事：時間升冪、只回差異、一次太多場要先問。
 *
 * 用法：node --test scripts/numbering.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";

import { numberingLabel, planTitleSync } from "../plugin/numbering.mjs";

/** 造一場會話。 */
function session(id, startedAt, title = null) {
	return { id, startedAt, title };
}

/** 造一組（鏈）。 */
function group(chain, sessions) {
	return { chain, sessions };
}

test("numberingLabel：3 位補零，超過 999 自然 4 位", () => {
	assert.equal(numberingLabel("模擬聲音工程", 1), "模擬聲音工程-001");
	assert.equal(numberingLabel("模擬聲音工程", 42), "模擬聲音工程-042");
	assert.equal(numberingLabel("模擬聲音工程", 999), "模擬聲音工程-999");
	assert.equal(numberingLabel("模擬聲音工程", 1000), "模擬聲音工程-1000");
	assert.equal(numberingLabel("a", 0), "a-001", "0 或壞值收斂成 1");
});

test("編號：時間升冪、3 位補零（傳入順序不影響結果）", () => {
	const chains = [
		group("模擬聲音工程", [
			session("s4", 4000),
			session("s1", 1000),
			session("s3", 3000),
			session("s2", 2000),
		]),
	];
	const { items, total } = planTitleSync({ chains });
	assert.equal(total, 4);
	const byId = Object.fromEntries(items.map((item) => [item.sessionId, item.to]));
	assert.deepEqual(byId, {
		s1: "模擬聲音工程-001",
		s2: "模擬聲音工程-002",
		s3: "模擬聲音工程-003",
		s4: "模擬聲音工程-004",
	});
});

test("編號：已經正確的不進清單（idempotent）", () => {
	const chains = [
		group("模擬聲音工程", [
			session("s1", 1000, "模擬聲音工程-001"),
			session("s2", 2000, "模擬聲音工程-002"),
		]),
	];
	const { items, total } = planTitleSync({ chains });
	assert.equal(total, 0, "重抓不該再產生任何寫入");
	assert.deepEqual(items, []);
});

test("編號：中間插入一場 → 後面全部 +1，且由大到小套用（不互撞）", () => {
	const chains = [
		group("模擬聲音工程", [
			session("s1", 1000, "模擬聲音工程-001"),
			// s-new 時間在 s1 之後、s2 之前 → s2/s3 要各往後一號
			session("s-new", 1500, "原本的標題"),
			session("s2", 2000, "模擬聲音工程-002"),
			session("s3", 3000, "模擬聲音工程-003"),
		]),
	];
	const { items } = planTitleSync({ chains });
	assert.deepEqual(
		items.map((item) => item.to),
		["模擬聲音工程-004", "模擬聲音工程-003", "模擬聲音工程-002"],
		"由大到小：先改 004（原本 003）、再 003（原本 002）、最後 002（新的一場）",
	);
	assert.equal(items[0].sessionId, "s3");
	assert.equal(items[0].from, "模擬聲音工程-003");
});

test("編號：鏈改名 → 全部換前綴、號碼不動", () => {
	const chains = [
		group("新名字", [
			session("s1", 1000, "舊名字-001"),
			session("s2", 2000, "舊名字-002"),
			session("s3", 3000, "舊名字-003"),
		]),
	];
	const { items } = planTitleSync({ chains });
	const byId = Object.fromEntries(items.map((item) => [item.sessionId, item.to]));
	assert.deepEqual(byId, { s1: "新名字-001", s2: "新名字-002", s3: "新名字-003" });
});

test("編號：未標記（chain === null）一律不動", () => {
	const chains = [
		group("模擬聲音工程", [session("s1", 1000)]),
		group(null, [session("loose-1", 2000, "原本的標題"), session("loose-2", 3000)]),
	];
	const { items } = planTitleSync({ chains });
	assert.deepEqual(items.map((item) => item.sessionId), ["s1"]);
});

test("編號：**首次**編號不受上限阻擋（沒編號過的全部自動）", () => {
	const many = Array.from({ length: 12 }, (_, index) => session(`s${index}`, index * 1000));
	const plan = planTitleSync({ chains: [group("大鏈", many)] });
	assert.equal(plan.total, 12);
	assert.equal(plan.renumbered, 0, "一場都還沒編號過 → 不算重編");
	assert.equal(plan.needsConfirm, false, "首次 12 場也要自動套用（使用者選的是「自動」）");
});

test("編號：**重編**超過上限（預設 10 場）才要確認", () => {
	// 已經編過號、但中間插了一場 → 後面全部要位移 = 重編
	const numbered = Array.from({ length: 11 }, (_, index) =>
		session(`s${index}`, (index + 1) * 1000, `大鏈-${String(index + 1).padStart(3, "0")}`),
	);
	const withNew = [session("s-new", 500, "原本的標題"), ...numbered];
	const plan = planTitleSync({ chains: [group("大鏈", withNew)] });
	assert.equal(plan.total, 12, "12 場都要改（含新的一場）");
	assert.equal(plan.renumbered, 11, "11 場是「已經有號碼、但要換號」");
	assert.equal(plan.needsConfirm, true, "重編 11 場 > 10 → 先確認");

	const nine = numbered.slice(0, 10);
	const smaller = planTitleSync({ chains: [group("大鏈", [session("s-new", 500, "原本的標題"), ...nine])] });
	assert.equal(smaller.renumbered, 10);
	assert.equal(smaller.needsConfirm, false, "重編 10 場（含）以下自動");
	assert.equal(planTitleSync({ chains: [group("大鏈", [session("s-new", 500, "原本的標題"), ...nine])], maxAuto: 5 }).needsConfirm, true, "上限可調");
});

test("編號：有備份但已不在任何鏈 → restores 帶回原標題（取消歸鏈要還原）", () => {
	const chains = [
		group("模擬聲音工程", [session("s1", 1000, "模擬聲音工程-001")]),
		group(null, [session("loose", 2000, "模擬聲音工程-009")]),
	];
	const { restores } = planTitleSync({ chains, titles: { loose: "我原本的標題" } });
	assert.deepEqual(restores, [{ sessionId: "loose", from: "模擬聲音工程-009", to: "我原本的標題" }]);
});

test("編號：還原清單不會包含仍在鏈裡的場次（即使有備份）", () => {
	const chains = [group("模擬聲音工程", [session("s1", 1000, "模擬聲音工程-001")])];
	const { restores } = planTitleSync({ chains, titles: { s1: "原本" } });
	assert.deepEqual(restores, [], "還在鏈裡就不還原（那是編號的來源）");
});

test("編號：子代理跳過、也不佔號（使用者的編號不能出現空缺）", () => {
	const chains = [
		group("模擬聲音工程", [
			session("s1", 1000),
			{ ...session("sub", 2000), subagent: true },
			session("s2", 3000),
		]),
	];
	const { items } = planTitleSync({ chains });
	const byId = Object.fromEntries(items.map((item) => [item.sessionId, item.to]));
	assert.deepEqual(byId, { s1: "模擬聲音工程-001", s2: "模擬聲音工程-002" }, "子代理不佔 002");
});
