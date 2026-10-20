/**
 * session-chains — 宿主半（host half）
 *
 * 只做一件事：掃 `~/.dsh/sessions`，把每場對話的第一句話抽出來、判斷它屬於哪一條**交接鏈**，
 * 再用一個唯讀路由 `GET /local/session-chains` 餵給瀏覽器半的面板。
 *
 * 三條硬約束照抄 `dsh-token-hud` 的實測結論（違反會影響 DSH 啟動或看到假資料）：
 *   - `apply(ctx, config)` 的 config 是**第二個參數**（`ctx.config` 會拋 without inject）。
 *   - `webServer` 用巢狀 `ctx.inject` 取得；任何例外都必須在路由與 apply 內收斂。
 *   - 路由必須回 CORS 白名單標頭：頁面 origin 是 `dsh-app://app`，fetch 是跨來源。
 */
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { applyAliases, applyAssignments, canonicalOf, loadStore, normalizeName, renderRegistry, saveStore, toggleInList, updateAliases } from "./aliases.mjs";
import { groupByChain, readSessions } from "./chains.mjs";
import { planTitleSync } from "./numbering.mjs";
import { suggestChains } from "./suggest.mjs";
import { USAGE_PATH, createBalanceReader, createUsageHandler } from "./usage-route.mjs";

export const name = "session-chains";

/** 讀取路由（精確比對；不加尾斜線）。 */
export const ROUTE_PATH = "/local/session-chains";

/** 改名路由（POST；只收 application/json）。 */
export const RENAME_PATH = "/local/session-chains.rename";

/** 歸鏈路由（POST；把一場對話手動指定到某條鏈 —— 給「從來沒用過交接指令」的舊對話）。 */
export const ASSIGN_PATH = "/local/session-chains.assign";

/** 置頂（`{chain, on}`；寫進 store 的 `pinned`）。 */
export const PIN_PATH = "/local/session-chains.pin";

/** 封存（`{chain, on}`；寫進 store 的 `archived`）。只在面板的封存庫裡看得到。 */
export const ARCHIVE_PATH = "/local/session-chains.archive";

/** 標題回報路由（POST；瀏覽器套用完編號後回報，宿主記原標題備份）。 */
export const TITLES_PATH = "/local/session-chains.titles";

/** 接續提示詞檔案（AI 在交接時寫入；面板的「交接→新對話」讀它）。 */
export const NEXT_PROMPT_PATH = "/local/session-chains.next-prompt";

/**
 * 選模型路由（POST `{sessionId, provider, model, reasoningEffort?}`）。
 *
 * 為什麼要走宿主（2026-10-20 第二次修）：新對話預設吃部署的雲端模型，交接要把它改成
 * 這一場的模型。瀏覽器端只能透過 `ctx.remote.session.selectModel`，但外掛 ctx 不一定有
 * remote，而且失敗是靜音的 —— 使用者只會看到「又跳回雲端」。宿主這裡直接呼叫
 * `sessionController.selectModel`（同一個 in-process 方法），成功失敗都回得出原因。
 */
export const SELECT_MODEL_PATH = "/local/session-chains.select-model";

/** 專案根目錄＝本檔的上一層（`plugin/index.mjs` → 專案根）。 */
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * 狀態要放哪裡（`aliases.json`、`next-prompt.txt`、`鏈代號.md`）。
 *
 * 開發時（本機 `file://` 直掛）就放專案根，行為跟以前完全一樣。
 * 但從插件市場／`dsh plugin add` 安裝時，專案根在 `node_modules/` 裡 —— 升級或重裝會整包換掉，
 * 鏈的代號與手動歸鏈會跟著消失。所以**偵測到自己在 node_modules 底下就改住 `$DSH_HOME/session-chains`**，
 * 讓狀態活得比套件久。`SESSION_CHAINS_HOME` 可以整個蓋掉這個判斷。
 */
const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), ".dsh");
const INSTALLED = PROJECT_ROOT.split(sep).includes("node_modules");
const STATE_ROOT = process.env.SESSION_CHAINS_HOME ?? (INSTALLED ? join(DSH_HOME, "session-chains") : PROJECT_ROOT);

