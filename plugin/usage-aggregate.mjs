/**
 * aggregate.mjs — DSH session log 的時段彙總（Task 2）。
 *
 * 這一支是整個插件唯一有真正邏輯的部分：把 `~/.dsh/sessions/<工作區>/<session>/session.v4.jsonl.zstd`
 * 內的 `assistant/message` 事件，按**本地時區**分到「本日／本週／本月」三桶。
 *
 * 三條設計紀律：
 *   1. 只讀 `data.usage`，**不讀** `data.stream`（同一筆用量會在兩處出現，讀兩次就重複計算）。
 *   2. **逐檔 try/catch**：日誌隨時在被追加，可能讀到截斷的 zstd frame；單檔失敗不可讓整行消失。
 *   3. 只回傳唯讀數字，不寫檔、不落日誌。
 *
 * 依據：`設計-常駐token-HUD.md` §5.2；實測（2026-10-16）全量 32 檔／14 MB 解壓＋解析約 105 ms。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { constants, zstdDecompressSync } from "node:zlib";

/**
 * 日誌檔名的形狀（**版本號不是常數**）。
 *
 * 上游是 `sessionFormatLogFilename(SESSION_FORMAT_VERSION)` 產生
 * `session.v<N>.jsonl[.zstd]`，並內建 migration；也就是說升版是預期事件。
 * 2026-10-16 獨立審查指出：寫死 `session.v4…` 的話，DSH 升到 v5 的那一天
 * 掃描會一個檔都找不到 → 三個時段全 0、HTTP 200、任何地方都不報錯。
 * 所以改成認形狀不認版本。
 */
export const SESSION_LOG_PATTERN = /^session\.v\d+\.jsonl\.zstd$/u;

/** Zstandard frame 的魔數（little-endian 讀出的 `0xFD2FB528`）。 */
const ZSTD_MAGIC = 0xfd2fb528;

/**
 * 掃出緩衝區內每一個**完整**的 Zstandard frame 範圍。
 *
 * 為什麼需要自己掃：DSH 的 session log 是**串接多個 frame**的容器（每個持久化批次一個
 * frame，且帶 checksum）。Node 的 `zstdDecompressSync` 對串接輸入的行為**依版本而異**：
 *   - Node 26：會解出全部 frame。
 *   - Node 24.18（Electron 44 內建，也就是 DSH App 實際使用的版本）：
 *     **只解第一個 frame，其餘靜默丟掉**。而第一個 frame 通常只有 session 標頭，
 *     結果就是整個 HUD 的日／週／月全部是 0（2026-10-16 實測，花了兩輪才定位）。
 * 所以必須逐 frame 解，不能整包丟給 `zstdDecompressSync`。
 *
 * 演算法逐行對照上游 `@deepseek-ai/dsh-session-persistence-jsonl` 的
 * `scanZstdFrames()`（同一份容器格式的權威實作），只去掉 `maxFrames` 參數。
 *
 * @param buffer - 檔案目前的所有位元組
 * @returns `{frames: Array<{start, end}>, tornStart?: number}`；
 *   `tornStart` 有值表示結尾有一個被截斷（正在被寫入）的 frame
 * @throws 結構損壞時（魔數不對、保留位元、保留區塊型別）丟出錯誤
 */
