/**
 * session-chains — 讀 DSH session log，抽出「每場對話的第一句話」與它屬於哪一條**交接鏈**。
 *
 * 這是 spike：只做一件事，但做對 —— 一條鏈有**兩個**可靠的痕跡：
 *   1. **接手**：交接提示詞是使用者貼進新對話的**第一則訊息**，它會原封不動落在該場對話的日誌裡。
 *   2. **交出**（2026-10-17 補）：第一個提出交接的那一場，自己會**產出**那份提示詞
 *      （助理訊息裡的一行 `鏈=<id>` 或舊式的 `接續 <id>`）→ 它也要算進這條鏈，
 *      否則面板只會顯示「交接後」的對話，鏈的頭一場不見了。
 *
 * 兩個沿用自 `dsh-token-hud/plugin/aggregate.mjs` 的硬知識（都是踩過的坑）：
 *   1. session log 是**串接多個 zstd frame** 的容器；Electron 的 Node 24.18 只解第一個 frame，
 *      其餘靜默丟掉 → 必須逐 frame 掃描、逐 frame 解。
 *   2. session 目錄名有兩種（`session-<uuid>` 與裸 `<uuid>`），所以不依賴前綴，
 *      只認「子目錄裡有 `session.v*.jsonl.zstd`」。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";

/** 日誌檔名（版本號不寫死，DSH 升 v5 也要讀得到）；版本號留捕獲組給下面排序用。 */
export const SESSION_LOG_PATTERN = /^session\.v(\d+)\.jsonl\.zstd$/u;

/** Zstandard frame 的魔數（little-endian 讀出的 `0xFD2FB528`）。 */
const ZSTD_MAGIC = 0xfd2fb528;

/**
 * 掃出緩衝區內每一個完整 Zstandard frame 的範圍。
 * 逐行對照上游 `@deepseek-ai/dsh-session-persistence-jsonl` 的 `scanZstdFrames()`。
 * @param buffer - 檔案目前的位元組
 * @returns `{frames: Array<{start, end}>, tornStart?: number}`
 */
export function scanZstdFrames(buffer) {
	const frames = [];
	let offset = 0;
	while (offset < buffer.length) {
		const start = offset;
		if (buffer.length - offset < 4) return { frames, tornStart: start };
		if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`corrupt zstd log: bad magic at ${offset}`);
		offset += 4;
		if (offset === buffer.length) return { frames, tornStart: start };
		const descriptor = buffer.readUInt8(offset);
		offset += 1;
		if ((descriptor & 24) !== 0) throw new Error(`corrupt zstd log: reserved frame-header bit at ${offset - 1}`);
		const contentSizeFlag = descriptor >>> 6;
		const singleSegment = (descriptor & 32) !== 0;
		const checksum = (descriptor & 4) !== 0;
		const dictionaryFlag = descriptor & 3;
		const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
		const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
		const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
		if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start };
		offset += remainingHeaderBytes;
		for (;;) {
			if (buffer.length - offset < 3) return { frames, tornStart: start };
			const blockHeader = buffer.readUIntLE(offset, 3);
			offset += 3;
			const lastBlock = (blockHeader & 1) !== 0;
			const blockType = (blockHeader >>> 1) & 3;
			const blockSize = blockHeader >>> 3;
			if (blockType === 3) throw new Error(`corrupt zstd log: reserved block type at ${offset - 3}`);
			const payloadBytes = blockType === 1 ? 1 : blockSize;
			if (buffer.length - offset < payloadBytes) return { frames, tornStart: start };
			offset += payloadBytes;
			if (lastBlock) break;
		}
		if (checksum) {
			if (buffer.length - offset < 4) return { frames, tornStart: start };
			offset += 4;
		}
		frames.push({ start, end: offset });
	}
	return { frames };
}

/**
 * 逐 frame 解成事件陣列（解不開的 frame 略過，不影響其他）。
 * @param buffer - 檔案位元組
 * @returns 事件物件陣列
 */
export function readEvents(buffer) {
	let text = "";
	try {
		const { frames } = scanZstdFrames(buffer);
		for (const frame of frames) {
			try {
				text += zstdDecompressSync(buffer.subarray(frame.start, frame.end)).toString("utf8");
			} catch {
				/* 壞掉的 frame 不拖累其他 */
			}
		}
	} catch {
		return [];
	}
	const events = [];
	for (const line of text.split("\n")) {
		if (line.length === 0) continue;
		try {
			events.push(JSON.parse(line));
		} catch {
			/* 尾端半行 */
		}
	}
	return events;
}

