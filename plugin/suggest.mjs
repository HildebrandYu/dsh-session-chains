/**
 * suggest.mjs — 「把之前的對話整理進交接鏈」的**建議**（純函式，不寫任何東西）。
 *
 * 為什麼需要：交接鏈是為了省 token 才存在的，但**不是每個人都從第一天就在用**。
 * 一個已經聊了 40 場的人第一次裝上這個外掛，看到的是「未標記 36 場」——那反而更亂。
 * 所以第一次接入時要能**建議**怎麼併，由使用者按了才寫入（`sessionChains` 那張表）。
 *
 * 三個原則：
 *   1. **只建議、不動手**：回傳候選分組，寫入永遠是使用者按「併入」之後的事。
 *   2. **看得懂**：標籤取「這組共有的、夠少見的詞」，不是隨機挑一個。
 *   3. **寧可少併**：寧可留幾場在「未標記」，也不要把不相干的對話硬湊成一大條。
 */

/** 中文常用詞／開場語：這些字出現得再多也不代表同一個主題。 */
const STOP_TOKENS = new Set([
	"幫我", "我要", "我想", "這個", "那個", "可以", "什麼", "現在", "請問", "麻煩",
	"一下", "我們", "你們", "他們", "因為", "所以", "但是", "然後", "已經", "還是",
	"就是", "這樣", "那樣", "怎麼", "為什麼", "沒有", "不是", "知道", "看看", "使用",
	"工作", "問題", "東西", "事情", "需要", "應該", "開始", "完成", "確認",
]);

/** 中文斷詞不求精準，取「相鄰兩字」當特徵就夠了（這個功能只需要**建議**）。 */
const CJK = /[\u3400-\u9fff]/u;

/**
 * 把一句話變成特徵集合：ASCII 詞（≥3 字）＋ 中文相鄰二字。
 * @param text - 第一句話
 * @returns 特徵集合
 */
