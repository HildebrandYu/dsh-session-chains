/**
 * usage-route.mjs — 「餘額＋今日／本週／本月 token」的宿主半（原 `dsh-token-hud` 專案，2026-10-18 併入）。
 *
 * 為什麼併進來：使用者要「一個 skill」。原本 HUD 是獨立外掛（自己的路由 `/local/token-hud`），
 * 但它與交接鏈共用同一個插槽、同一組設定，分成兩個專案只會讓安裝與設定分岔。
 *
 * 這裡只留**可注入的純邏輯**：`createUsageHandler()`（路由）與 `createBalanceReader()`（餘額 TTL）。
 * 掛載在 `index.mjs` 的 `apply()`，路徑是 `/local/session-chains.usage`。
 *
 * 三條硬約束（原專案的實測結論，違反會影響 DSH 啟動或給出誤導數字）：
 *   - `deepseekAccount` **不可**寫進頂層 inject（缺席時 fiber 會永久掛起），只用 `ctx.get()`。
 *   - 任何例外都必須在路由內收斂，絕不可冒到頂層。
 *   - 路由只回唯讀彙總；無請求參數、不落任何日誌。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { aggregate, hasWorkspace, readUsageRecords } from "./usage-aggregate.mjs";



/** 路由路徑（精確比對；不加尾斜線）。 */
export const USAGE_PATH = "/local/session-chains.usage";

/** 送進 Platform 的預設語言標記（只影響 telemetry header，不影響餘額數值）。 */
const DEFAULT_CLIENT_LOCALE = "zh-TW";

/** `$DSH_HOME/sessions`（本機實測即 `~/.dsh/sessions`）。 */
function defaultSessionsRoot() {
	return join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "sessions");
}

/**
 * 複製 DSH 的 `projectKey()`：把 cwd 壓成 sessions 目錄所使用的工作區目錄名。
 * @param cwd - 工作區絕對路徑
 * @returns 例如 `/work/my-project` → `--work-my-project--`
 */
export function projectKey(cwd) {
	if (cwd.length === 0) return "--root--";
	let readable = "";
	let separatorRun = false;
	for (let index = 0; index < cwd.length; index += 1) {
		const code = cwd.charCodeAt(index);
		const character = String.fromCharCode(code);
		if (character === "/" || character === "\\" || character === ":") {
			if (!separatorRun) readable += "-";
			separatorRun = true;
		} else if (character !== "~" && /^[A-Za-z0-9._-]$/.test(character)) {
			readable += character;
			separatorRun = false;
		} else {
			readable += `~${code.toString(16).toUpperCase().padStart(4, "0")}`;
			separatorRun = false;
		}
	}
	return `--${(readable.replace(/^-+/, "") || "root").slice(0, 251)}--`;
}

/** 取 dsh 安裝版本（只進 telemetry header）。找不到時回 `"0.0.0"`，不影響餘額。 */
function detectVersion() {
	if (typeof process.env.DSH_VERSION === "string" && process.env.DSH_VERSION !== "") return process.env.DSH_VERSION;
	try {
		const resources = process.resourcesPath;
		if (typeof resources === "string" && resources !== "") {
			const manifest = JSON.parse(readFileSync(join(resources, "app.asar", "package.json"), "utf8"));
			if (typeof manifest.version === "string") return manifest.version;
		}
	} catch {
		// Electron 以外（或 asar 讀不到）就退回下面的固定值。
	}
	return "0.0.0";
}

/** `AccountClientMetadata`：`{version, locale, timezoneOffsetSeconds}`。 */
function defaultClientMetadata() {
	return {
		version: detectVersion(),
		locale: DEFAULT_CLIENT_LOCALE,
		timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
	};
}

/**
 * 取一次餘額。**任何失敗都回 `{status:"unavailable"}`，絕不回 0。**
 *
 * 實測（`dsh-deepseek-account-platform`）`getBalance()` 的回傳是三態：
 * `null`（未登入／授權失效）、`{status:"failed"}`（平台讀取失敗）、
 * `{status:"ready", value:[…], bonusWallets:[…]}`。三態都要分別處理。
 *
 * @param ctx - 任何有 `get(name)` 的宿主 context（缺席服務會拿到 undefined）
 * @param client - `AccountClientMetadata`
 * @returns `{status:"ready", wallets, bonusWallets}` 或 `{status:"unavailable"}`
 */