/** 把一則訊息的 content 攤平成純文字（多個 part 之間用空白接）。 */
function textOf(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => (typeof part === "string" ? part : typeof part?.text === "string" ? part.text : ""))
		.join(" ")
		.trim();
}

/**
 * 取「助理的**回答本文**」：只留 `part.type === "text"`（沒有 type 的舊格式也收），
 * 排除 `reasoning`（推理）與 `tool-call`（工具呼叫）。
 *
 * 為什麼一定要排除 reasoning（2026-10-17 實測踩到）：修正本文的過程中，
 * 助理推理裡**引用**了一行 `鏈=dsh-token-hud ← 這一行是給…` 當例子（整行就是標記），
 * 於是「本場自己就是 dsh-token-hud 的起點」——誤判。提示詞是使用者要複製的**回答本文**，
 * 推理與工具呼叫都不是。
 * @param content - 訊息 content（字串或 part 陣列）
 * @returns 回答本文（多個 part 之間用換行接）
 */
function answerTextOf(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part) => typeof part === "string" || part?.type === undefined || part.type === "text")
		.map((part) => (typeof part === "string" ? part : typeof part?.text === "string" ? part.text : ""))
		.join("\n");
}

/** 從事件陣列裡找第一則使用者訊息。 */
function firstUserText(events) {
	for (const event of events) {
		if (event?.type !== "user/message") continue;
		const data = event.data ?? {};
		const text =
			textOf(data.content) ||
			textOf(data.message?.content) ||
			(typeof data.text === "string" ? data.text : "");
		if (text !== "") return { text, timeMs: Number(event.time) };
	}
	return { text: "", timeMs: Number.NaN };
}

/** 從事件陣列裡找 session 的 cwd（標頭事件帶的）。 */
function cwdOf(events) {
	for (const event of events) {
		const candidate = event?.data?.cwd ?? event?.data?.header?.cwd ?? event?.header?.cwd;
		if (typeof candidate === "string" && candidate !== "") return candidate;
	}
	return null;
}

/**
 * 從事件陣列裡找**最後一筆** `session/title`（DSH 的標題投影就是「最後一筆為準」）。
 *
 * 為什麼要標題：自動編號要改的是**真的標題**，而「該不該改」取決於目前標題是什麼
 * —— 只寫差異（`from === to` 不寫）才不會每次輪詢都重寫一遍。
 * @param events - `readEvents()` 的結果
 * @returns `{title: string|null, titleSource: string|null}`
 */
function titleOf(events) {
	let title = null;
	let titleSource = null;
	for (const event of events) {
		if (event?.type !== "session/title") continue;
		const value = event?.data?.title;
		if (typeof value !== "string" || value.trim() === "") continue;
		title = value;
		const kind = event?.data?.source?.kind;
		titleSource = typeof kind === "string" && kind !== "" ? kind : null;
	}
	return { title, titleSource };
}

/**
 * 這一場最後選用的模型：`model/selection` 事件優先，沒有才退回最後一筆 `request/header`。
 *
 * 為什麼要它（2026-10-20 使用者回報）：自動交接開的新對話吃的是**部署預設模型**
 * （desktop profile 的 `agent-default-model`＝雲端 `deepseek-flash`），所以用本地模型的人
 * 一交接就變成雲端。新對話要沿用這一場的模型，面板就得先讀得到它 —— 模型選擇是
 * 「最後一筆為準」，與標題同一個道理。
 * @param events - `readEvents()` 的結果
 * @returns `{provider: string, model: string, reasoningEffort?: string}` 或 null
 */
export function modelOf(events) {
	/** 只收形狀完整的選擇；缺欄位或空字串一律當作沒有。 */
	const pick = (value) => {
		if (typeof value?.provider !== "string" || value.provider === "") return null;
		if (typeof value?.model !== "string" || value.model === "") return null;
		return {
			provider: value.provider,
			model: value.model,
			...(typeof value.reasoningEffort === "string" && value.reasoningEffort !== "" ? { reasoningEffort: value.reasoningEffort } : {}),
		};
	};
	let chosen = null;
	let header = null;
	for (const event of events) {
		if (event?.type === "model/selection") chosen = pick(event.data) ?? chosen;
		else if (event?.type === "request/header") header = pick(event?.data?.header?.config ?? event?.data?.config) ?? header;
	}
	return chosen ?? header;
}