export function tokensOf(text) {
	const clean = String(text ?? "")
		.replace(/[`*_#>~[\]()（）「」『』、，。！？：；"']/gu, " ")
		.replace(/\s+/gu, " ")
		.trim();
	const tokens = new Set();
	for (const word of clean.match(/[A-Za-z][A-Za-z0-9_.-]{2,}/gu) ?? []) {
		if (!STOP_TOKENS.has(word.toLowerCase())) tokens.add(word.toLowerCase());
	}
	// 逐段取二字：整句一起取會生出「我這」「個可」這種跨詞碎片，
	// 停用詞表就永遠擋不乾淨（測試抓到的就是這個）。
	for (const chunk of clean.split(/\s+/u)) {
		const chars = [...chunk].filter((char) => CJK.test(char));
		// 二字＋三字：三字（例「交接鏈」「影片庫」）比二字具體得多，
		// 只取二字時「一個」「回答」這種碎片會被當成主題（真實資料上就是這樣）。
		for (const size of [2, 3]) {
			for (let index = 0; index + size <= chars.length; index += 1) {
				let gram = "";
				for (let offset = 0; offset < size; offset += 1) gram += chars[index + offset];
				// 開頭就是停用詞的片段（「幫我安」「一個好」）也不要：那只是把一句話切碎，
				// 不是主題（真實資料上真的會冒出「幫我安」這種標籤）。
				const noisy = [...STOP_TOKENS].some((stop) => gram.startsWith(stop));
				if (!noisy) tokens.add(gram);
			}
		}
	}
	return tokens;
}

/**
 * 建議怎麼把**未標記**的舊對話併成幾條鏈。
 *
 * 演算法（刻意簡單、可解釋）：
 *   1. 每場取第一句話的特徵；統計每個特徵出現在幾場（`df`）。
 *   2. 只留「至少幾場共有」且「不是大家都有的」特徵（太常見的詞沒有辨識力）。
 *   3. 由大到小貪婪配對：一個特徵圈出一組，已經被圈走的場次不再重複圈。
 *   4. 回傳的標籤就是那個特徵 —— 使用者看得懂「為什麼這幾場被放在一起」。
 * @param sessions - 未標記的場次（`{id, firstLine, title?}`）
 * @param options - `{minSize, maxGroups, maxShare, labelLength}`
 * @returns `Array<{label: string, sessionIds: string[], size: number, token: string}>`
 */
export function suggestChains(sessions, options = {}) {
	const minSize = Math.max(2, Number(options.minSize) || 2);
	const maxGroups = Math.max(1, Number(options.maxGroups) || 8);
	const maxShare = Number(options.maxShare) > 0 ? Number(options.maxShare) : 0.45;
	const labelLength = Math.max(4, Number(options.labelLength) || 12);
	// 內聚度門檻：太低就只是在「同一個字」上湊在一起（實測：github／skill／一個）。
	const cohesion = Number(options.cohesion) > 0 ? Number(options.cohesion) : 0.22;

	const items = (Array.isArray(sessions) ? sessions : [])
		.filter((session) => typeof session?.id === "string" && session.id !== "")
		.map((session) => ({ id: session.id, firstLine: String(session.firstLine ?? ""), tokens: tokensOf(session.firstLine) }));
	const total = items.length;
	if (total < minSize) return [];

	/** 特徵 → 出現它的場次（用 Set 去重，同一場只算一次）。 */
	const owners = new Map();
	for (const item of items) {
		for (const token of item.tokens) {
			if (!owners.has(token)) owners.set(token, new Set());
			owners.get(token).add(item.id);
		}
	}

	// 「大家都有」的詞不算線索，但小樣本（4 場裡 3 場）就是真的同一件事 ——
	// 所以下限是 minSize + 1：至少要比最小成團數再多一場，才排除得掉「全都一樣」。
	const limit = Math.max(minSize + 1, Math.ceil(total * maxShare));
	const candidates = [...owners.entries()]
		.filter(([, ids]) => ids.size >= minSize && ids.size <= limit)
		// 大的先併（覆蓋面大），同樣大時取較長的特徵（通常更具體）。
		.sort((left, right) => right[1].size - left[1].size || right[0].length - left[0].length);

	/**
	 * 兩場之間的重疊度：**取交集除以較短的那一邊**（containment），不是 Jaccard。
	 *
	 * 理由：一句話長、一句話短（「VoiceStudio 拼音測試」vs 一長串需求），Jaccard 會被長度稀釋到看不見；
	 * 但「短的那句有多少比例出現在長的那句裡」才是人眼判斷「同一件事」的方式。
	 */
	const overlapOf = (left, right) => {
		const a = items.find((item) => item.id === left)?.tokens ?? new Set();
		const b = items.find((item) => item.id === right)?.tokens ?? new Set();
		if (a.size === 0 || b.size === 0) return 0;
		let shared = 0;
		for (const token of a) if (b.has(token)) shared += 1;
		return shared / Math.min(a.size, b.size);
	};
	/**
	 * 這一組「像不像同一件事」：任兩場的平均重疊度。
	 * 只有一個共同詞（例如都提到 github／skill）的組會被刷掉 —— 那只是同一個字，不是同一個主題。
	 */
	const cohesionOf = (ids) => {
		if (ids.length < 2) return 0;
		let sum = 0;
		let pairs = 0;
		for (let i = 0; i < ids.length; i += 1) {
			for (let j = i + 1; j < ids.length; j += 1) {
				sum += overlapOf(ids[i], ids[j]);
				pairs += 1;
			}
		}
		return pairs === 0 ? 0 : sum / pairs;
	};

	const taken = new Set();
	const groups = [];
	for (const [token, ids] of candidates) {
		if (groups.length >= maxGroups) break;
		const fresh = [...ids].filter((id) => !taken.has(id));
		if (fresh.length < minSize) continue;
		// 把明顯不相干的一場踢掉：它跟這一組其他人的重疊度太低。
		const kept = fresh.filter((id) => {
			const others = fresh.filter((other) => other !== id);
			if (others.length < 1) return false;
			const average = others.reduce((sum, other) => sum + overlapOf(id, other), 0) / others.length;
			return average >= Math.max(0.02, cohesion * 0.5);
		});
		if (kept.length < minSize) continue;
		if (cohesionOf(kept) < cohesion) continue;
		for (const id of kept) taken.add(id);
		// 帶一句範例：使用者在按「併入」之前，要看得出來這一組到底在講什麼（避免併錯）。
		const sample = String(items.find((item) => item.id === kept[0])?.firstLine ?? "").replace(/\s+/gu, " ").slice(0, 46);
		groups.push({ label: token.slice(0, labelLength), token, sessionIds: kept, size: kept.length, sample });
	}
	return groups.sort((left, right) => right.size - left.size);
}