/**
 * 版本號：面板標題旁會顯示 `v0.1.7`。
 * 存在的理由很實際 —— 改了瀏覽器端之後，最常見的失敗是「頁面還跑舊的 bundle」，
 * 有這一行就一眼看得出來（不必猜是不是程式沒生效）。
 */
function packageVersion() {
	try {
		const manifest = JSON.parse(readFileSync(join(PROJECT_ROOT, "package.json"), "utf8"));
		return typeof manifest?.version === "string" ? manifest.version : "";
	} catch {
		return "";
	}
}

/** 對照表預設路徑（改名寫在這裡；放在 `.state/`，不碰工作區其他檔案）。 */
export const DEFAULT_ALIASES_FILE = join(STATE_ROOT, ".state", "aliases.json");

/** 接續提示詞的預設檔案（放在 `.state/`，不碰工作區其他檔案）。 */
export const DEFAULT_NEXT_PROMPT_FILE = join(STATE_ROOT, ".state", "next-prompt.txt");

/** 對照表 md 的預設路徑（給人與 AI 看）。 */
export const DEFAULT_REGISTRY_FILE = join(STATE_ROOT, "鏈代號.md");

/**
 * Config：手寫 standard-schema（不 import `@deepseek-ai/schemastery`——本插件由工作區的
 * `file://` 路徑掛載，裸名解析不到，import 失敗整個插件就掛掉）。
 * @default sessionsRoot ""（＝用 DSH_HOME/sessions）、workspaceSlug ""（＝所有工作區）
 */
export const Config = {
	"~standard": {
		vendor: "session-chains",
		version: 1,
		/**
		 * 驗證並補齊預設值（壞值一律收斂成預設，不讓插件掛掉）。
		 * @param value - 補丁裡給的原始 config
		 * @returns `{value}`
		 */
		validate(value) {
			const input = value !== null && typeof value === "object" ? value : {};
			const sessionsRoot = typeof input.sessionsRoot === "string" ? input.sessionsRoot : "";
			const workspaceSlug = typeof input.workspaceSlug === "string" ? input.workspaceSlug : "";
			// 一次要重編超過這麼多場就先不自動套用（等使用者按「套用」）。
			const maxAuto = Number.isFinite(Number(input.maxAuto)) && Number(input.maxAuto) > 0 ? Math.floor(Number(input.maxAuto)) : 10;
			// 餘額快取（毫秒）：0 也合法（每次都問平台）。原 dsh-token-hud 的預設是 60 秒。
			const ttl = Number(input.balanceTtlMs);
			const balanceTtlMs = Number.isFinite(ttl) && ttl >= 0 ? ttl : 60000;
			return { value: { sessionsRoot, workspaceSlug, maxAuto, balanceTtlMs } };
		},
	},
};

/** 預設的 sessions 根目錄。 */
function defaultSessionsRoot() {
	return join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "sessions");
}

/**
 * CORS 白名單：只放 Desktop 頁面 origin 與回環 http（**不是 `*`**）。
 * @param origin - 請求的 Origin 標頭
 * @returns 放行的 origin，或 null
 */
export function allowedOrigin(origin) {
	if (typeof origin !== "string" || origin === "") return null;
	if (origin === "dsh-app://app") return origin;
	if (/^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/u.test(origin)) return origin;
	return null;
}

/** 依白名單補上 CORS 標頭。 */
function applyCors(req, res) {
	const origin = allowedOrigin(req?.headers?.origin);
	if (origin === null) return;
	try {
		res.setHeader("access-control-allow-origin", origin);
		res.setHeader("vary", "origin");
	} catch {
		/* 不能設標頭就算了 */
	}
}

/** 寫 JSON 回應。 */
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
			/* 放棄 */
		}
	}
}

/**
 * 讀 JSON body（上限 8KB）。真 IncomingMessage 與測試替身都支援非同步迭代。
 * @param req - 進來的請求
 * @param limit - 位元組上限
 * @returns `{ok: true, value}` 或 `{ok: false, error}`
 */
