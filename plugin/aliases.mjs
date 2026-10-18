/**
 * aliases.mjs — 「鏈代號改名」的對照表（舊代號 → 現在的名稱）。
 *
 * 為什麼是**對照表**而不是把舊資料改寫：
 *   鏈代號的唯一來源是**已經寫進 session log 的文字**（提示詞那一行 `鏈=<代號>`）。
 *   那些日誌是歷史，不該也不能改。所以改名＝登錄一條映射，分組時把舊代號映射到新名稱 ——
 *   既有對話、既有文件、既有記憶全部照舊抓得到，只是顯示成新名字。
 *
 * 檔案形狀（`.state/aliases.json`）：
 *   `{ "version": 1, "updatedAt": 1690000000000, "aliases": { "40-MediaProduction": "模擬聲音工程" } }`
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * 名稱合不合法。
 *
 * 限制的理由都是「抓取」：代號會被寫進提示詞的一行 `鏈=<代號>`，而解析是行首比對、
 * 遇到空白與 `=` 就停 —— 所以**空白與 `=` 一律不接受**，長度上限 60 與 `chains.mjs`
 * 的 `ID_PATTERN` 對齊。
 * @param value - 使用者輸入的名稱
 * @returns 收斂後的名稱；不合法回 null
 */
export function normalizeName(value) {
	if (typeof value !== "string") return null;
	const name = value.trim();
	if (name === "" || name.length > 60) return null;
	if (/[=\s\r\n\t]/u.test(name)) return null;
	return name;
}

/**
 * 把任一代號（可能是舊的）解析成現在的名稱。
 * @param chain - 代號（可能是 null）
 * @param aliases - 對照表
 * @returns 現在的名稱
 */
export function canonicalOf(chain, aliases) {
	if (typeof chain !== "string" || chain === "") return chain ?? null;
	let current = chain;
	// 有跳數上限，壞掉的對照表（環）也不會無限迴圈。
	for (let hop = 0; hop < 8; hop += 1) {
		const next = aliases?.[current];
		if (typeof next !== "string" || next === "" || next === current) break;
		current = next;
	}
	return current;
}

/**
 * 登錄一次改名。
 * @param aliases - 舊的對照表
 * @param from - 被改掉的代號（現在顯示的名稱）
 * @param to - 新名稱
 * @returns 新的對照表；`from === to` 時原樣回傳
 */
export function updateAliases(aliases, from, to) {
	const base = aliases !== null && typeof aliases === "object" ? aliases : {};
	if (from === to) return { ...base };
	const next = { ...base, [from]: to };
	// 讓所有原本指向 from 的舊代號直接跳到 to（不留兩段跳，免得對照表愈長愈亂）。
	for (const [key, value] of Object.entries(next)) {
		if (key !== from && value === from) next[key] = to;
	}
	return next;
}

/**
 * 把 session 清單的代號換成現在的名稱（保留原代號供顯示「舊代號」）。
 * @param sessions - `readSessions()` 的回傳
 * @param aliases - 對照表
 * @returns 新的 session 陣列（不改動傳進來的物件）
 */
export function applyAliases(sessions, aliases) {
	return sessions.map((session) => {
		const chainsRaw =
			Array.isArray(session.chains) && session.chains.length > 0
				? session.chains
				: session.chain === null || session.chain === undefined
					? []
					: [session.chain];
		const chains = [...new Set(chainsRaw.map((chain) => canonicalOf(chain, aliases)))];
		return {
			...session,
			chainRaw: session.chain ?? null,
			chainsRaw,
			chain: chains[0] ?? null,
			chains,
		};
	});
}

