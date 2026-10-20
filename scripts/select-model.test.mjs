/**
 * select-model.test.mjs — 「把這一場的模型套到新對話」路由的自動測試（2026-10-20）。
 *
 * 為什麼會有這支：0.1.6 走瀏覽器的 `ctx.remote.session.selectModel`，實機上沒生效
 * （新場次的日誌沒有 `model/selection`，第一筆請求仍是雲端），而失敗是靜音的。
 * 0.1.7 改成宿主路由：直接呼叫 `sessionController.selectModel`（與 UI 同一個方法），
 * 成功失敗都回得出原因。這支把路由的契約釘住。
 *
 * 用法：node --test scripts/select-model.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createSelectModelHandler, SELECT_MODEL_PATH } from "../plugin/index.mjs";

/** 假的 IncomingMessage：只實作路由會用到的部分。 */
function fakeReq({ method = "POST", headers = {}, body = "" } = {}) {
	return {
		method,
		headers,
		async *[Symbol.asyncIterator]() {
			if (body !== "") yield Buffer.from(body, "utf8");
		},
	};
}

/** 假的 ServerResponse：記下 statusCode 與 JSON body。 */
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

/** 送出一個 JSON POST 並回傳解析後的回應 body。 */
async function post(handler, payload) {
	const res = fakeRes();
	await handler(
		fakeReq({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }),
		res,
	);
	return { status: res.statusCode, body: JSON.parse(res.body) };
}

test("路由存在且是 /local/session-chains.select-model", () => {
	assert.equal(SELECT_MODEL_PATH, "/local/session-chains.select-model");
});

test("成功：把 sessionId／provider／model／reasoningEffort 原樣交給 sessionController", async () => {
	const calls = [];
	const handler = createSelectModelHandler({
		getController: () => ({
			selectModel: async (request) => {
				calls.push(request);
				return { selected: { provider: request.provider, model: request.model } };
			},
		}),
	});
	const result = await post(handler, { sessionId: "s-new", provider: "rapid-mlx-worker", model: "qwen3.5-35b-4bit", reasoningEffort: "medium" });
	assert.equal(result.status, 200);
	assert.equal(result.body.ok, true);
	assert.deepEqual(calls[0], { sessionId: "s-new", provider: "rapid-mlx-worker", model: "qwen3.5-35b-4bit", reasoningEffort: "medium" });
});

test("沒有 reasoningEffort 就不傳（不要送 undefined 給宿主）", async () => {
	const calls = [];
	const handler = createSelectModelHandler({
		getController: () => ({ selectModel: async (request) => (calls.push(request), { selected: {} }) }),
	});
	await post(handler, { sessionId: "s-new", provider: "rapid-mlx", model: "qwen3.8-27b-4bit" });
	assert.deepEqual(calls[0], { sessionId: "s-new", provider: "rapid-mlx", model: "qwen3.8-27b-4bit" });
	assert.equal("reasoningEffort" in calls[0], false);
});

test("缺欄位 → 400，不會呼叫宿主", async () => {
	let called = 0;
	const handler = createSelectModelHandler({ getController: () => ({ selectModel: async () => void (called += 1) }) });
	for (const payload of [{}, { sessionId: "s" }, { sessionId: "s", provider: "p" }, { provider: "p", model: "m" }]) {
		const result = await post(handler, payload);
		assert.equal(result.status, 400);
		assert.equal(result.body.ok, false);
	}
	assert.equal(called, 0);
});

test("宿主沒有 sessionController → 503（前端才知道要退回 Remote）", async () => {
	const handler = createSelectModelHandler({ getController: () => null });
	const result = await post(handler, { sessionId: "s", provider: "p", model: "m" });
	assert.equal(result.status, 503);
	assert.equal(result.body.ok, false);
});

test("宿主拒絕（模型不可用）→ 500 並帶回原因", async () => {
	const handler = createSelectModelHandler({
		getController: () => ({
			selectModel: async () => {
				throw new Error("session/model-unavailable: no such model");
			},
		}),
	});
	const result = await post(handler, { sessionId: "s", provider: "p", model: "m" });
	assert.equal(result.status, 500);
	assert.equal(result.body.ok, false);
	assert.match(String(result.body.error), /model-unavailable/u);
});

test("非 POST → 405；OPTIONS → 204（CORS preflight）", async () => {
	const handler = createSelectModelHandler({ getController: () => ({ selectModel: async () => ({}) }) });
	const getRes = fakeRes();
	await handler(fakeReq({ method: "GET" }), getRes);
	assert.equal(getRes.statusCode, 405);
	const optionsRes = fakeRes();
	await handler(fakeReq({ method: "OPTIONS" }), optionsRes);
	assert.equal(optionsRes.statusCode, 204);
});