async function readJsonBody(req, limit = 8192) {
	const chunks = [];
	let size = 0;
	try {
		for await (const chunk of req) {
			size += chunk.length;
			if (size > limit) return { ok: false, error: "body too large" };
			chunks.push(chunk);
		}
	} catch (error) {
		return { ok: false, error: String(error?.message ?? error) };
	}
	try {
		return { ok: true, value: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
	} catch {
		return { ok: false, error: "invalid json" };
	}
}

/**
 * 檢查「POST ＋ application/json」，並把 body 讀成物件。
 *
 * 兩個寫入路由共用：內容型別一定要 JSON（跨站的表單或簡單請求過不了 preflight），
 * body 上限 8KB，任何一步失敗都已經由這裡回好錯誤，呼叫端只要看 `ok`。
 * @param req - 進來的請求
 * @param res - 要回應的物件
 * @returns `{ok: true, value}` 或 `{ok: false}`
 */
async function readJsonPost(req, res, limit = 8192) {
	const method = String(req?.method ?? "GET").toUpperCase();
	if (method === "OPTIONS") {
		try {
			res.setHeader("access-control-allow-methods", "POST, OPTIONS");
			res.setHeader("access-control-allow-headers", "content-type");
		} catch {
			/* 不能設標頭就算了 */
		}
		sendJson(res, 204, {});
		return { ok: false };
	}
	if (method !== "POST") {
		sendJson(res, 405, { ok: false, error: "method not allowed" });
		return { ok: false };
	}
	const type = String(req?.headers?.["content-type"] ?? "")
		.split(";")[0]
		.trim()
		.toLowerCase();
	if (type !== "application/json") {
		sendJson(res, 415, { ok: false, error: "content-type must be application/json" });
		return { ok: false };
	}
	const body = await readJsonBody(req, limit);
	if (!body.ok) {
		sendJson(res, 400, { ok: false, error: body.error });
		return { ok: false };
	}
	return { ok: true, value: body.value };
}

/**
 * 面板只看得到「真正的對話」：**排除子代理**（`subagent === true`）。
 *
 * 為什麼要排除：子代理是主 session 派出去的工作單元，DSH 自己的工作區清單（`workspace.json`）
 * 根本沒有它們（實測 34 場裡一個都沒有）。把他們算進交接鏈只會出現「第三個是一場陌生的子代理」
 * （2026-10-18 使用者回報）；而它們的標題也不該被自動編號。
 * @param sessions - 套用過對照表／手動歸鏈的場次
 * @returns 給面板用的場次（子代理已濾掉）
 */
export function visibleSessions(sessions) {
	return (Array.isArray(sessions) ? sessions : []).filter((session) => session?.subagent !== true);
}

/**
 * 選模型路由：把某一場的模型選擇套到新開的對話（交接用）。
 *
 * 宿主直接呼叫 `sessionController.selectModel` —— 與 UI 的模型選單同一個方法，
 * 但不必經過瀏覽器的 Remote 命名空間。任何一步失敗都回 {ok:false,error}，
 * 前端才有東西可以顯示（舊版是靜音失敗，使用者只看到「又變回雲端」）。
 * @param {{getController?: Function}} [options] - 依賴注入（測試用得到）
 * @returns 處理函式 `(req, res) => void`
 */
export function createSelectModelHandler({ getController = () => null } = {}) {
	return async (req, res) => {
		applyCors(req, res);
		try {
			const method = String(req?.method ?? "GET").toUpperCase();
			if (method === "OPTIONS") {
				try {
					res.setHeader("access-control-allow-methods", "POST, OPTIONS");
					res.setHeader("access-control-allow-headers", "content-type");
				} catch {
					/* 不能設標頭就算了 */
				}
				sendJson(res, 204, {});
				return;
			}
			if (method !== "POST") {
				sendJson(res, 405, { ok: false, error: "method not allowed" });
				return;
			}
			const body = await readJsonPost(req, res);
			if (!body.ok) return;
			const request = body.value ?? {};
			const sessionId = typeof request.sessionId === "string" ? request.sessionId : "";
			const provider = typeof request.provider === "string" ? request.provider : "";
			const model = typeof request.model === "string" ? request.model : "";
			if (sessionId === "" || provider === "" || model === "") {
				sendJson(res, 400, { ok: false, error: "sessionId/provider/model required" });
				return;
			}
			const controller = getController();
			if (typeof controller?.selectModel !== "function") {
				sendJson(res, 503, { ok: false, error: "session controller unavailable" });
				return;
			}
			const value = await controller.selectModel({
				sessionId,
				provider,
				model,
				...(typeof request.reasoningEffort === "string" && request.reasoningEffort !== "" ? { reasoningEffort: request.reasoningEffort } : {}),
			});
			sendJson(res, 200, { ok: true, selected: value?.selected ?? null });
		} catch (error) {
			sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
		}
	};
}

/**
 * 接續提示詞路由：GET 讀 `.state/next-prompt.txt`、POST `{clear:true}` 用完就刪。
 *
 * 為什麼要這條路：AI 在交接時寫好提示詞檔案，面板的「交接→新對話」才有東西可以貼。
 * 沒有檔案就回 `prompt: null`（前端會說「先讓 AI 寫好」），不會自己編一段。
 * @param {{file?: string, limit?: number}} [options] - 依賴注入（測試用得到）
 * @returns 處理函式 `(req, res) => void`
 */
export function createNextPromptHandler({ file = DEFAULT_NEXT_PROMPT_FILE, limit = 20000 } = {}) {
	return async (req, res) => {
		applyCors(req, res);
		try {
			const method = String(req?.method ?? "GET").toUpperCase();
			if (method === "OPTIONS") {
				try {
					res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
					res.setHeader("access-control-allow-headers", "content-type");
				} catch {
					/* 不能設標頭就算了 */
				}
				sendJson(res, 204, {});
				return;
			}
			if (method === "GET" || method === "HEAD") {
				let prompt = null;
				try {
					const text = readFileSync(file, "utf8");
					if (typeof text === "string" && text.trim() !== "") prompt = text.slice(0, limit);
				} catch {
					/* 檔案不存在＝還沒有交接詞 */
				}
				sendJson(res, 200, { ok: true, prompt });
				return;
			}
			if (method === "POST") {
				const body = await readJsonPost(req, res);
				if (!body.ok) return;
				if (body.value?.clear === true) {
					try {
						unlinkSync(file);
					} catch {
						/* 已經沒有了 */
					}
				}
				sendJson(res, 200, { ok: true });
				return;
			}
			sendJson(res, 405, { ok: false, error: "method not allowed" });
		} catch (error) {
			sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
		}
	};
}

/**
 * 造出讀取路由 handler（唯讀）。
 * @param {{sessionsRoot: string, workspaceSlug?: string, cache?: Map, aliasesFile?: string}} options - 依賴注入（測試用得到）
 * @returns 處理函式 `(req, res) => void`
 */
export function createHandler({
	sessionsRoot,
	workspaceSlug = "",
	cache = new Map(),
	aliasesFile = DEFAULT_ALIASES_FILE,
	maxAuto = 10,
}) {
	return (req, res) => {
		applyCors(req, res);
		try {
			const method = String(req?.method ?? "GET").toUpperCase();
			if (method !== "GET" && method !== "HEAD") {
				sendJson(res, 405, { ok: false, error: "method not allowed" });
				return;
			}
			const store = loadStore(aliasesFile);
			const { sessions, files } = readSessions(sessionsRoot, {
				cache,
				workspaceSlug: workspaceSlug !== "" ? workspaceSlug : null,
			});
			const mapped = visibleSessions(applyAssignments(applyAliases(sessions, store.aliases), store.sessionChains, store.aliases));
			const chains = groupByChain(mapped);
			sendJson(res, 200, {
				ok: true,
				generatedAt: Date.now(),
				sessionsRoot,
				files,
				version: packageVersion(),
				aliases: store.aliases,
				sessionChains: store.sessionChains,
				titles: store.titles,
				// 置頂／封存：跟 buildPayload 一樣用 canonical 名回傳（改名後仍然生效）。
				// 2026-10-19 修：GET 這支是卡片與面板真正吃的資料，之前只改了 POST 那支，
				// 所以按了置頂「後端有存、前端永遠收不到」，畫面看起來就是按不動。
				pinned: (Array.isArray(store.pinned) ? store.pinned : []).map((name) => canonicalOf(name, store.aliases)),
				archived: (Array.isArray(store.archived) ? store.archived : []).map((name) => canonicalOf(name, store.aliases)),
				sessions: mapped,
				chains,
				suggestions: suggestFor(chains),
				numbering: planTitleSync({ chains, titles: store.titles, maxAuto }),
			});
		} catch (error) {
			sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
		}
	};
}

/**
 * 給「未標記」那一組的整理建議（只建議、不寫入）。
 *
 * 為什麼放在 payload 而不是另開一條路由：使用者第一次打開面板就要看到它，
 * 多一次往返只是讓畫面慢半拍；36 場的計算量很小。
 * @param chains - `groupByChain()` 的結果
 * @returns 建議分組
 */
function suggestFor(chains) {
	const unmarked = (Array.isArray(chains) ? chains : []).find((group) => group?.chain === null);
	return suggestChains(unmarked?.sessions ?? []);
}

/** 讀 sessions、套用兩張表、分組 —— 三個寫入路由回應時都要附上最新結果。 */
function buildPayload({ sessionsRoot, workspaceSlug, cache, store, maxAuto = 10 }) {
	const { sessions, files } = readSessions(sessionsRoot, {
		cache,
		workspaceSlug: workspaceSlug !== "" ? workspaceSlug : null,
	});
	const mapped = visibleSessions(applyAssignments(applyAliases(sessions, store.aliases), store.sessionChains, store.aliases));
	const chains = groupByChain(mapped);
	return {
		ok: true,
		generatedAt: Date.now(),
		version: packageVersion(),
		files,
		aliases: store.aliases,
		sessionChains: store.sessionChains,
		titles: store.titles,
		// 置頂／封存都用「canonical 名」回傳：使用者改過名之後，舊名字的置頂仍然生效。
		pinned: (Array.isArray(store.pinned) ? store.pinned : []).map((name) => canonicalOf(name, store.aliases)),
		archived: (Array.isArray(store.archived) ? store.archived : []).map((name) => canonicalOf(name, store.aliases)),
		sessions: mapped,
		chains,
		suggestions: suggestFor(chains),
		numbering: planTitleSync({ chains, titles: store.titles, maxAuto }),
	};
}

/** 寫入後重寫對照表 md（寫不進去不影響主要動作）。 */
function writeRegistry(registryFile, store, chains) {
	try {
		writeFileSync(registryFile, renderRegistry(store.aliases, chains, Date.now(), store.sessionChains), "utf8");
	} catch {
		/* 對照表 md 寫不進去不影響功能 */
	}
}

/**
 * 造出改名路由 handler（寫入路徑之一）。
 *
 * 只做一件事：把 `from → to` 登錄進對照表，並重寫 `鏈代號.md`。
 * **不改任何 session log**（那是歷史），所以既有的鏈不會斷。
 * @param {{sessionsRoot: string, workspaceSlug?: string, cache?: Map, aliasesFile?: string, registryFile?: string}} options - 依賴注入
 * @returns 非同步處理函式 `(req, res) => Promise<void>`
 */
export function createRenameHandler({
	sessionsRoot,
	workspaceSlug = "",
	cache = new Map(),
	aliasesFile = DEFAULT_ALIASES_FILE,
	registryFile = DEFAULT_REGISTRY_FILE,
	maxAuto = 10,
}) {
	return async (req, res) => {
		applyCors(req, res);
		try {
			const body = await readJsonPost(req, res);
			if (!body.ok) return;
			const from = typeof body.value?.from === "string" ? body.value.from.trim() : "";
			const to = normalizeName(body.value?.to);
			if (from === "" || to === null) {
				sendJson(res, 400, { ok: false, error: "需要 from，且 to 必須是 1–60 字、不含空白與 =" });
				return;
			}
			if (from === to) {
				sendJson(res, 400, { ok: false, error: "新名稱與舊代號相同" });
				return;
			}
			const current = loadStore(aliasesFile);
			const store = {
				aliases: updateAliases(current.aliases, from, to),
				sessionChains: current.sessionChains,
				titles: current.titles,
				pinned: current.pinned,
				archived: current.archived,
			};
			const saved = saveStore(aliasesFile, store);
			if (!saved.ok) {
				sendJson(res, 500, { ok: false, error: saved.error });
				return;
			}
			const payload = buildPayload({ sessionsRoot, workspaceSlug, cache, store });
			writeRegistry(registryFile, store, payload.chains);
			sendJson(res, 200, payload);
		} catch (error) {
			sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
		}
	};
}

/**
 * 造出歸鏈路由 handler（寫入路徑之二）。
 *
 * 給「從來沒用過交接指令」的舊對話：把某**一場**對話手動指定到一條鏈。
 * 打既有名字＝併進那條鏈；打新名字＝新開一條鏈；`chain` 留白＝取消指定、回到自動判定。
 * @param {{sessionsRoot: string, workspaceSlug?: string, cache?: Map, aliasesFile?: string, registryFile?: string}} options - 依賴注入
 * @returns 非同步處理函式 `(req, res) => Promise<void>`
 */
export function createAssignHandler({
	sessionsRoot,
	workspaceSlug = "",
	cache = new Map(),
	aliasesFile = DEFAULT_ALIASES_FILE,
	registryFile = DEFAULT_REGISTRY_FILE,
	maxAuto = 10,
}) {
	return async (req, res) => {
		applyCors(req, res);
		try {
			const body = await readJsonPost(req, res);
			if (!body.ok) return;
			const sessionId = typeof body.value?.sessionId === "string" ? body.value.sessionId.trim() : "";
			if (sessionId === "" || sessionId.length > 100 || /[\s]/u.test(sessionId)) {
				sendJson(res, 400, { ok: false, error: "需要合法的 sessionId" });
				return;
			}
			const raw = body.value?.chain;
			// 先讀 store：名字要過對照表，才不會把舊代號存成一條影子鏈。
			const current = loadStore(aliasesFile);
			// 留白（或沒帶）＝取消指定；有值就必須是合法的鏈名。
			const clear = raw === undefined || raw === null || (typeof raw === "string" && raw.trim() === "");
			const chain = clear ? "" : canonicalOf(normalizeName(raw), current.aliases);
			if (!clear && chain === null) {
				sendJson(res, 400, { ok: false, error: "chain 必須是 1–60 字、不含空白與 =（留白＝取消指定）" });
				return;
			}
			const sessionChains = { ...current.sessionChains };
			if (clear) delete sessionChains[sessionId];
			else sessionChains[sessionId] = chain;
			const store = { aliases: current.aliases, sessionChains, titles: current.titles, pinned: current.pinned, archived: current.archived };
			const saved = saveStore(aliasesFile, store);
			if (!saved.ok) {
				sendJson(res, 500, { ok: false, error: saved.error });
				return;
			}
			const payload = buildPayload({ sessionsRoot, workspaceSlug, cache, store, maxAuto });
			writeRegistry(registryFile, store, payload.chains);
			sendJson(res, 200, payload);
		} catch (error) {
			sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
		}
	};
}

/**
 * 造出「置頂／封存」路由 handler（寫入路徑之四）。
 *
 * 兩個動作只是同一份 store 裡的兩個字串清單（`pinned`／`archived`），所以共用一支：
 * 差別只在寫哪一個欄位。名字一律先過對照表（`canonicalOf`）——使用者可能打的是舊代號，
 * 直接存舊名會變成「改名後置頂就掉了」。
 *
 * 封存**不動任何 session log**，只是不在側欄卡片顯示；面板的封存庫仍列得出來、也還原得回去。
 * @param {{kind: "pinned"|"archived"}} options - 要寫哪一個清單
 * @returns {(options: object) => (req, res) => Promise<void>} handler 工廠
 */
export function createFlagHandler({ kind }) {
	return function build({ sessionsRoot, workspaceSlug = "", cache = new Map(), aliasesFile = DEFAULT_ALIASES_FILE, registryFile = DEFAULT_REGISTRY_FILE, maxAuto = 10 }) {
		return async (req, res) => {
			applyCors(req, res);
			try {
				const body = await readJsonPost(req, res);
				if (!body.ok) return;
				// 過 normalizeName：打錯字（含空白、`=`）要在這裡擋掉，
				// 否則會安靜地釘到一條不存在的鏈，畫面看起來成功、實際沒生效。
				const raw = normalizeName(body.value?.chain);
				const on = body.value?.on === true;
				if (raw === null) {
					sendJson(res, 400, { ok: false, error: "需要 chain（1–60 字、不含空白與 =）" });
					return;
				}
				const current = loadStore(aliasesFile);
				// 先過對照表：用舊代號按的置頂，也要落在改名後的那條鏈上。
				const chain = canonicalOf(raw, current.aliases);
				const store = {
					aliases: current.aliases,
					sessionChains: current.sessionChains,
					titles: current.titles,
					pinned: kind === "pinned" ? toggleInList(current.pinned, chain, on) : current.pinned,
					archived: kind === "archived" ? toggleInList(current.archived, chain, on) : current.archived,
				};
				const saved = saveStore(aliasesFile, store);
				if (!saved.ok) {
					sendJson(res, 500, { ok: false, error: saved.error });
					return;
				}
				const payload = buildPayload({ sessionsRoot, workspaceSlug, cache, store, maxAuto });
				writeRegistry(registryFile, store, payload.chains);
				sendJson(res, 200, payload);
			} catch (error) {
				sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
			}
		};
	};
}

/**
 * 造出「標題回報」路由 handler（寫入路徑之三）。
 *
 * 為什麼要有這條：編號的**套用**在瀏覽器（`sessions.rename()` 是 client 服務），
 * 但「原標題備份」要落在宿主的 store —— 瀏覽器改完回報，宿主才記得住這場原本叫什麼。
 * 而且**只記第一次**：重編（中間插入）時的中間值絕不能蓋掉真正的原標題。
 *
 * 還原的判斷：若這筆 `to` 正好等於備份值 → 這是「還原」，把備份清掉（不留孤兒）。
 * @param {{sessionsRoot: string, workspaceSlug?: string, cache?: Map,
 *          aliasesFile?: string, maxAuto?: number}} options - 依賴注入
 * @returns 非同步處理函式 `(req, res) => Promise<void>`
 */
export function createTitlesHandler({
	sessionsRoot,
	workspaceSlug = "",
	cache = new Map(),
	aliasesFile = DEFAULT_ALIASES_FILE,
	registryFile = DEFAULT_REGISTRY_FILE,
	maxAuto = 10,
}) {
	return async (req, res) => {
		applyCors(req, res);
		try {
			// 一次回報最多 500 筆，每筆約 120 bytes → 8 KB 的通用上限只夠 ~68 筆。
			const body = await readJsonPost(req, res, 64 * 1024);
			if (!body.ok) return;
			const applied = body.value?.applied;
			if (!Array.isArray(applied) || applied.length > 500) {
				sendJson(res, 400, { ok: false, error: "需要 applied 陣列（上限 500 筆）" });
				return;
			}
			const current = loadStore(aliasesFile);
			const titles = { ...current.titles };
			for (const entry of applied) {
				const sessionId = typeof entry?.sessionId === "string" ? entry.sessionId.trim() : "";
				if (sessionId === "" || sessionId.length > 100 || /[\s]/u.test(sessionId)) {
					sendJson(res, 400, { ok: false, error: "applied 內需要合法的 sessionId" });
					return;
				}
				const to = typeof entry?.to === "string" ? entry.to : "";
				const from = typeof entry?.from === "string" ? entry.from : "";
				if (to === "") {
					sendJson(res, 400, { ok: false, error: "applied 內需要 to" });
					return;
				}
				if (titles[sessionId] === to) {
					// 還原成功 → 備份功成身退。
					delete titles[sessionId];
					continue;
				}
				if (titles[sessionId] === undefined && from !== "") titles[sessionId] = from;
			}
			const store = { aliases: current.aliases, sessionChains: current.sessionChains, titles, pinned: current.pinned, archived: current.archived };
			const saved = saveStore(aliasesFile, store);
			if (!saved.ok) {
				sendJson(res, 500, { ok: false, error: saved.error });
				return;
			}
			// 順手把 `鏈代號.md` 的場次刷新：新的一場進鏈時（＝有標題要改）就是場次變動的時刻，
			// 不在這裡重寫的話，那份表會停在「上次改名時」的數字（2026-10-18 實測：寫成 2 場、實際 3 場）。
			const payload = buildPayload({ sessionsRoot, workspaceSlug, cache, store, maxAuto });
			writeRegistry(registryFile, store, payload.chains);
			sendJson(res, 200, payload);
		} catch (error) {
			sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
		}
	};
}

/**
 * 掛載宿主半。
 * @param ctx - cordis 宿主 context
 * @param config - 補丁裡給的 config（第二個參數）
 * @returns 這個 fiber 的 disposer（或 undefined）
 */
export function apply(ctx, config) {
	const resolved = Config["~standard"].validate(config).value;
	try {
		// 一份 cache 給所有 handler：冷掃 109 場是 1.5 秒的同步工作，各 handler
		// 各持一份就會把同一份重掃五次（每次重啟後的第一次寫入都卡住事件迴圈）。
		const sessionCache = new Map();
		const shared = {
			sessionsRoot: resolved.sessionsRoot !== "" ? resolved.sessionsRoot : defaultSessionsRoot(),
			workspaceSlug: resolved.workspaceSlug,
			aliasesFile: DEFAULT_ALIASES_FILE,
			registryFile: DEFAULT_REGISTRY_FILE,
			maxAuto: resolved.maxAuto,
			cache: sessionCache,
		};
		const handler = createHandler(shared);
		// 用量／餘額路由（原 dsh-token-hud）：與交接鏈同一個外掛、同一組設定。
		const usageHandler = createUsageHandler({
			sessionsRoot: shared.sessionsRoot,
			scope: "all",
			workspaceSlug: resolved.workspaceSlug,
			balanceReader: createBalanceReader({ ttlMs: resolved.balanceTtlMs }),
			ctx,
		});
		const renameHandler = createRenameHandler(shared);
		const assignHandler = createAssignHandler(shared);
		const titlesHandler = createTitlesHandler(shared);
		const pinHandler = createFlagHandler({ kind: "pinned" })(shared);
		const archiveHandler = createFlagHandler({ kind: "archived" })(shared);
		const nextPromptHandler = createNextPromptHandler();
		return ctx.inject(["webServer"], (webCtx) => {
			try {
				webCtx.effect(
					() => webCtx.webServer.register({ kind: "exact", path: ROUTE_PATH, handler }),
					"session-chains: 唯讀鏈路由",
				);
				webCtx.effect(
					() => webCtx.webServer.register({ kind: "exact", path: RENAME_PATH, handler: renameHandler }),
					"session-chains: 改名路由",
				);
				webCtx.effect(
					() => webCtx.webServer.register({ kind: "exact", path: ASSIGN_PATH, handler: assignHandler }),
					"session-chains: 歸鏈路由",
				);
				webCtx.effect(
					() => webCtx.webServer.register({ kind: "exact", path: TITLES_PATH, handler: titlesHandler }),
					"session-chains: 標題回報路由",
				);
				webCtx.effect(
					() => webCtx.webServer.register({ kind: "exact", path: PIN_PATH, handler: pinHandler }),
					"session-chains: 置頂路由",
				);
				webCtx.effect(
					() => webCtx.webServer.register({ kind: "exact", path: ARCHIVE_PATH, handler: archiveHandler }),
					"session-chains: 封存路由",
				);
				webCtx.effect(
					() => webCtx.webServer.register({ kind: "exact", path: USAGE_PATH, handler: usageHandler }),
					"session-chains: 用量／餘額路由",
				);
				webCtx.effect(
					() => webCtx.webServer.register({ kind: "exact", path: NEXT_PROMPT_PATH, handler: nextPromptHandler }),
					"session-chains: 接續提示詞路由",
				);
				const selectModelHandler = createSelectModelHandler({ getController: () => webCtx.get("sessionController") });
				webCtx.effect(
					() => webCtx.webServer.register({ kind: "exact", path: SELECT_MODEL_PATH, handler: selectModelHandler }),
					"session-chains: 選模型路由",
				);
				ctx.logger?.info?.(
					`[session-chains] 已載入：GET ${ROUTE_PATH}／${USAGE_PATH}、POST ${RENAME_PATH}／${ASSIGN_PATH}；store ${DEFAULT_ALIASES_FILE}`,
				);
			} catch (error) {
				ctx.logger?.error?.("[session-chains] 路由註冊失敗", error);
			}
		});
	} catch (error) {
		ctx.logger?.error?.("[session-chains] 載入失敗", error);
		return undefined;
	}
}