export async function fetchBalance(ctx, client = defaultClientMetadata()) {
	try {
		const account = ctx?.get?.("deepseekAccount");
		if (account === undefined || account === null || typeof account.getBalance !== "function") {
			return { status: "unavailable" };
		}
		const detail = await account.getBalance(client);
		// 空錢包清單＝平台沒給資料，不是「0 元」。當成 ready 會讓 HUD 顯示 0 餘額，
		// 而這條路由的契約是「絕不給出誤導數字」。
		if (
			detail === null ||
			detail === undefined ||
			detail.status !== "ready" ||
			!Array.isArray(detail.value) ||
			detail.value.length === 0
		) {
			return { status: "unavailable" };
		}
		const pick = (wallet) => ({ currency: wallet?.currency, balance: wallet?.balance });
		return {
			status: "ready",
			wallets: detail.value.map(pick),
			bonusWallets: Array.isArray(detail.bonusWallets) ? detail.bonusWallets.map(pick) : [],
		};
	} catch {
		// 服務拋錯、網路失敗、授權被拔 —— 一律 unavailable。
		return { status: "unavailable" };
	}
}

/**
 * 做一個帶 TTL 快取的餘額讀取器（避免每 5 秒輪詢都打 Platform）。
 *
 * 只有 `ready` 進快取：失敗結果**不快取**，這樣授權恢復或網路回穩時下一次輪詢就能成功。
 * @param options - `{ttlMs, now, client}`
 * @returns `(ctx) => Promise<balance>`
 */
export function createBalanceReader(options = {}) {
	const { ttlMs = 60000, now = () => Date.now(), client } = options;
	let cached;
	return async function readBalance(ctx) {
		if (cached !== undefined && now() - cached.atMs < ttlMs) return cached.value;
		const value = await fetchBalance(ctx, client ?? defaultClientMetadata());
		if (value.status === "ready") cached = { atMs: now(), value };
		return value;
	};
}


/**
 * 允許跨來源讀取的來源白名單。
 *
 * 為什麼需要：Desktop 的頁面 origin 是 `dsh-app://app`（**不是** 127.0.0.1），
 * 所以瀏覽器半的 `fetch("http://127.0.0.1:19387/local/token-hud")` 是跨來源請求。
 * 沒有 `access-control-allow-origin` 時，請求**打得到**宿主（診斷檔看得到），
 * 但瀏覽器不讓 JS 讀回應 —— fetch 直接 reject，畫面只會整行消失。
 * 2026-10-16 實測：元件 mount 了、每 5 秒都在打，但 `failed: true`、DOM 裡沒有那行。
 *
 * 白名單刻意收得很緊（**不是** `*`）：餘額屬於敏感資訊，不能讓任何一個使用者
 * 逛到的網頁讀走。只放行 App 自己的協定來源與回環 http 來源。
 * @param origin - 請求的 `Origin` 標頭
 * @returns 可以回填的來源字串，或 `null`（不回任何 CORS 標頭）
 */
export function allowedOrigin(origin) {
	if (typeof origin !== "string" || origin === "") return null;
	if (origin === "dsh-app://app") return origin;
	if (/^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/u.test(origin)) return origin;
	return null;
}

/**
 * 依白名單補上 CORS 標頭。不在白名單就什麼都不加（瀏覽器自然會擋掉讀取）。
 * @param req - 進來的請求
 * @param res - 要回應的物件
 */
function applyCors(req, res) {
	const origin = allowedOrigin(req?.headers?.origin);
	if (origin === null) return;
	try {
		res.setHeader("access-control-allow-origin", origin);
		res.setHeader("vary", "origin");
	} catch {
		// 回應物件不給設標頭就只能放棄（不影響主流程）。
	}
}

/**
 * 寫 JSON 回應。`ServerResponse` 由 handler 直接擁有。
 * @param res - node ServerResponse（或測試替身）
 * @param status - HTTP 狀態碼
 * @param payload - 會被 JSON.stringify 的物件
 */
function sendJson(res, status, payload) {
	try {
		res.statusCode = status;
		res.setHeader("content-type", "application/json; charset=utf-8");
		res.setHeader("cache-control", "no-store");
		res.end(JSON.stringify(payload));
	} catch {
		try {
			res.end();
		} catch {
			// 連 end 都失敗就只能放棄：不可讓例外冒到 webserver 的 dispatch。
		}
	}
}