/**
 * 抽出「鏈」代號：**交接的最強證據就是新對話的第一句話**。
 *
 * 判定順序（前者較可信）：
 *   1. 明確標記 `鏈=<id>`（交接提示詞會帶這一段，見 README）。
 *   2. 舊式交接提示詞的 `接續 <專案>`：要求專案名以英數字開頭（避免抓到「接續提示詞」這種字樣）。
 *   3. 第一句話裡的專案路徑 `30-CodingSkills/<name>`。
 * @param firstText - 該場對話的第一則使用者訊息
 * @returns `{chain: string|null, reason: string}`；`chain` 為 null 表示「未標記」
 */
export function extractChain(firstText) {
	const text = typeof firstText === "string" ? firstText : "";
	if (text.trim() === "") return { chain: null, reason: "no-first-message" };
	// 逐行、行首比對（與「交出」那一側同一套規則）：行內的順口提及不算。
	// 2026-10-17：原本這裡是**另一套寫死的英數 regex**，所以放寬 `ID_PATTERN` 之後
	// 中文代號仍然抓不到 —— 現在兩側共用同一組 pattern，不會再各走各的。
	for (const rawLine of text.split("\n")) {
		const line = undecorate(rawLine);
		const tagged = line.match(CHAIN_TAG_LINE);
		if (tagged !== null) return { chain: tagged[1], reason: "tag" };
		const resumed = line.match(RESUME_LINE);
		if (resumed !== null) return { chain: resumed[1], reason: "接續" };
	}
	const path = text.match(/30-CodingSkills\/([A-Za-z0-9][A-Za-z0-9._-]{0,59})/u);
	if (path !== null) return { chain: path[1], reason: "path" };
	return { chain: null, reason: "unmarked" };
}

/**
 * 鏈代號的形狀：**英數或中文**開頭，可含 `._-`，不可含空白與 `=`。
 *
 * 為什麼要放寬（2026-10-17）：使用者可以在面板上把代號改成中文（例：`模擬聲音工程`）。
 * 原本只吃 `[A-Za-z0-9]` 開頭 → 中文代號**整個抓不到**，正是使用者擔心的
 * 「改完之後無法抓取」。放寬的邊界刻意與 `aliases.mjs` 的 `normalizeName` 對齊。
 */
const ID_PATTERN = "[A-Za-z0-9\\u4e00-\\u9fff][A-Za-z0-9\\u4e00-\\u9fff._-]{0,59}";

/**
 * 提示詞裡「一行就是鏈標記」：`鏈=<id>`（可被粗體／code span／【】包住）。
 *
 * 行尾允許接一段**標點開頭**的尾巴，因為技能模板那一行原本長這樣：
 * `鏈=<專案代號>　← 這一行是給左側欄「交接鏈」面板自動分組用` —— 照模板寫會多出尾註。
 * 尾巴只收「不會被誤認成代號一部分」的標點（刻意**不含** `-`／`.`，否則
 * `鏈=dsh-token-hud 的規則…` 會退化成抓到 `dsh-token` 這一段）。
 */
const CHAIN_TAG_LINE = new RegExp(`^鏈\\s*=\\s*(${ID_PATTERN})(?:\\s*[（(【「：:，,。、←].*)?$`, "u");

/**
 * 舊式提示詞的第一行：`接續 <id>：…` 或 `接續 <id>（…）`。
 * 後面的分隔符不可省 —— 否則「接續 dsh-token-hud 的進度」這種順口提及會被誤判。
 */
const RESUME_LINE = new RegExp(`^接續\\s+(${ID_PATTERN})(?:[（(：:]|$)`, "u");

/**
 * 把一行剝掉 markdown 裝飾，回傳「這一行實際在講什麼」。
 *
 * 為什麼需要：提示詞裡的標記可能是 `鏈=x`、`**鏈=x**`、`- **鏈=x**`、`【鏈=x】`，
 * 但**行內的順口提及不算** —— 實測（2026-10-17）一場正在討論這件事的對話裡，
 * 「`鏈=dsh-token-hud`」這種字串在助理推理中出現 23 次，用「整場找字串」會全部誤判。
 * @param line - 原始的一行
 * @returns 剝掉裝飾後的文字
 */