/**
 * 套用手動歸鏈（**這一張表會覆寫自動判定**）。
 *
 * 為什麼需要：使用者有一批**舊對話從來沒用過交接指令**，第一句話裡沒有 `鏈=`，
 * 也認不出「接續 <專案>」或專案路徑 → 全部落在「未標記」。它們其實是同一個話題，
 * 所以要有一個地方讓使用者自己指定：「這一場屬於那條鏈」。
 *
 * 覆寫的粒度是**整場**：指定之後 `chains` 只留指定值（不與自動判定並存），
 * 但 `chainRaw`／`chainsRaw` 原樣保留 —— 面板才顯示得出「它原本被判定成什麼」。
 *
 * **指定值也要過對照表**（2026-10-17 實測踩到）：使用者在面板上打的是「他記得的那個名字」，
 * 可能是舊代號。若不映射，`dsh-session-chains` 會自成一條**影子鏈**，跟改名後的
 * `交接鏈` 並存 —— 看起來就是「手動改了卻沒生效」。
 * @param sessions - `applyAliases()` 的回傳
 * @param sessionChains - `{ [sessionId]: 鏈名 }`（空字串或未指定＝不動）
 * @param aliases - 改名對照表（指定值也要映射；省略＝不映射）
 * @returns 新的 session 陣列
 */
export function applyAssignments(sessions, sessionChains, aliases = {}) {
	const table = sessionChains !== null && typeof sessionChains === "object" ? sessionChains : {};
	return sessions.map((session) => {
		const assigned = table[session.id];
		if (typeof assigned !== "string" || assigned === "") return session;
		const canonical = canonicalOf(assigned, aliases);
		return { ...session, assignedChain: canonical, chain: canonical, chains: [canonical] };
	});
}

/** 清掉壞值，只留「非空字串 → 非空字串」的項目。 */
function cleanMap(value) {
	const source = value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
	const clean = {};
	for (const [key, entry] of Object.entries(source)) {
		if (typeof key === "string" && key !== "" && typeof entry === "string" && entry !== "") clean[key] = entry;
	}
	return clean;
}

/**
 * 讀整份 store（三張表：改名對照表、手動歸鏈、原標題備份）。
 *
 * `titles`（2026-10-18）：自動編號會**真的改標題**，所以要留一份「被我們覆蓋前的原標題」，
 * 取消歸鏈時才還原得回去。只記第一次（重編的中間值不覆蓋它）。
 * @param file - store 路徑
 * @returns `{aliases, sessionChains, titles}`
 */
export function loadStore(file) {
	try {
		const parsed = JSON.parse(readFileSync(file, "utf8"));
		return {
			aliases: cleanMap(parsed?.aliases),
			sessionChains: cleanMap(parsed?.sessionChains),
			titles: cleanMap(parsed?.titles),
		};
	} catch {
		return { aliases: {}, sessionChains: {}, titles: {} };
	}
}

/**
 * 原子寫入整份 store（先寫暫存檔再 rename）。
 * @param file - store 路徑
 * @param store - `{aliases, sessionChains, titles}`
 * @returns `{ok: true}` 或 `{ok: false, error}`
 */
export function saveStore(file, store) {
	try {
		mkdirSync(dirname(file), { recursive: true });
		const temporary = `${file}.tmp-${process.pid}`;
		const payload = {
			version: 1,
			updatedAt: Date.now(),
			aliases: cleanMap(store?.aliases),
			sessionChains: cleanMap(store?.sessionChains),
			titles: cleanMap(store?.titles),
		};
		writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
		renameSync(temporary, file);
		return { ok: true };
	} catch (error) {
		return { ok: false, error: String(error?.message ?? error) };
	}
}

/**
 * 只讀改名對照表（向後相容的薄包裝）。
 * @param file - store 路徑
 * @returns 對照表物件
 */
export function loadAliases(file) {
	return loadStore(file).aliases;
}

/**
 * 只寫改名對照表（向後相容的薄包裝；**不會動到手動歸鏈那一張表**）。
 * @param file - store 路徑
 * @param aliases - 要寫的對照表
 * @returns `{ok: true}` 或 `{ok: false, error}`
 */
export function saveAliases(file, aliases) {
	const current = loadStore(file);
	// 第三張表（原標題備份）也要原樣帶回去，否則改名會把它洗掉。
	return saveStore(file, { aliases, sessionChains: current.sessionChains, titles: current.titles });
}

