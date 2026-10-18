/**
 * suggest.test.mjs — 「把舊對話整理進交接鏈」的建議演算法（純函式）。
 *
 * 這個功能只在**第一次接入**時跳一次，所以宁可少併、也不要亂併：
 * 測的重点是「不相干的不會黏在一起」「共同詞才分組」「不寫任何東西」。
 *
 * 用法：node --test scripts/suggest.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";

import { suggestChains, tokensOf } from "../plugin/suggest.mjs";

/** 造一場對話（只需要 id 與第一句話）。 */
const session = (id, firstLine) => ({ id, firstLine });

test("tokensOf：中文取相鄰二字、英文取詞，標點不進特徵", () => {
	const tokens = tokensOf("修好 Voicestudio 的拼音，謝謝！");
	assert.ok(tokens.has("voicestudio"), "英文詞要留");
	assert.ok(tokens.has("拼音"), "中文二字要留");
	assert.ok(!tokens.has("！"), "標點不算特徵");
});

test("tokensOf：常見開場語不會變成特徵（否則每場都黏在一起）", () => {
	const tokens = tokensOf("幫我 這個 可以");
	assert.equal(tokens.size, 0, `實際：${[...tokens].join(",")}`);
});

test("兩場共用一個夠特別的詞 → 建議併成一組", () => {
	const groups = suggestChains([
		session("a", "交接鏈的卡片壞了，要修"),
		session("b", "交接鏈的編號沒生效"),
		session("c", "今天天氣如何"),
	]);
	assert.equal(groups.length, 1);
	assert.equal(groups[0].size, 2);
	assert.deepEqual([...groups[0].sessionIds].sort(), ["a", "b"]);
	assert.ok("交接鏈".includes(groups[0].label) || groups[0].label.includes("交接"), `標籤：${groups[0].label}`);
});

test("每一組都帶一句範例（按「併入」之前要看得出在講什麼）", () => {
	const groups = suggestChains([session("a", "交接鏈的卡片壞了，要修"), session("b", "交接鏈的編號沒生效")]);
	assert.equal(groups.length, 1);
	assert.ok(groups[0].sample.includes("交接鏈"), `範例：${groups[0].sample}`);
});

test("沒有共同主題 → 不硬湊（寧可留在未標記）", () => {
	const groups = suggestChains([
		session("a", "幫我寫一份公文"),
		session("b", "影片知識庫怎麼用"),
		session("c", "ComfyUI 的模型下載"),
	]);
	assert.deepEqual(groups, []);
});

test("單獨一場不會被建議（minSize 預設 2）", () => {
	const groups = suggestChains([session("a", "交接鏈的卡片壞了")]);
	assert.deepEqual(groups, []);
});

test("大家都有的詞不算線索：三場都提同一個詞時仍可併，但四散的主題不會被拉進來", () => {
	const groups = suggestChains([
		session("a", "VoiceStudio 拼音發音測試"),
		session("b", "VoiceStudio 與 OmniVoice 比較"),
		session("c", "VoiceStudio 的發音修正"),
		session("d", "公文文號規則"),
	]);
	assert.equal(groups.length, 1);
	assert.deepEqual([...groups[0].sessionIds].sort(), ["a", "b", "c"]);
	assert.ok(!groups[0].sessionIds.includes("d"), "不相干的那場不能被拉進來");
});

test("同一場只會出現在一組（貪婪配對不會重複圈）", () => {
	const groups = suggestChains([
		session("a", "交接鏈卡片 自動編號"),
		session("b", "交接鏈卡片 壞了"),
		session("c", "自動編號 沒生效"),
	]);
	const all = groups.flatMap((group) => group.sessionIds);
	assert.equal(all.length, new Set(all).size, `重複了：${all.join(",")}`);
});

test("門檻可調：minSize=3 時只有兩場的組不會出現", () => {
	const sessions = [session("a", "交接鏈卡片"), session("b", "交接鏈編號")];
	assert.equal(suggestChains(sessions).length, 1);
	assert.equal(suggestChains(sessions, { minSize: 3 }).length, 0);
});

test("壞輸入不拋錯（空陣列、缺欄位、null）", () => {
	assert.deepEqual(suggestChains([]), []);
	assert.deepEqual(suggestChains(null), []);
	assert.deepEqual(suggestChains([{ id: "" }, null, { firstLine: "交接鏈" }]), []);
});