/**
 * 診斷檔：把「瀏覽器有沒有真的打到這個路由」變成 bash 可查的事實（`cat .state/last-hit.json`）。
 *
 * 只在 config `diagnosticFile` 有值時寫；預設關閉，維持設計「不寫檔」的承諾。
 * @param file - 目標檔案路徑
 * @param req - 進來的請求（取 origin／referer／user-agent）
 * @param at - 本次呼叫的時間戳
 * @param ok - 這次是否成功產出回應
 * @param scan - `{sessionsRoot, records, monthTotal}` 掃描摘要（實作期用：一眼看出「為什麼是 0」）
 */
function writeDiagnostic(file, req, at, ok, scan) {
	try {
		const headers = req?.headers ?? {};
		const one = (value) => (Array.isArray(value) ? value.join(", ") : typeof value === "string" ? value : "");
		writeFileSync(
			file,
			JSON.stringify(
				{
					at,
					ok,
					origin: one(headers.origin),
					referer: one(headers.referer ?? headers.referrer),
					ua: one(headers["user-agent"]),
					url: typeof req?.url === "string" ? req.url : "",
					scan,
				},
				null,
				2,
			),
		);
	} catch {
		// 診斷檔寫不進去不該影響回應。
	}
}

/**
 * 造出路由 handler。
 *
 * 回傳 JSON 形狀（設計 §5.2；**不含** `session`，本場由瀏覽器端的投影負責）：
 * `{generatedAt, scope, totals:{today,week,month}, balance}`
 *
 * @param options - 全部可注入（測試用）：`sessionsRoot`／`scope`／`workspaceSlug`／`diagnosticFile`／
 *   `balanceReader`／`readRecords`／`cache`／`now`／`ctx`
 * @returns `(req, res) => Promise<void>`
 */
export function createUsageHandler(options = {}) {
	const {
		sessionsRoot = defaultSessionsRoot(),
		scope = "all",
		workspaceSlug = "",
		diagnosticFile = "",
		balanceReader = createBalanceReader({}),
		readRecords = readUsageRecords,
		cache = new Map(),
		now = () => Date.now(),
		ctx = undefined,
	} = options;

	return async function handler(req, res) {
		applyCors(req, res);
		try {
			const method = req?.method ?? "GET";
			if (method !== "GET" && method !== "HEAD") {
				sendJson(res, 405, { ok: false, error: "method not allowed" });
				return;
			}

			const stamp = now();
			const at = stamp instanceof Date ? stamp.getTime() : Number(stamp);

			// scope 解析。`workspace` 模式有兩條「會安靜給出誤導數字」的路，都要擋掉：
			//   1. slug 不存在（Electron App 的 cwd 是 profile 目錄，推出來的 slug 一定不存在）
			//   2. slug 存在但一個日誌檔都沒有（例如 DSH 升版換了檔名）
			// 兩者的正確答案都是「不知道」（回 totals: null，前端顯示 —），不是 0。
			const unresolvable = scope === "workspace" && !hasWorkspace(sessionsRoot, workspaceSlug);
			const stats = { files: 0 };
			const records = unresolvable
				? []
				: readRecords(sessionsRoot, {
						workspaceSlug: scope === "workspace" ? workspaceSlug : null,
						cache,
						stats,
					});
			const noLogs = !unresolvable && stats.files === 0;
			const totals = unresolvable || noLogs ? null : aggregate(records, new Date(at));
			const balance = await balanceReader(ctx);

			const payload = { generatedAt: at, scope, totals, files: stats.files, balance };
			if (unresolvable) payload.scopeError = `找不到工作區目錄：${workspaceSlug}`;
			else if (noLogs) payload.scopeError = "讀不到任何 session 日誌檔";

			if (diagnosticFile !== "") {
				writeDiagnostic(diagnosticFile, req, at, true, {
					sessionsRoot,
					records: records.length,
					files: stats.files,
					monthTotal: totals === null ? null : totals.month.total,
					scopeError: payload.scopeError ?? null,
				});
			}
			sendJson(res, 200, payload);
		} catch (error) {
			sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
		}
	};
}