/**
 * 產生給人與 AI 看的對照表（`鏈代號.md`）。
 *
 * 為什麼要這份：AI 寫接續提示詞時要決定 `鏈=` 填什麼；這份檔案就是那個問題的答案，
 * 而且它由面板自動維護，不會與實際對照表不一致。
 * @param aliases - 對照表
 * @param chains - `groupByChain()` 的回傳（用來標場次數）
 * @param now - 時間戳（測試用）
 * @param sessionChains - 手動歸鏈那一張表（`{sessionId: 鏈名}`；空的話不多印一張表）
 * @returns markdown 字串
 */
export function renderRegistry(aliases, chains, now = Date.now(), sessionChains = {}) {
	// 這份檔要回答的問題是「**現在有哪幾條鏈、代號叫什麼**」，所以列的是
	// 「所有看得到的鏈」∪「對照表指到的名字」，**不是**只列改過名的（2026-10-18 補：
	// 舊版只印 `aliases` 的列 → 從沒改過名的鏈（`翻譯介面`／`DSH`／`dsh-token-hud`）
	// 完全不在表上，而 13.6 又說「代號以這份檔的現用名稱為準」→ 那三條查不到答案。
	const aliasEntries = Object.entries(aliases ?? {}).filter(
		([from, to]) => typeof from === "string" && typeof to === "string" && from !== "" && to !== "",
	);
	const countOf = new Map(
		(chains ?? [])
			.filter((group) => typeof group?.chain === "string" && group.chain !== "")
			.map((group) => [group.chain, Number(group.count) || 0]),
	);
	/** 現用名稱 → 它用過的舊代號（多個就全部列在同一列，不再各印一列）。 */
	const oldNames = new Map();
	for (const [from, to] of aliasEntries) {
		if (!oldNames.has(to)) oldNames.set(to, []);
		oldNames.get(to).push(from);
	}
	const names = [...new Set([...countOf.keys(), ...oldNames.keys()])].sort((left, right) => left.localeCompare(right, "zh-Hant"));
	const lines = [
		"# 鏈代號對照表",
		"",
		"> 由「交接鏈」面板**自動產生**（改名／歸鏈／套用編號時都會重寫這份）；手改會被覆蓋。",
		"> 這份表列出**所有**鏈（含從未改過名的）；「舊代號」是 `—` 表示這條鏈沒改過名。",
		"> 寫接續提示詞時，`鏈=` 填「**現用名稱**」那一欄；**舊代號仍然抓得到**（面板自動對照），",
		"> 所以既有的對話、交接單、記憶都不必回頭改。",
		"",
		`> 更新時間：${new Date(now).toISOString()}`,
		"",
		"| 現用名稱 | 舊代號（仍可抓取） | 目前場次 |",
		"|---|---|---|",
	];
	if (names.length === 0) lines.push("| （尚未有鏈） | | |");
	for (const name of names) {
		const from = (oldNames.get(name) ?? []).sort((left, right) => left.localeCompare(right, "zh-Hant"));
		const count = countOf.get(name);
		lines.push(`| ${name} | ${from.length === 0 ? "—" : from.join("、")} | ${count === undefined ? "—" : `${count} 場`} |`);
	}
	const assigned = Object.entries(sessionChains ?? {}).sort(([left], [right]) => left.localeCompare(right));
	if (assigned.length > 0) {
		lines.push(
			"",
			"## 手動歸鏈（覆寫自動判定）",
			"",
			"> 使用者在面板上自己指定到某條鏈的：**沒用過交接指令的舊對話**，或**中繼場**" +
				"（同時屬於兩條鏈）用「只留在這條」收斂到一條。面板會覆寫自動判定；留白＝還原。",
			"",
			"| session | 指定到 |",
			"|---|---|",
		);
		for (const [sessionId, chain] of assigned) lines.push(`| ${sessionId} | ${chain} |`);
	}
	lines.push("");
	return `${lines.join("\n")}\n`;
}