export function scanZstdFrames(buffer) {
	const frames = [];
	let offset = 0;
	while (offset < buffer.length) {
		const start = offset;
		if (buffer.length - offset < 4) return { frames, tornStart: start };
		if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
			throw new Error(`corrupt Zstandard session log: invalid frame magic at byte ${offset}`);
		}
		offset += 4;
		if (offset === buffer.length) return { frames, tornStart: start };
		const descriptor = buffer.readUInt8(offset);
		offset += 1;
		if ((descriptor & 24) !== 0) throw new Error(`corrupt Zstandard session log: reserved frame-header bit at byte ${offset - 1}`);
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
			if (blockType === 3) throw new Error(`corrupt Zstandard session log: reserved block type at byte ${offset - 3}`);
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
 * 把整個容器解成純文字：逐 frame 解壓後串接，並盡量救回被截斷的尾端 frame。
 *
 * 尾端 frame 用 `ZSTD_e_flush` 取「目前已寫入部分的明文」；這可能只得到半行 JSON，
 * 交給上層的逐行 `JSON.parse` 丟掉即可 —— 重要的是**前面完整的 frame 不能跟著陪葬**。
 * @param buffer - 檔案目前的所有位元組
 * @returns 解出的明文（解壓失敗的 frame 會被略過）
 */
function decodeZstdContainer(buffer) {
	const { frames, tornStart } = scanZstdFrames(buffer);
	let text = "";
	for (const { start, end } of frames) {
		try {
			text += zstdDecompressSync(buffer.subarray(start, end)).toString("utf8");
		} catch {
			// 單一 frame 解不開（理論上不該發生，因為掃描已驗證結構）就跳過它。
		}
	}
	if (tornStart !== undefined) {
		try {
			text += zstdDecompressSync(buffer.subarray(tornStart), { finishFlush: constants.ZSTD_e_flush }).toString("utf8");
		} catch {
			// 尾端 frame 連部分明文都拿不到（例如只寫了幾個位元組）就放棄它。
		}
	}
	return text;
}

/**
 * 取某個時段的起點（本地時區）。
 * @param {Date} now - 基準時間
 * @param {"day"|"week"|"month"} kind - 時段種類；`week` 以**週一**為首日（台灣慣例）
 * @returns {Date} 該時段的起點（本地 00:00:00.000）
 */
export function bucketStart(now, kind) {
	const date = new Date(now.getTime());
	if (kind === "day") {
		date.setHours(0, 0, 0, 0);
		return date;
	}
	if (kind === "week") {
		date.setHours(0, 0, 0, 0);
		// getDay()：0＝週日。換算成「距離本週週一幾天」。
		const daysSinceMonday = (date.getDay() + 6) % 7;
		date.setDate(date.getDate() - daysSinceMonday);
		return date;
	}
	if (kind === "month") {
		date.setHours(0, 0, 0, 0);
		date.setDate(1);
		return date;
	}
	throw new Error(`未知的時段種類：${String(kind)}`);
}

/** 把任何輸入收斂成有限非負數（日誌理論上不會有壞值，但壞值不該污染總額）。 */
function toCount(value) {
	const number = Number(value);
	return Number.isFinite(number) && number > 0 ? number : 0;
}

/**
 * 加總時間戳不早於 `sinceMs` 的紀錄。
 * @param {Array<object>} records - `UsageRecord[]`
 * @param {number} sinceMs - 起算毫秒時間戳（含）
 * @returns {{uncachedInput: number, cacheRead: number, cacheWrite: number, output: number, total: number}}
 */
export function sumRecords(records, sinceMs) {
	const totals = { uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0 };
	for (const record of records) {
		if (!(record.timeMs >= sinceMs)) continue;
		totals.uncachedInput += toCount(record.uncachedInput);
		totals.cacheRead += toCount(record.cacheRead);
		totals.cacheWrite += toCount(record.cacheWrite);
		totals.output += toCount(record.output);
	}
	totals.total = totals.uncachedInput + totals.cacheRead + totals.cacheWrite + totals.output;
	return totals;
}

/**
 * 一次算好本日／本週／本月三桶。
 * @param {Array<object>} records - `UsageRecord[]`
 * @param {Date} now - 基準時間（本地時區）
 * @returns {{today: object, week: object, month: object}}
 */
export function aggregate(records, now) {
	return {
		today: sumRecords(records, bucketStart(now, "day").getTime()),
		week: sumRecords(records, bucketStart(now, "week").getTime()),
		month: sumRecords(records, bucketStart(now, "month").getTime()),
	};
}

/**
 * 解壓並解析一份 session log。
 *
 * 壞檔（不是 zstd、結構損壞）回 `[]`，**不丟例外**；壞行逐行略過。
 * 內容是**串接多個 frame**的容器，逐 frame 解（見 `scanZstdFrames`）。
 * @param {Buffer} buffer - `session.v4.jsonl.zstd` 的原始位元組
 * @returns {Array<{timeMs: number, uncachedInput: number, cacheRead: number, cacheWrite: number, output: number, workspace?: string, session?: string}>}
 */
export function decodeSessionLog(buffer) {
	if (!buffer || buffer.length === 0) return [];
	let text;
	try {
		text = decodeZstdContainer(buffer);
	} catch {
		return [];
	}

	const records = [];
	for (const line of text.split("\n")) {
		if (line.length === 0) continue;
		let event;
		try {
			event = JSON.parse(line);
		} catch {
			continue;
		}
		if (event?.type !== "assistant/message") continue;
		const usage = event.data?.usage;
		if (usage === undefined || usage === null) continue;
		const timeMs = Number(event.time);
		if (!Number.isFinite(timeMs)) continue;
		records.push({
			timeMs,
			uncachedInput: toCount(usage.inputTokens),
			cacheRead: toCount(usage.cacheReadTokens),
			cacheWrite: toCount(usage.cacheWriteTokens),
			output: toCount(usage.outputTokens),
		});
	}
	return records;
}

/**
 * 某個工作區 slug 在 sessions 根目錄下是否存在。
 *
 * 用途：`scope: "workspace"` 時先確認 slug 真的存在，不存在就別回一份「看起來像 0 用量」的數字
 * （Electron App 的 `process.cwd()` 是 profile 目錄，推出來的 slug 一定不存在 —— 2026-10-16 獨立審查實測）。
 * @param sessionsRoot - sessions 根目錄
 * @param slug - 工作區目錄名（例如 `/work/my-project` → `--work-my-project--`）
 * @returns 存在且是目錄時回 true
 */
export function hasWorkspace(sessionsRoot, slug) {
	if (typeof slug !== "string" || slug === "") return false;
	try {
		return statSync(join(sessionsRoot, slug)).isDirectory();
	} catch {
		return false;
	}
}

/**
 * 掃描整個 `sessions` 目錄樹並回傳所有用量紀錄。
 *
 * 目錄形狀（實測有兩種 session 目錄名，故不依賴 `session-` 前綴）：
 *   `<sessionsRoot>/<workspaceSlug>/<sessionDir>/session.v4.jsonl.zstd`
 *
 * @param {string} sessionsRoot - 例如 `~/.dsh/sessions`
 * @param {{workspaceSlug?: string|null, cache?: Map, decode?: (buffer: Buffer) => Array<object>, stats?: object}} [options] -
 *   `workspaceSlug` 給值時只掃該工作區；`cache` 以「檔案路徑 → {mtimeMs, size, records}」跳過未變動的檔；
 *   `decode` 是 **test seam**（預設 `decodeSessionLog`），讓測試能直接數「到底解了幾次」；
 *   `stats` 是 out-param（呼叫端傳一個空物件進來，會被填上 `files`＝實際讀到的日誌檔數），
 *   用來區分「真的沒有用量」與「根本讀不到日誌（例如 DSH 升版換了檔名）」
 * @returns {Array<object>} `UsageRecord[]`（每筆帶 `workspace` 與 `session`）
 */
export function readUsageRecords(sessionsRoot, options = {}) {
	const { workspaceSlug = null, cache, decode = decodeSessionLog, stats } = options;
	const records = [];

	let slugs;
	try {
		slugs = readdirSync(sessionsRoot);
	} catch {
		return records;
	}

	for (const slug of slugs) {
		if (workspaceSlug !== null && slug !== workspaceSlug) continue;
		const slugPath = join(sessionsRoot, slug);

		let sessions;
		try {
			sessions = readdirSync(slugPath);
		} catch {
			continue;
		}

		for (const session of sessions) {
			let entries;
			try {
				entries = readdirSync(join(slugPath, session));
			} catch {
				continue;
			}

			for (const entry of entries.filter((name) => SESSION_LOG_PATTERN.test(name))) {
				const file = join(slugPath, session, entry);

				let stat;
				try {
					stat = statSync(file);
				} catch {
					continue;
				}
				if (!stat.isFile()) continue;
				if (stats !== undefined) stats.files = (stats.files ?? 0) + 1;

				const cached = cache?.get(file);
				if (cached !== undefined && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
					records.push(...cached.records);
					continue;
				}

				let buffer;
				try {
					buffer = readFileSync(file);
				} catch {
					// 單檔讀不到（權限、被搬動）不影響其他檔。
					continue;
				}

				const parsed = decode(buffer)
					.map((record) => ({ ...record, workspace: slug, session }))
					.filter((record) => record !== undefined);
				cache?.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, records: parsed });
				records.push(...parsed);
			}
		}
	}

	return records;
}
