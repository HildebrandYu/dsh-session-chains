/**
 * numbering.mjs — 自動編號的**純函式**（不碰 I/O、不碰 DOM）。
 *
 * 為什麼規則是「推導」而不是「發號碼牌」：
 *   使用者整理的方式是「把舊對話併進某一條鏈」，這一動作會讓那條鏈**後面每一場的號碼都位移**。
 *   所以編號永遠是「以目前分組 + 時間順序重新推導」，而不是記住誰拿過幾號；
 *   要改的只有「和推導結果不同的那幾場」。
 *
 * 三個不變條件（測試都固定住了）：
 *   1. 只處理已歸鏈的會話（`chain !== null`）；未標記一律不動。
 *   2. 只回**差異**（`from === to` 不進清單）→ 同一份資料重算不會重寫、不會閃。
 *   3. `items` 依號碼**由大到小**排序 → 中間插入時逐一往後推，過程不會互撞。
 */

/**
 * 產生一個編號標籤：`模擬聲音工程`, 3 → `模擬聲音工程-003`。
 * @param chainName - 鏈的現用名稱
 * @param index - 1 起算的序號
 * @returns 標籤字串（3 位補零；超過 999 自然 4 位）
 */
export function numberingLabel(chainName, index) {
	const position = Math.max(1, Math.floor(Number(index) || 1));
	return `${chainName}-${String(position).padStart(3, "0")}`;
}

/**
 * 這個標題看起來已經被編過號了嗎（`<任何>-001` 這種結尾）？
 *
 * 用途：分辨「**首次編號**」與「**重編**」。首次編號是功能的第一次套用（使用者要的是自動），
 * 重編才是「號碼在你眼前位移」——後者才需要先確認。
 * @param title - 目前標題
 * @returns 是否已像編號
 */
function looksNumbered(title) {
	return typeof title === "string" && /-\d{3,}$/u.test(title);
}

/**
 * 排序鍵：時間升冪；同時間用 id 決勝（否則每次輪詢順序可能不穩，號碼會跳）。
 * @param a - 會話
 * @param b - 會話
 * @returns 比較結果
 */
function compareSessions(a, b) {
	const at = Number(a?.startedAt ?? 0) - Number(b?.startedAt ?? 0);
	if (at !== 0) return at;
	return String(a?.id ?? "").localeCompare(String(b?.id ?? ""));
}

/**
 * 算出「誰該叫什麼」。
 *
 * @param {{chains?: Array<{chain: string|null, sessions: Array<object>}>,
 *          titles?: Record<string, string>,
 *          maxAuto?: number}} [input] - 分組結果、原標題備份、自動套用上限
 * @returns {{items: Array<{sessionId: string, from: string|null, to: string, chain: string}>,
 *            total: number, renumbered: number, needsConfirm: boolean,
 *            restores: Array<{sessionId: string, from: string|null, to: string}>}}
 *   `needsConfirm` 只在「**重編**（已經有號碼又要換）超過上限」時為 true；
 *   首次編號（一場都還沒號碼）一律自動。
 */
export function planTitleSync(input = {}) {
	const chains = Array.isArray(input.chains) ? input.chains : [];
	const titles = input.titles !== null && typeof input.titles === "object" ? input.titles : {};
	const maxAuto = Number.isFinite(Number(input.maxAuto)) ? Math.max(1, Math.floor(Number(input.maxAuto))) : 10;

	/** 全部會話（含未標記）——還原時要拿它查「目前叫什麼」。 */
	const byId = new Map();
	for (const group of chains) {
		for (const session of group?.sessions ?? []) {
			if (typeof session?.id === "string" && session.id !== "") byId.set(session.id, session);
		}
	}

	const pending = [];
	for (const group of chains) {
		const name = group?.chain;
		if (typeof name !== "string" || name === "") continue;
		// 未標記那一組的 `chain` 是 null，上面已經跳過。
		// 子代理不是使用者會打開的對話 → 跳過、也**不佔號**（否則使用者的編號會出現空缺）。
		const sessions = [...(group.sessions ?? [])].filter((session) => session?.subagent !== true).sort(compareSessions);
		sessions.forEach((session, position) => {
			if (typeof session?.id !== "string" || session.id === "") return;
			const to = numberingLabel(name, position + 1);
			const current = typeof session.title === "string" && session.title !== "" ? session.title : null;
			if (current === to) return;
			pending.push({ sessionId: session.id, from: current, to, chain: name, position });
		});
	}
	// 由大到小：中間插入時先改「已經是最後一號」那幾場，逐一往後推。
	pending.sort((left, right) => {
		if (left.chain !== right.chain) return left.chain.localeCompare(right.chain);
		return right.position - left.position;
	});
	const items = pending.map(({ sessionId, from, to, chain }) => ({ sessionId, from, to, chain }));

	// 「首次編號」不算重編：只有**已經有號碼**的場次要換號時才算（那才是會讓人眼花的情況）。
	const renumbered = pending.filter(
		(entry) => looksNumbered(entry.from) || typeof titles[entry.sessionId] === "string",
	).length;

	// 有備份、但已經不在任何鏈（被取消歸鏈）→ 還原成原標題。
	const inChain = new Set(items.map((item) => item.sessionId));
	for (const group of chains) {
		if (typeof group?.chain === "string") {
			for (const session of group.sessions ?? []) if (typeof session?.id === "string") inChain.add(session.id);
		}
	}
	const restores = [];
	for (const [sessionId, original] of Object.entries(titles)) {
		if (inChain.has(sessionId)) continue;
		if (typeof original !== "string" || original === "") continue;
		const current = byId.get(sessionId)?.title ?? null;
		if (current === original) continue;
		restores.push({ sessionId, from: current, to: original });
	}

	return { items, total: items.length, renumbered, needsConfirm: renumbered > maxAuto, restores };
}