export function undecorate(line) {
	let text = typeof line === "string" ? line.trim() : "";
	for (let round = 0; round < 4; round += 1) {
		const before = text;
		text = text
			.replace(/^(?:[-*+>#]+\s*)+/u, "")
			.replace(/^【\s*/u, "")
			.replace(/^[`*_]+/u, "")
			.replace(/[`*_]+$/u, "")
			.replace(/\s*】$/u, "")
			.trim();
		if (text === before) break;
	}
	return text;
}

/**
 * 抽出「這場對話自己交接出去」的鏈代號。
 *
 * 只看**助理訊息的回答本文**、且只看**整行就是標記**的行：
 *   - 使用者訊息＝別人貼進來的（那是「接手」，由 `extractChain` 負責）。
 *   - `reasoning`／`tool-call` 不算：推理會引用提示詞當例子、工具呼叫會寫檔（都會誤判）。
 *   - 同一場產出多次（草稿→定稿）時，**最後一次為準**。
 * @param events - `readEvents()` 的結果
 * @returns `{chain: string|null, reason: string, eventIndex: number}`
 */
export function extractOutChain(events) {
	if (!Array.isArray(events)) return { chain: null, reason: "no-events", eventIndex: -1 };
	let chain = null;
	let eventIndex = -1;
	events.forEach((event, position) => {
		if (event?.type !== "assistant/message") return;
		const data = event.data ?? {};
		const text =
			answerTextOf(data.content) ||
			answerTextOf(data.message?.content) ||
			(typeof data.text === "string" ? data.text : "");
		for (const rawLine of text.split("\n")) {
			const line = undecorate(rawLine);
			const tagged = line.match(CHAIN_TAG_LINE);
			const resumed = tagged === null ? line.match(RESUME_LINE) : null;
			const found = tagged?.[1] ?? resumed?.[1] ?? null;
			if (found !== null) {
				chain = found;
				eventIndex = position;
			}
		}
	});
	return { chain, reason: chain === null ? "no-handoff" : "handoff-out", eventIndex };
}

/**
 * 掃描 sessions 目錄樹，回傳每一場對話的鍵資訊（含鏈）。
 *
 * 每一場的鏈有兩種來源，都記在回傳值裡：
 *   - `chain`＝主要歸屬（有接手訊號就用接手的，否則用自己交出去的）；
 *   - `chains`＝**全部**歸屬（中繼場會有兩條）；
 *   - `handoffTo`＝這一場自己交接給哪一條鏈（＝它是那條鏈的起點）。
 *
 * 目錄形狀：`<sessionsRoot>/<workspaceSlug>/<sessionDir>/session.v*.jsonl.zstd`
 * @param sessionsRoot - 例如 `~/.dsh/sessions`
 * @param {{cache?: Map, workspaceSlug?: string|null}} [options] - `cache` 以「檔案路徑 → {mtimeMs,size,entry}」跳過未變動的檔
 * @returns `{sessions: Array<object>, files: number}`
 */
export function readSessions(sessionsRoot, options = {}) {
	const { cache, workspaceSlug = null } = options;
	const sessions = [];
	let files = 0;
	let slugs;
	try {
		slugs = readdirSync(sessionsRoot).filter((name) => {
			if (workspaceSlug !== null && workspaceSlug !== undefined && name !== workspaceSlug) return false;
			try {
				return statSync(join(sessionsRoot, name)).isDirectory();
			} catch {
				return false;
			}
		});
	} catch {
		return { sessions, files: 0 };
	}

	for (const slug of slugs) {
		let dirs;
		try {
			dirs = readdirSync(join(sessionsRoot, slug));
		} catch {
			continue;
		}
		for (const dir of dirs) {
			const dirPath = join(sessionsRoot, slug, dir);
			let logs;
			try {
				if (!statSync(dirPath).isDirectory()) continue;
				// 取版本號最大的那一份：字典序會把 `v10` 排在 `v4` 前面，格式升級後就會一直讀舊檔。
				logs = readdirSync(dirPath)
					.map((name) => ({ name, version: Number(SESSION_LOG_PATTERN.exec(name)?.[1]) }))
					.filter((log) => Number.isFinite(log.version))
					.sort((left, right) => right.version - left.version);
			} catch {
				continue;
			}
			if (logs.length === 0) continue;
			const file = join(dirPath, logs[0].name);
			let stat;
			try {
				stat = statSync(file);
			} catch {
				continue;
			}
			files += 1;
			const cached = cache?.get(file);
			if (cached !== undefined && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
				sessions.push(cached.entry);
				continue;
			}
			let entry;
			try {
				const events = readEvents(readFileSync(file));
				const first = firstUserText(events);
				// 接手（第一句話）優先；沒有接手的痕跡時，才用「自己交出去的鏈」當主要歸屬。
				const inbound = extractChain(first.text);
				const outbound = extractOutChain(events);
				const { title, titleSource } = titleOf(events);
				// 子代理（subagent）不是使用者會打開的對話：不編號、不該被改名。
				const subagent = events.some((event) => event?.type === "subagent/descriptor");
				// 「最後一次有動」＝最後一筆事件的時間（或檔案 mtime，取大的）。
				// 使用者定義：對話內容有更新才算，不是「最後一場開始」。
				const lastEventAt = events.reduce((max, event) => {
					const time = Number(event?.time);
					return Number.isFinite(time) && time > max ? time : max;
				}, 0);
				const lastActiveAt = Math.max(lastEventAt, Number(stat.mtimeMs) || 0);
				const chains = [];
				if (inbound.chain !== null) chains.push(inbound.chain);
				if (outbound.chain !== null && !chains.includes(outbound.chain)) chains.push(outbound.chain);
				entry = {
					id: dir,
					workspace: slug,
					cwd: cwdOf(events),
					chain: chains[0] ?? null,
					chainReason: inbound.chain !== null ? inbound.reason : outbound.reason,
					// 一場可能同時「接手 A」與「開出 B」（中繼場）→ 兩條鏈都要算。
					chains,
					// 這一場自己交接給哪一條鏈（＝它是那條鏈的起點）；沒有就 null。
					handoffTo: outbound.chain,
					firstLine: first.text.replace(/\s+/gu, " ").slice(0, 200),
					// 目前標題（最後一筆 session/title）——自動編號只寫差異要靠它。
					title,
					titleSource,
					// 這一場最後用的模型（交接時要沿用；新對話預設會吃部署的雲端模型）。
					model: modelOf(events),
					subagent,
					startedAt: Number.isFinite(first.timeMs) ? first.timeMs : stat.mtimeMs,
					// 最後活動時間（排序「最後」用；沒有事件時間就退回 startedAt）。
					lastActiveAt: lastActiveAt || (Number.isFinite(first.timeMs) ? first.timeMs : stat.mtimeMs),
					events: events.length,
					logBytes: stat.size,
				};
			} catch {
				continue;
			}
			cache?.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, entry });
			sessions.push(entry);
		}
	}
	sessions.sort((a, b) => a.startedAt - b.startedAt);
	return { sessions, files };
}

/**
 * 把 session 清單依鏈分組（組內按時間排序＝交接順序）。
 *
 * 一場對話可以同時出現在兩條鏈：**中繼場**接手了 A、又在同一場裡開出 B
 * （實例：2026-10-16 那場接了 `dsh-token-hud`、最後產出 `dsh-session-chains` 的提示詞）。
 * 只歸一條的代價是「新鏈的頭一場看不見」——那正是本函式要修的症狀。
 * @param sessions - `readSessions()` 的回傳
 * @returns 鏈陣列（未標記的集中在 `chain === null` 那一組）
 */
export function groupByChain(sessions) {
	const groups = new Map();
	for (const session of sessions) {
		const keys =
			Array.isArray(session.chains) && session.chains.length > 0 ? session.chains : [session.chain ?? ""];
		for (const key of new Set(keys.map((value) => value ?? ""))) {
			if (!groups.has(key)) groups.set(key, []);
			groups.get(key).push(session);
		}
	}
	return [...groups.entries()]
		.map(([key, list]) => ({
			chain: key === "" ? null : key,
			count: list.length,
			firstAt: list[0].startedAt,
			// 鏈的「最後」＝組內所有場次最後活動時間的最大值（不是最後一場的開始時間）。
			lastAt: list.reduce((max, session) => Math.max(max, Number(session.lastActiveAt) || Number(session.startedAt) || 0), 0),
			sessionIds: list.map((session) => session.id),
			sessions: list,
		}))
		.sort((a, b) => {
			if (a.chain === null) return 1;
			if (b.chain === null) return -1;
			return b.lastAt - a.lastAt;
		});
}
