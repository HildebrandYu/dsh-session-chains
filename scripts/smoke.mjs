/**
 * smoke.mjs — 不進 GUI 的最小檢查（spike 的自動畫面檢查）。
 *
 * 用迷你 React 載入 `plugin/client.js`，確認：
 *   ① `apply` 把元件註冊到 `sidebar.footer.action` 與 `shell.overlay`
 *   ② footer 按鈕有 onClick，按一下真的會把面板打開、再按一下關起來
 *   ③ 面板的標題列文字（重抓／抓取中／已更新）長得出來，不會在 render 時炸掉
 *   ④ **資料列**畫得出來：有鏈、有「起點」標記（2026-10-17 補；舊版 hook 是死的，
 *      根本渲染不到資料列，所以鏈的起點那條路只有人眼驗過）
 *   ⑤ **改名入口**：點鏈標籤會出現輸入框，Enter 會 POST 到改名路由（2026-10-17 補）
 *   ⑥ **歸鏈入口**：未標記的對話列也有「歸鏈」，Enter 會 POST 到歸鏈路由（2026-10-17 補）
 *   ⑦ **「你在這裡」**：目前這一場要有亮色底色與字標、標題列要說出你在哪條鏈、
 *      未標記時提示可點開；滑過再離開要**還原亮底**（2026-10-17 補）
 *
 * 迷你 React 是**真的會動**的：`useState` 會保存值、`useEffect` 會在相依變動時跑、
 * 狀態變了會重新渲染（用 `settle()` 反覆渲染到非同步的 fetch 落地為止）。
 * 用法：node scripts/smoke.mjs（不需要 DSH 在跑）
 */
import { readFileSync } from "node:fs";
import vm from "node:vm";

/** 假的後端回應：一條有起點的鏈（含一個「同時在兩條鏈」的中繼場） ＋ 一場未標記。 */
const HEAD_AT = Date.parse("2026-10-17T01:00:00Z");
/**
 * 中繼場：接手 `dsh-demo`、又開出 `dsh-demo-2` → 兩組都會列出它（真實案例：`session-21f42b94`）。
 * @param chain - 目前這一組的鏈名（兩組各列一次，其餘欄位相同）
 */
const headSession = (chain) => ({
	id: "s-head",
	cwd: "/work/my-project",
	firstLine: "幫我做一個示範專案",
	chain: "dsh-demo",
	chainReason: "接續",
	chains: ["dsh-demo", "dsh-demo-2"],
	handoffTo: "dsh-demo-2",
	startedAt: HEAD_AT,
	groupShown: chain,
});
const DEMO_PAYLOAD = {
	numbering: {
		items: [{ sessionId: "s-next", from: "舊標題", to: "dsh-demo-002", chain: "dsh-demo" }],
		total: 1,
		needsConfirm: false,
		restores: [],
	},
	chains: [
		{
			chain: "dsh-demo-2",
			count: 1,
			firstAt: HEAD_AT,
			lastAt: HEAD_AT,
			sessionIds: ["s-head"],
			sessions: [headSession("dsh-demo-2")],
		},
		{
			chain: "dsh-demo",
			count: 2,
			firstAt: HEAD_AT,
			lastAt: Date.parse("2026-10-17T02:00:00Z"),
			sessionIds: ["s-head", "s-next"],
			sessions: [
				headSession("dsh-demo"),
				{
					id: "s-next",
					cwd: "/work/my-project",
					firstLine: "【接續提示詞】鏈=dsh-demo 先讀 README",
					chain: "dsh-demo",
					chainReason: "tag",
					chains: ["dsh-demo"],
					handoffTo: null,
					startedAt: Date.parse("2026-10-17T02:00:00Z"),
				},
			],
		},
		{
			chain: null,
			count: 1,
			firstAt: Date.parse("2026-10-17T03:00:00Z"),
			lastAt: Date.parse("2026-10-17T03:00:00Z"),
			sessionIds: ["s-loose"],
			sessions: [
				{
					id: "s-loose",
					cwd: null,
					firstLine: "今天天氣如何",
					chain: null,
					chainReason: "unmarked",
					chains: [],
					handoffTo: null,
					startedAt: Date.parse("2026-10-17T03:00:00Z"),
				},
			],
		},
	],
};

// ── 迷你 React（會保存 state、會跑 effect、會重新渲染） ────────────────────
const created = [];
const fetchCalls = [];
const states = new Map();
let rendering = null;
/** 有待處理的狀態變更（下一次 settle() 會重新渲染）。 */
let dirty = false;

const react = {
	createElement(type, props, ...children) {
		const node = { type, props: props ?? {}, children };
		created.push(node);
		return node;
	},
	useState(initial) {
		const state = rendering;
		const position = state.index++;
		if (!(position in state.hooks)) state.hooks[position] = typeof initial === "function" ? initial() : initial;
		return [
			state.hooks[position],
			(next) => {
				state.hooks[position] = typeof next === "function" ? next(state.hooks[position]) : next;
				dirty = true;
			},
		];
	},
	useEffect(effect, deps = []) {
		const state = rendering;
		const position = state.index++;
		const previous = state.deps[position];
		const changed = previous === undefined || previous.length !== deps.length || deps.some((value, index) => value !== previous[index]);
		state.deps[position] = deps;
		if (changed) state.cleanups[position] = effect();
	},
	/** 面板的 hook 必須在 early return 前呼叫：這裡不特別處理，靠渲染順序固定。 */
	useRef(initial) {
		const state = rendering;
		const position = state.index++;
		if (!(position in state.hooks)) state.hooks[position] = { current: typeof initial === "function" ? initial() : initial };
		return state.hooks[position];
	},
};

/** 渲染一次元件（重置 hook 指標）。 */
function render(component) {
	let state = states.get(component);
	if (state === undefined) {
		state = { hooks: [], deps: [], cleanups: [], index: 0 };
		states.set(component, state);
	}
	state.index = 0;
	rendering = state;
	created.length = 0;
	try {
		return component({});
	} finally {
		rendering = null;
	}
}

/** 反覆渲染，直到非同步的 fetch／state 更新都落地（或到上限）。 */
async function settle(component, rounds = 10) {
	let tree = render(component);
	for (let round = 0; round < rounds; round += 1) {
		await new Promise((resolve) => setTimeout(resolve, 5));
		dirty = false;
		tree = render(component);
		if (!dirty && round >= 3) break;
	}
	return tree;
}

/** 目前這一輪 render 產出的字串節點。 */
function textsOf() {
	return created.flatMap((node) => node.children.filter((child) => typeof child === "string"));
}

/** 目前這一輪 render 用到的元素種類。 */
function typesOf() {
	return [...new Set(created.filter((node) => typeof node.type === "string").map((node) => node.type))];
}

// ── 載入 bundle ───────────────────────────────────────────────────────────
/** 假的側邊欄 DOM：內建清單列是 `data-row-key="session:<id>"` ＋ `aria-selected`。 */
const domState = { selectedRowKey: null };
/** 假 localStorage（Map -backed）：卡片展開狀態與暫停旗標都靠它。 */
const store = new Map();
const fakeLocalStorage = {
	getItem: (key) => (store.has(key) ? store.get(key) : null),
	setItem: (key, value) => store.set(key, String(value)),
	removeItem: (key) => store.delete(key),
};
const clipboardWrites = [];
/** 「交接→新對話」讀到的提示詞（測試可以換成空字串，驗錯誤處理）。 */
let nextPromptForFetch = "先讀交接單\n鏈=dsh-demo";
/** 目前 fetch 會回的 payload（測試可以換掉，驗「有建議」的情況）。 */
let payloadForFetch = DEMO_PAYLOAD;

const sandbox = {
	localStorage: fakeLocalStorage,
	// 交接提醒會把指示放進剪貼簿；測試要驗「真的寫了什麼」。
	navigator: { clipboard: { writeText: async (text) => { clipboardWrites.push(text); } } },
	URL,
	AbortController,
	console: { warn: (...args) => console.log("   [warn]", ...args) },
	document: {
		baseURI: "http://127.0.0.1:19387/",
		visibilityState: "visible",
		querySelector: (selector) =>
			domState.selectedRowKey !== null && selector.includes("data-row-key")
				? { getAttribute: (name) => (name === "data-row-key" ? domState.selectedRowKey : null) }
				: null,
	},
	fetch: async (url, init) => {
		fetchCalls.push({ url: String(url), init: init ?? {} });
		if (String(url).includes("next-prompt")) {
			// 真的路由：POST {clear:true} 會把檔案刪掉 → 之後 GET 回 null（避免測到「舊檔還在」）。
			if (String(init?.method ?? "GET").toUpperCase() === "POST") {
				try {
					if (JSON.parse(init.body)?.clear === true) nextPromptForFetch = "";
				} catch {
					/* 忽略 */
				}
				return { ok: true, status: 200, json: async () => ({ ok: true }) };
			}
			return { ok: true, status: 200, json: async () => ({ ok: true, prompt: nextPromptForFetch }) };
		}
		return { ok: true, status: 200, json: async () => payloadForFetch };
	},
	// 面板會開輪詢與「抓取中…至少 400ms」的 timer；unref 掉，免得測試跑完還掛著。
	setInterval: (...args) => {
		const timer = setInterval(...args);
		timer.unref?.();
		return timer;
	},
	clearInterval,
	setTimeout: (...args) => {
		const timer = setTimeout(...args);
		timer.unref?.();
		return timer;
	},
	clearTimeout,
	window: {
		__ModuleLoader__: {
			load({ factory, id }) {
				sandbox.captured = {
					exports: factory((name) => {
						if (name === "react") return react;
						throw new Error(`不可 require：${name}`);
					}),
					id,
				};
			},
		},
	},
};
vm.createContext(sandbox);
vm.runInContext(readFileSync(new URL("../plugin/client.js", import.meta.url), "utf8"), sandbox, { filename: "client.js" });

let failed = 0;
/** 記一行結果。 */
function check(ok, label, extra = "") {
	console.log(`${ok ? "✓" : "✗"} ${label}${extra ? `　— ${extra}` : ""}`);
	if (!ok) failed += 1;
}

const registrations = [];
// 假的 uiWorkspace：`selection` 就是內建「目前這一場」的 store（測試會切換它、並真的通知訂閱者）。
const currentState = { sessionId: "s-next" };
const selectionListeners = new Set();
const fakeWorkspace = {
	selection: {
		getSnapshot: () => ({ sessionId: currentState.sessionId }),
		subscribe: (listener) => {
			selectionListeners.add(listener);
			return () => selectionListeners.delete(listener);
		},
	},
	mainReference: {},
	openSession: (sessionId) => openCalls.push(sessionId),
};
const openCalls = [];
/** 假的 sessions 服務：`rename()` 是內建同一條改名路徑（回 {ok:true}）。 */
const renameCalls = [];
const createCalls = [];
const promptCalls = [];
const fakeSessions = {
	rename: async (sessionId, title) => {
		renameCalls.push({ sessionId, title });
		return { ok: true };
	},
	// 2026-10-18「交接→新對話」：建立空白對話 → 用 binding.session.prompt 送出交接詞。
	create: async (opts) => {
		createCalls.push(opts ?? {});
		return "s-new";
	},
	using: async (sessionId, _options, operation) =>
		operation({
			binding: {
				session: {
					prompt: async (content, mode) => {
						promptCalls.push({ sessionId, content, mode });
						return { ok: true };
					},
				},
			},
		}),
	list: { getSnapshot: () => ({ byId: { "s-next": { cwd: "/work/my-project" } } }) },
};
/** 切換「目前這一場」並通知訂閱者（模擬使用者從左側欄換對話）。 */
function setCurrentSession(sessionId) {
	currentState.sessionId = sessionId;
	for (const listener of selectionListeners) listener();
}

/** 假的 uiSession 狀態 store（2026-10-18：原生側欄的橙／綠／藍／紅點就是這一份）。 */
const statusState = new Map();
const statusListeners = new Set();
const fakeUiSession = {
	sessionStatus: {
		// 真實 store 的 snapshot 以 Map 表示；每次通知後重新取，讓元件吃到新值。
		getSnapshot: () => new Map(statusState),
		subscribe: (listener) => {
			statusListeners.add(listener);
			return () => statusListeners.delete(listener);
		},
	},
};
/** 設定幾場的狀態並通知（模擬宿主 publishStatus）。 */
function setSessionStatuses(entries) {
	for (const [id, status] of entries) statusState.set(id, status);
	for (const listener of statusListeners) listener();
}
const ctx = {
	get: (name) => {
		if (name === "uiWorkspace") return fakeWorkspace;
		if (name === "sessions") return fakeSessions;
		if (name === "uiSession") return fakeUiSession;
		return undefined;
	},
	slots: {
		inject(name, callback) {
			callback();
		},
		register(options, component) {
			registrations.push({ name: options.name, id: options.id, order: options.order, component });
		},
	},
};

sandbox.captured.exports.apply(ctx);
// 測試預設關掉自動交接（預設是開的），避免一渲染橫幅就送訊息、清掉提示詞檔；
// 要測自動的區塊會自己打開。
sandbox.captured.exports.writeSettings({ autoHandoff: false });
console.log(`id=${sandbox.captured.id}`);
console.log(`註冊數=${registrations.length}`);
for (const entry of registrations) console.log(`  ${entry.name} → id=${entry.id} order=${entry.order} 元件=${typeof entry.component}`);

const footer = registrations.find((entry) => entry.name === "sidebar.footer.action");
const panel = registrations.find((entry) => entry.name === "shell.overlay");
const dock = registrations.find((entry) => entry.name === "conversation.composer.dock");
check(
	registrations.length === 4 && footer !== undefined && panel !== undefined && dock !== undefined,
	"四個插槽都註冊了（底部按鈕／浮層面板／HUD／交接提醒）",
	`找到 ${registrations.length}`,
);

// ① 面板關著 → null
check((await settle(panel.component)) === null, "面板預設關著（回傳 null）");

// ② footer 按鈕切換開關
const footerTree = await settle(footer.component);
const toggle = footerTree?.props?.onClick;
check(typeof toggle === "function", "footer 按鈕有 onClick");
toggle();
let tree = await settle(panel.component);
check(tree !== null, "按一下會打開面板");

// ③④ 資料列：鏈名、「起點」標記、未標記場次
const texts = textsOf();
const joined = texts.join(" | ");
console.log(`  面板看得到的字：${joined}`);
check(texts.includes("dsh-demo"), "畫出鏈代號 dsh-demo");


check(texts.includes("起點"), "起點場次標了「起點」（handoffTo === 本鏈）");
check(texts.includes("幫我做一個示範專案") && texts.includes("【接續提示詞】鏈=dsh-demo 先讀 README"), "兩場都列出第一句話");
check(!texts.includes("今天天氣如何"), "未標記的場次預設收起");
check(typesOf().includes("span") && typesOf().includes("button"), `用到 ${typesOf().join("/")}`);

// ── ⑦「你在這裡」（2026-10-17 補） ─────────────────────────────────────────
// 目前這一場＝s-next（在 dsh-demo 這條鏈裡，預設就看得到）。
const readCurrent = sandbox.captured.exports.readCurrentSessionId;
check(readCurrent({ selection: { getSnapshot: () => ({ sessionId: "a" }) } }) === "a", "readCurrentSessionId：讀 uiWorkspace.selection");
check(readCurrent({ selection: { getSnapshot: () => ({}) }, mainReference: { sessionId: "b" } }) === "b", "readCurrentSessionId：selection 空的就退回 mainReference");
check(readCurrent({ selection: { getSnapshot: () => ({}) }, mainReference: {} }) === null, "readCurrentSessionId：都沒有 → null");
check(readCurrent(undefined) === null, "readCurrentSessionId：服務缺席 → null");
check(
	readCurrent({
		selection: {
			getSnapshot: () => {
				throw new Error("boom");
			},
		},
	}) === null,
	"readCurrentSessionId：getSnapshot 拋錯 → null（面板不會壞）",
);
// DOM 優先：側邊欄那一列才是「使用者看到被選取」的那一場。
domState.selectedRowKey = "session:s-head";
check(readCurrent({ selection: { getSnapshot: () => ({ sessionId: "s-next" }) } }) === "s-head", "readCurrentSessionId：側邊欄 DOM 優先於服務");
domState.selectedRowKey = null;

const currentRow = created.find((node) => node.props?.["data-current-row"] === "s-next");
check(currentRow !== undefined, "目前這一場（s-next）那一列有 data-current-row");
check(currentRow?.props?.style?.background === "#CFE7FF", "目前這一場有亮色底色", String(currentRow?.props?.style?.background));
check(String(currentRow?.props?.style?.borderLeft ?? "").includes("#CFE7FF"), "目前這一場有左側色條（吃設定的 highlight）");
check(textsOf().includes("你在這裡"), "那一列有「你在這裡」字標");
const hint = created.find((node) => node.props?.["data-current-hint"] === "s-next");
const hintStrong = hint?.children.find((child) => typeof child === "object");
check(hintStrong?.children?.[0] === "dsh-demo", "標題列寫出「你在：<鏈名>」", String(hintStrong?.children?.[0]));
check(created.some((node) => node.props?.["data-current-group"] === "dsh-demo"), "那一條鏈的組頭標了「你在這條鏈」");
// hover 不能把亮底洗掉（舊寫法 onMouseLeave 一律設回 transparent）。
const hoverNode = { style: {} };
currentRow?.props?.onMouseEnter?.({ currentTarget: hoverNode });
const hoverBg = hoverNode.style.background;
currentRow?.props?.onMouseLeave?.({ currentTarget: hoverNode });
check(hoverBg !== undefined && hoverBg !== "#CFE7FF" && hoverNode.style.background === "#CFE7FF", "滑過再離開，亮底會還原");
const plainNode = { style: {} };
created.find((node) => node.props?.["data-session-row"] === "s-head")?.props?.onMouseLeave?.({ currentTarget: plainNode });
check(plainNode.style.background === "transparent", "其他列離開後回復透明");

// 切到未標記的那一場：提示要說「未標記」而且可以點開（那一組預設收起，否則等於找不到自己）。
setCurrentSession("s-loose");
await settle(panel.component);
check(created.some((node) => node.props?.["data-current-hint"] === "s-loose"), "換對話後標題列跟著換（訂閱 selection）");
const unmarkedHint = created.find((node) => node.props?.["data-current-hint"] === "s-loose");
const unmarkedHintStrong = unmarkedHint?.children.find((child) => typeof child === "object");
check(unmarkedHintStrong?.children?.[0] === "未標記（按這裡展開）", "未標記時提示寫「未標記（按這裡展開）」", String(unmarkedHintStrong?.children?.[0]));
check(typeof unmarkedHint?.props?.onClick === "function", "未標記時的提示可點（展開了才看得到自己那一列）");
check(created.find((node) => node.props?.["data-current-row"] === "s-loose") === undefined, "那一組收起時，自己的列還看不到（所以需要上面那個提示）");

// 切回 s-next，後面的既有檢查（未標記按鈕／改名／歸鏈）不受影響。
setCurrentSession("s-next");
await settle(panel.component);

// 展開未標記
const showUnmarked = created.find((node) => node.props?.onClick !== undefined && node.children.includes(`未標記 1`));
check(showUnmarked !== undefined, "有「未標記 1」可以展開");
if (showUnmarked !== undefined) {
	showUnmarked.props.onClick();
	await settle(panel.component);
	check(textsOf().includes("今天天氣如何"), "展開後看得到未標記場次");
}

// 展開後切到未標記那一場：自己的列要亮，組頭也要標出來。
setCurrentSession("s-loose");
await settle(panel.component);
const looseRow = created.find((node) => node.props?.["data-current-row"] === "s-loose");
check(looseRow !== undefined && looseRow.props.style.background === "#CFE7FF", "未標記那一場展開後也有亮底");
check(textsOf().includes("你在這一組"), "未標記那一組的組頭標了「你在這一組」");

// ⑨ 中繼場（同時在兩條鏈）：要說出「也在哪裡」，而且能一鍵只留在本條
//    （使用者回報：這一場同時在兩條交接鏈，手動也改不了。）
const multiBadges = created.filter((node) => node.props?.["data-multi-chain"] === "s-head");
check(multiBadges.length === 2, "同時屬於兩條鏈的那一場，兩組都標了記號", `找到 ${multiBadges.length} 個`);
check(textsOf().includes("也在 dsh-demo-2") && textsOf().includes("也在 dsh-demo"), "標籤寫出「也在 <另一條鏈>」");
const pinForDemo2 = created.find((node) => node.props?.["data-pin-button"] === "s-head" && node.props?.["data-pin-chain"] === "dsh-demo-2");
const pinForDemo = created.find((node) => node.props?.["data-pin-button"] === "s-head" && node.props?.["data-pin-chain"] === "dsh-demo");
check(pinForDemo2 !== undefined && pinForDemo !== undefined, "兩組各有一個「只留在這條」，且知道自己屬於哪一組");
fetchCalls.length = 0;
pinForDemo2?.props?.onClick?.({ stopPropagation: () => {} });
await settle(panel.component);
const pinned = fetchCalls.filter((call) => call.url.includes("session-chains.assign")).pop();
check(pinned !== undefined && pinned.init.method === "POST", "按「只留在這條」會呼叫歸鏈路由");
check(pinned !== undefined && JSON.parse(pinned.init.body).chain === "dsh-demo-2", "POST 的 chain 是**本組**那一條（不是主要歸屬）", pinned === undefined ? "" : pinned.init.body);

// 歸鏈輸入框預填「本組那一條鏈」：直接 Enter＝只留在這條（舊版預填主要歸屬 → 看起來像改了沒用）
created
	.find((node) => node.props?.["data-assign-button"] === "s-head" && node.props?.["data-assign-group"] === "dsh-demo-2")
	?.props?.onClick?.({ stopPropagation: () => {} });
await settle(panel.component);
const headInputs = created.filter((node) => node.props?.["data-assign-input"] !== undefined);
check(
	headInputs.some((node) => node.props.defaultValue === "dsh-demo-2") && headInputs.some((node) => node.props.defaultValue === "dsh-demo"),
	"歸鏈輸入框預填的是「你看的那一組」那條鏈",
	JSON.stringify(headInputs.map((node) => node.props.defaultValue)),
);
headInputs[0]?.props?.onKeyDown?.({ key: "Escape", stopPropagation: () => {} });
await settle(panel.component);

// DOM 優先（端到端）：側邊欄選取的是 s-head、服務說 s-loose → 亮底要聽 DOM 的。
domState.selectedRowKey = "session:s-head";
setCurrentSession("s-loose");
await settle(panel.component);
check(created.some((node) => node.props?.["data-current-row"] === "s-head"), "側邊欄那一列優先（使用者看到的為準）");
check(created.find((node) => node.props?.["data-current-row"] === "s-loose") === undefined, "服務說的舊值不會蓋掉 DOM");
domState.selectedRowKey = null;
setCurrentSession("s-loose");
await settle(panel.component);
check(created.some((node) => node.props?.["data-current-row"] === "s-loose"), "DOM 讀不到時回到服務來源");

// 等「抓取中…至少 400ms」與「✓ 已更新 1.5 秒」兩個 timer 都落地：
// 上面按了「只留在這條」會成功歸鏈並重抓，flash 還在的話標題列不會回到「更新 …」。
await new Promise((resolve) => setTimeout(resolve, 1700));
await settle(panel.component);
check(textsOf().includes("重抓"), "抓取結束後按鈕回到「重抓」");
check(
	textsOf().some((text) => text.startsWith("更新 ")),
	"標題列顯示更新時間（含秒）",
	textsOf().find((text) => text.startsWith("更新 ")) ?? "",
);

// ⑤ 再按一次關起來（真的 React 會重繪 footer；這裡重渲染模擬那件事）
await settle(footer.component);
const secondToggle = created.find((node) => node.props?.["data-session-chains-toggle"] !== undefined)?.props?.onClick;
secondToggle();
check((await settle(panel.component)) === null, "再按一次關起來");

// ⑤ 改名入口：點鏈標籤 → 輸入框 → Enter 送出
// （上一條檢查把面板關掉了，先重新打開 —— 也順便再驗一次開關。）
const reopenTree = await settle(footer.component);
reopenTree.props.onClick();
await settle(panel.component);
const chainLabel = created.find((node) => node.props?.["data-chain-label"] === "dsh-demo");
check(chainLabel !== undefined && typeof chainLabel.props.onClick === "function", "鏈標籤可點（改名的入口）");
chainLabel.props.onClick({ stopPropagation: () => {} });
await settle(panel.component);
const renameInput = created.find((node) => node.props?.["data-chain-input"] !== undefined);
check(renameInput !== undefined, "點一下鏈標籤 → 出現改名輸入框");
renameInput.props.onChange({ target: { value: "模擬聲音工程" } });
await settle(panel.component);
const drafted = created.find((node) => node.props?.["data-chain-input"] !== undefined);
drafted.props.onKeyDown({ key: "Enter", stopPropagation: () => {} });
await settle(panel.component);
const posted = fetchCalls.find((call) => call.url.includes("session-chains.rename"));
check(posted !== undefined, "Enter 會 POST 到改名路由");
check(posted !== undefined && JSON.parse(posted.init.body).to === "模擬聲音工程", "POST body 帶新名稱");
check(posted !== undefined && posted.init.headers["content-type"] === "application/json", "POST 帶 application/json（跨站過不了 preflight）");

// ⑥ 歸鏈入口：未標記的對話也能指定到一條鏈
const assignButton = created.find((node) => node.props?.["data-assign-button"] === "s-loose");
check(assignButton !== undefined, "未標記的對話列也有「歸鏈」入口");
if (assignButton !== undefined) {
	assignButton.props.onClick({ stopPropagation: () => {} });
	await settle(panel.component);
	const assignInput = created.find((node) => node.props?.["data-assign-input"] !== undefined);
	check(assignInput !== undefined, "點「歸鏈」→ 出現輸入框");
	assignInput.props.onChange({ target: { value: "模擬聲音工程" } });
	await settle(panel.component);
	created
		.find((node) => node.props?.["data-assign-input"] !== undefined)
		.props.onKeyDown({ key: "Enter", stopPropagation: () => {} });
	await settle(panel.component);
	const assigned = fetchCalls
		.filter((call) => call.url.includes("session-chains.assign"))
		.find((call) => {
			try {
				return JSON.parse(call.init.body).sessionId === "s-loose";
			} catch {
				return false;
			}
		});
	check(assigned !== undefined, "Enter 會 POST 到歸鏈路由");
	check(assigned !== undefined && JSON.parse(assigned.init.body).sessionId === "s-loose", "POST body 帶 sessionId");
}


// ⑧ 開面板／換場時，把「你在這裡」那一列帶進視野（`block: "nearest"`＝已經看得到就不動）
const scrollRow = created.find((node) => node.props?.["data-current-row"] === "s-loose");
check(scrollRow?.props?.ref !== undefined, "只有目前那一列掛 ref（要帶進視野）");
const scrollCalls = [];
if (scrollRow?.props?.ref !== undefined) {
	// 模擬真實 React 掛載後把 DOM 節點放進 ref。
	scrollRow.props.ref.current = { scrollIntoView: (options) => scrollCalls.push(options ?? {}) };
	setCurrentSession("s-next");
	await settle(panel.component);
	check(scrollCalls.some((options) => options.block === "nearest"), "換場時把目前那一列帶進視野（nearest）");
}

// ── Task 4（2026-10-18）：自動編號的套用邏輯 ────────────────────────────────
const applyPlan = sandbox.captured.exports.applyNumberingPlan;
check(typeof applyPlan === "function", "匯出 applyNumberingPlan（可測的套用邏輯）");

/** 造一筆「要改」的計畫。 */
function planOf(items, extra = {}) {
	return { items, total: items.length, needsConfirm: items.length > 10, restores: [], ...extra };
}

// ① 正常：兩筆 → rename 兩次（依序）、POST 一次
{
	renameCalls.length = 0;
	const posts = [];
	const result = await applyPlan({
		plan: planOf([
			{ sessionId: "b", from: "x-002", to: "x-003", chain: "x" },
			{ sessionId: "a", from: null, to: "x-002", chain: "x" },
		]),
		sessions: fakeSessions,
		post: async (payload) => posts.push(payload),
	});
	check(result.status === "applied" && renameCalls.length === 2, "兩筆計畫 → 呼叫 rename 兩次", `status=${result.status}`);
	check(renameCalls[0]?.sessionId === "b", "由大到小套用（先改號碼大的）");
	check(posts.length === 1 && posts[0].applied.length === 2, "改完 POST 一次（帶 applied）");
}

// ② 暫停：完全不動
{
	renameCalls.length = 0;
	const result = await applyPlan({ plan: planOf([{ sessionId: "a", from: null, to: "x-001" }]), sessions: fakeSessions, post: async () => {}, paused: true });
	check(result.status === "skipped-paused" && renameCalls.length === 0, "暫停時不呼叫 rename");
}

// ③ 需要確認：未確認前不自動套用
{
	renameCalls.length = 0;
	const blocked = await applyPlan({ plan: planOf([{ sessionId: "a", from: null, to: "x-001" }], { needsConfirm: true }), sessions: fakeSessions, post: async () => {} });
	check(blocked.status === "skipped-confirm" && renameCalls.length === 0, "needsConfirm 時不自動套用");
	const forced = await applyPlan({ plan: planOf([{ sessionId: "a", from: null, to: "x-001" }], { needsConfirm: true }), sessions: fakeSessions, post: async () => {}, force: true });
	check(forced.status === "applied", "使用者按了確認 → force 才套用");
}

// ④ 失敗：只記錄，不中斷其他
{
	const posts = [];
	const result = await applyPlan({
		plan: planOf([{ sessionId: "bad", from: null, to: "x-001" }, { sessionId: "ok", from: null, to: "x-002" }]),
		sessions: { rename: async (id) => (id === "bad" ? { ok: false, error: { message: "session/title-invalid" } } : { ok: true }) },
		post: async (payload) => posts.push(payload),
	});
	check(result.status === "applied" && result.applied.length === 1 && result.failed.length === 1, "一場失敗其餘照做");
	check(posts[0]?.failed?.[0]?.reason?.includes("title-invalid") === true, "失敗原因帶回給宿主/卡片", JSON.stringify(posts[0]?.failed));
}

// ⑤ 服務缺席：不拋錯，回 skipped-no-service
{
	const result = await applyPlan({ plan: planOf([{ sessionId: "a", from: null, to: "x-001" }]), sessions: undefined, post: async () => {} });
	check(result.status === "skipped-no-service", "改名服務不在 → 安全跳過（不崩）");
}

// ⑥ 沒有要改的：完全不打 API
{
	const result = await applyPlan({ plan: planOf([]), sessions: fakeSessions, post: async () => {} });
	check(result.status === "skipped-nothing", "沒有差異就不打 API");
}

// ── Task 5（2026-10-18）：側邊欄卡片 ────────────────────────────────────────
const createCard = sandbox.captured.exports.createCard;
const mountCard = sandbox.captured.exports.mountCard;
const readCardState = sandbox.captured.exports.readCardState;
check(typeof createCard === "function" && typeof mountCard === "function", "匯出 createCard／mountCard");

/** 假的 numbering（卡片渲染不該真的去改名）。 */
const quietNumbering = {
	get: () => ({ paused: false, status: "idle", applied: 0, failed: 0, pending: 0, at: 0 }),
	subscribe: () => () => {},
	onApplied: () => () => {},
	run: () => {},
	togglePaused: () => false,
	confirm: () => {},
};

check(readCardState().open === false && readCardState().chains.length === 0, "卡片預設收合");

setCurrentSession("s-next");
const Card = createCard({
	numbering: quietNumbering,
	openSession: (id) => openCalls.push(id),
	workspaceService: () => fakeWorkspace,
	openPanel: () => {},
});
await settle(Card);
check(created.some((node) => node.props?.["data-card-strip"] !== undefined), "卡片有收合列");
// 2026-10-18：摘要預設關閉（使用者不需要「N 條鏈・M 場」）；打開設定才顯示。
check(textsOf().includes("交接鏈"), "收合列只顯示「交接鏈」");
sandbox.captured.exports.writeSettings({ showCardSummary: true });
await settle(Card);
check(
	textsOf().some((text) => text.includes("交接鏈 ·") && text.includes("條鏈") && text.includes("場")),
	"打開摘要後顯示「條鏈／場」",
	textsOf().find((text) => text.includes("交接鏈 ·")) ?? "",
);
sandbox.captured.exports.writeSettings({ showCardSummary: false });
await settle(Card);
check(created.find((node) => node.props?.["data-card-session"] !== undefined) === undefined, "收合時不渲染場次");

// 展開卡片 → 看到鏈列，但還沒展開任何鏈
created.find((node) => node.props?.["data-card-strip"] !== undefined).props.onClick();
await settle(Card);
check(created.some((node) => node.props?.["data-chain-row"] === "dsh-demo"), "展開後列出鏈");
	// 2026-10-18：展開卡片時工作區被整個覆蓋 → 限定卡片高度、工作區保底留一行。
	const openCardRoot = created.find((node) => node.props?.["data-session-chains-card"] !== undefined);
	check(openCardRoot?.props?.["data-open"] === "1", "展開卡片掛 data-open=1（CSS 才知道要限高）");
	check(created.some((node) => node.props?.["data-card-body"] !== undefined), "卡片有獨立的捲動區（表頭不會被捲走）");
check(created.find((node) => node.props?.["data-card-session"] !== undefined) === undefined, "沒點鏈之前不顯示場次");
check(readCardState().open === true, "展開狀態被記住");

// 點一條鏈 → 只展開那一條
created.find((node) => node.props?.["data-chain-row"] === "dsh-demo").props.onClick();
await settle(Card);
const cardSessions = created.filter((node) => node.props?.["data-card-session"] !== undefined);
check(cardSessions.length === 2, "點鏈 → 只展開那一條鏈的 2 場", `找到 ${cardSessions.length}`);
const numbers = created.filter((node) => node.props?.["data-card-number"] !== undefined).map((node) => node.children[0]);
check(numbers.join(",") === "001,002", "場次列有編號 001／002", numbers.join(","));
check(created.some((node) => node.props?.["data-current-row"] === "s-next"), "卡片裡也有「你在這裡」亮底");
check(readCardState().chains.includes("dsh-demo"), "展開的鏈被記住");

// 再點一次收合
created.find((node) => node.props?.["data-chain-row"] === "dsh-demo").props.onClick();
await settle(Card);
check(created.filter((node) => node.props?.["data-card-session"] !== undefined).length === 0, "再點一次收合該鏈");

// ── 2026-10-18：卡片上就地改名（使用者：改名只能再進去下一層，太麻煩）─────────
{
	// 先展開一條鏈：才好驗「改完名展開狀態跟著換名字」（否則鏈會突然收起來）。
	created.find((node) => node.props?.["data-chain-row"] === "dsh-demo").props.onClick();
	await settle(Card);
	check(readCardState().chains.includes("dsh-demo"), "就地改名：改名前 dsh-demo 是展開的");

	const pencil = created.find((node) => node.props?.["data-card-chain-rename"] === "dsh-demo");
	check(pencil !== undefined, "鏈列右側有「✎」（不必先開浮層）");
	const renameCallsBefore = fetchCalls.filter((call) => call.url.includes("session-chains.rename")).length;
	pencil.props.onClick({ stopPropagation: () => {} });
	await settle(Card);
	check(created.some((node) => node.props?.["data-card-chain-edit"] === "dsh-demo"), "點 ✎ → 這一列就地變成輸入框");
	check(
		fetchCalls.filter((call) => call.url.includes("session-chains.rename")).length === renameCallsBefore,
		"只是進編輯，不會偷打改名 API",
	);

	const cardInput = created.find((node) => node.props?.["data-card-chain-input"] !== undefined);
	check(cardInput !== undefined, "卡片改名輸入框出現");
	check(cardInput?.props?.defaultValue === "dsh-demo", "輸入框預填目前的鏈名", String(cardInput?.props?.defaultValue));
	cardInput.props.onChange({ target: { value: "模擬聲音工程" } });
	await settle(Card);
	created
		.find((node) => node.props?.["data-card-chain-input"] !== undefined)
		.props.onKeyDown({ key: "Enter", stopPropagation: () => {} });
	await settle(Card);

	const cardRenameCalls = fetchCalls.filter((call) => call.url.includes("session-chains.rename"));
	check(cardRenameCalls.length === renameCallsBefore + 1, "卡片改名只打一次 API（與面板同一條路）", `呼叫 ${cardRenameCalls.length} 次`);
	const cardPosted = cardRenameCalls.pop();
	check(cardPosted !== undefined && JSON.parse(cardPosted.init.body).to === "模擬聲音工程", "POST body 帶新名稱");
	check(cardPosted !== undefined && cardPosted.init.headers["content-type"] === "application/json", "卡片改名也帶 application/json");
	check(
		readCardState().chains.includes("模擬聲音工程") && !readCardState().chains.includes("dsh-demo"),
		"改名後展開狀態跟著換名字（鏈不會突然收起來）",
		JSON.stringify(readCardState().chains),
	);
	check(created.find((node) => node.props?.["data-card-chain-input"] !== undefined) === undefined, "送出後收起輸入框");
}

// 掛載位置：插在「今日消費」卡之前
{
	const usageCard = { tag: "usage", style: {} };
	const settings = { tag: "settings", style: {} };
	const foot = {
		children: [usageCard, settings],
		querySelector: (selector) => (selector.includes("usage") ? usageCard : selector.includes("settingsArea") ? settings : null),
		insertBefore(node, anchor) {
			const index = this.children.indexOf(anchor);
			this.children.splice(index < 0 ? this.children.length : index, 0, node);
			node.nextElementSibling = anchor ?? null;
		},
		appendChild(node) {
			this.children.push(node);
		},
	};
	const makeDoc = (collapsed) => ({
		createElement: () => ({ style: {}, setAttribute() {}, remove() { this.removed = true; } }),
		// `[class*="sidebarCol"] [class*="footArea"]` 命中的就是 foot 本身（後代選擇器）
		querySelector: (selector) => (selector.includes("footArea") ? foot : null),
		documentElement: { hasAttribute: (name) => (collapsed ? name === "data-sidebar-collapsed" : false) },
		body: { hasAttribute: () => false },
	});
	const rendered = [];
	const dispose = mountCard({
		document: makeDoc(false),
		createRoot: () => ({ render: (element) => rendered.push(element), unmount: () => rendered.push("unmount") }),
		component: () => null,
	});
	check(rendered.length === 1, "掛載時建立 React root 並 render");
	const cardContainer = foot.children.find((child) => child?.tag === undefined && child?.nextElementSibling === usageCard);
	check(foot.children[0] !== usageCard && foot.children[0]?.nextElementSibling === usageCard, "卡片插在「今日消費」卡之前");
	check(cardContainer !== undefined || foot.children.length === 3, "footArea 內多了一個容器");
	dispose();
	check(rendered.includes("unmount"), "disposer 會卸載");

	const hidden = { style: {}, setAttribute() {}, remove() {} };
	const hiddenDoc = makeDoc(true);
	hiddenDoc.createElement = () => hidden;
	mountCard({ document: hiddenDoc, createRoot: () => ({ render() {} }), component: () => null });
	check(hidden.style.display === "none", "側邊欄收合時卡片隱藏");

	const noOp = mountCard({ document: { createElement: () => ({ style: {}, setAttribute() {} }), querySelector: () => null, documentElement: { hasAttribute: () => false } }, createRoot: () => ({ render() {} }), component: () => null });
	check(typeof noOp === "function", "找不到掛載點 → 安全退回（no-op disposer）");
	noOp();
}

// ── 2026-10-18 崩潰後補：卡片掛載必須是「單一實例、便宜校正」 ──────────────
// 兩次「畫面全停止」都發生在卡片上線後。最可能的原因是 HMR 每次重載都多掛一個
// React root（各自帶輪詢與 document.body 的 MutationObserver）→ 串流時被上千次 DOM 變動打爆。
// 這裡把「不得重複掛載」與「不靠 observer 也會自己歸位」固定成測試。

/** 造一份最小假 DOM（footArea ＋ 第三方「今日消費」卡）。 */
function fakeSidebar() {
	const usageCard = { tag: "usage", style: {} };
	const settings = { tag: "settings", style: {} };
	const foot = {
		children: [usageCard, settings],
		querySelector: (selector) => (selector.includes("usage") ? usageCard : selector.includes("settingsArea") ? settings : null),
		insertBefore(node, anchor) {
			const index = this.children.indexOf(anchor);
			this.children.splice(index < 0 ? this.children.length : index, 0, node);
			node.nextElementSibling = anchor ?? null;
		},
		appendChild(node) {
			this.children.push(node);
		},
		contains: (node) => foot.children.includes(node),
	};
	const containers = [];
	const doc = {
		createElement: () => {
			const container = {
				style: {},
				setAttribute() {},
				// 忠實模擬真實 DOM：remove() 會把自己從父節點拔掉、nextElementSibling 也會失效。
				remove() {
					this.removed = true;
					const index = foot.children.indexOf(container);
					if (index >= 0) foot.children.splice(index, 1);
					this.nextElementSibling = null;
				},
			};
			containers.push(container);
			return container;
		},
		querySelector: (selector) => (selector.includes("footArea") ? foot : null),
		querySelectorAll: () => [],
		documentElement: { hasAttribute: () => false },
		body: { hasAttribute: () => false },
	};
	return { doc, foot, containers };
}

/** 這個 foot 裡現在有幾個「卡片容器」（容器沒有 tag）。 */
function containerCount(foot) {
	return foot.children.filter((child) => child && child.tag === undefined).length;
}

{
	// ① 連續掛載兩次（模擬 HMR 重載）→ 舊的一定被收掉，畫面只留一張
	const { doc, foot, containers } = fakeSidebar();
	const log = [];
	const dispose1 = mountCard({ document: doc, createRoot: () => ({ render: () => log.push("root1"), unmount: () => log.push("unmount1") }), component: () => null, reconcileMs: 1000 });
	const dispose2 = mountCard({ document: doc, createRoot: () => ({ render: () => log.push("root2"), unmount: () => log.push("unmount2") }), component: () => null, reconcileMs: 1000 });
	check(log.includes("unmount1"), "重複掛載會先卸載上一個實例（HMR 不會疊 root）");
	check(containerCount(foot) === 1, "畫面上只留一個卡片容器", `實際 ${containerCount(foot)}`);
	check(containers[0]?.removed === true, "舊容器被移掉");
	dispose2();

	// ② 不靠 MutationObserver：容器被移走後，定時校正會把它放回去
	const again = fakeSidebar();
	const dispose3 = mountCard({ document: again.doc, createRoot: () => ({ render() {}, unmount() {} }), component: () => null, reconcileMs: 5 });
	check(containerCount(again.foot) === 1, "掛載後容器在 footArea");
	again.foot.children = again.foot.children.filter((child) => child !== again.containers[0]);
	await new Promise((resolve) => setTimeout(resolve, 260));
	check(containerCount(again.foot) === 1, "被移走後會自動歸位（2 秒校正，不用 observer）");
	dispose3();
	again.foot.children = again.foot.children.filter((child) => !again.containers.includes(child));
	await new Promise((resolve) => setTimeout(resolve, 40));
	check(containerCount(again.foot) === 0, "dispose 後就不再歸位（不會復活）");
}

// ── 2026-10-18 使用者回報「左邊有兩個交接鏈」→ 卡片掛好就把 footer 按鈕收起來 ──
{
	const placed = [];
	const { doc } = fakeSidebar();
	const dispose = mountCard({ document: doc, createRoot: () => ({ render() {}, unmount() {} }), component: () => null, reconcileMs: 1000, onPlaced: (value) => placed.push(value) });
	check(placed[0] === true, "掛好卡片 → 回報 true（footer 按鈕會收起來）", JSON.stringify(placed));
	dispose();
	check(placed[placed.length - 1] === false, "卡片卸載 → 回報 false（按鈕回來當備援）", JSON.stringify(placed));

	const missing = [];
	const noFoot = mountCard({
		document: { createElement: () => ({ style: {}, setAttribute() {}, remove() {} }), querySelector: () => null, documentElement: { hasAttribute: () => false } },
		createRoot: () => ({ render() {}, unmount() {} }),
		component: () => null,
		onPlaced: (value) => missing.push(value),
	});
	check(missing.includes(false), "掛不上卡片 → 回報 false（保留 footer 按鈕）", JSON.stringify(missing));
	noFoot();
}

// ── 2026-10-18：上方「工作區／會話」區塊可折疊（整合進內建那一列）──────────
// 內建那一列（sectionHeader）＝「工作區」＋查詢（放大鏡）＋分組方式＋新增工作區（資料夾）。
// 使用者的要求：箭頭就放進**那一列**、不要任何「收合／折疊」字眼，只有上下箭頭。
// 折起來的是列**下方**的清單，那一列本身要留著（否則就沒有東西可以再展開）。
{
	const mountFold = sandbox.captured.exports.mountWorkspaceFold;
	const readFold = sandbox.captured.exports.readWorkspaceFold;
	check(typeof mountFold === "function" && typeof readFold === "function", "匯出 mountWorkspaceFold／readWorkspaceFold");

	/** 造一個「側欄 → 工作區區塊 → 內建那一列（工作區／查詢／清單）」的最小假 DOM。 */
	function fakeWorkspaceSidebar() {
		const nodes = [];
		const makeEl = (tag) => {
			const el = {
				tag,
				attrs: {},
				children: [],
				style: {},
				setAttribute(name, value) {
					this.attrs[name] = String(value);
				},
				removeAttribute(name) {
					delete this.attrs[name];
				},
				getAttribute(name) {
					return this.attrs[name] ?? null;
				},
				appendChild(node) {
					this.children.push(node);
					node.parent = this;
					node.parentElement = this;
				},
				insertBefore(node, ref) {
					const index = ref === null || ref === undefined ? this.children.length : this.children.indexOf(ref);
					this.children.splice(index < 0 ? this.children.length : index, 0, node);
					node.parent = this;
					node.parentElement = this;
				},
				contains(node) {
					return this.children.includes(node);
				},
				querySelector(selector) {
					// 真 DOM 的 querySelector 是「往下找全部子孫」，這裡也要照做（sectionHeader 在孫輩）。
					if (!selector.includes("sectionHeader")) return null;
					const search = (node) => {
						for (const child of node.children) {
							if (String(child.className ?? "").includes("sectionHeader")) return child;
							const deeper = search(child);
							if (deeper !== null) return deeper;
						}
						return null;
					};
					return search(this);
				},
				querySelectorAll(selector) {
					if (!selector.includes("data-sc-ws-toggle")) return [];
					return nodes.filter((node) => node.parent === this && node.attrs?.["data-sc-ws-toggle"] !== undefined);
				},
				remove() {
					this.removed = true;
					if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this);
				},
			};
			Object.defineProperty(el, "firstElementChild", { get() { return this.children[0] ?? null; } });
			nodes.push(el);
			return el;
		};

		const region = makeEl("div");
		region.className = "_x_regionArea";
		const browser = makeEl("div");
		browser.className = "_x_root";
		const header = makeEl("div");
		header.className = "_x_sectionHeader";
		const label = makeEl("span");
		label.textContent = "工作區";
		const search = makeEl("div");
		search.className = "_x_searchSlot";
		const list = makeEl("div");
		list.className = "_x_list";
		header.appendChild(label);
		header.appendChild(search);
		browser.appendChild(header);
		browser.appendChild(list);
		region.appendChild(browser);

		const head = makeEl("head");
		const doc = {
			createElement: (tag) => makeEl(tag),
			createElementNS: (_ns, tag) => makeEl(tag),
			querySelector: (selector) =>
				selector.includes("regionArea")
					? region
					: selector.includes("#session-chains-fold-style")
						? (head.children.find((child) => child.id === "session-chains-fold-style") ?? null)
						: null,
			querySelectorAll: (selector) =>
				selector.includes("data-sc-ws-toggle")
					? nodes.filter((node) => node.attrs?.["data-sc-ws-toggle"] !== undefined)
					: [],
			getElementById: (id) => head.children.find((child) => child.id === id) ?? null,
			head,
			documentElement: { appendChild() {}, hasAttribute: () => false },
			body: { hasAttribute: () => false },
		};
		return { doc, region, browser, header, label, search, list, head, nodes };
	}

	const FOLD_KEY = "dsh.session-chains.workspace-fold";
	store.delete(FOLD_KEY);

	// ① 箭頭插進內建那一列的最前面，沒有文字，預設展開
	const first = fakeWorkspaceSidebar();
	const dispose = mountFold({ document: first.doc, reconcileMs: 5 });
	const toggle = first.header.children[0];
	check(toggle !== undefined && toggle.attrs["data-sc-ws-toggle"] !== undefined, "箭頭插進內建的工作區那一列（不是自己另開一條）");
	check(toggle !== first.label && toggle !== first.search, "箭頭是額外一顆，沒有動到原本的工作區標題與查詢");
	check(toggle.children.some((child) => child.tag === "svg"), "箭頭是 SVG（跟內建圖示同一種筆畫）");
	check(String(toggle.textContent ?? "") === "", "箭頭按鈕沒有任何文字（只有上下箭頭）", String(toggle.textContent));
	check(toggle.attrs["data-folded"] === "0", "預設展開：箭頭朝上");
	check(first.region.getAttribute("data-sc-ws-fold") === null && first.browser.getAttribute("data-sc-ws-body") === null, "預設展開：不改使用者的畫面");
	check(first.header.children.includes(first.label) && first.header.children.includes(first.search), "那一列的標題與查詢原封不動");
	check(first.browser.children.includes(first.list), "清單還在（只是可以收）");
	check(
		(first.head.children.find((child) => child.id === "session-chains-fold-style")?.textContent ?? "").includes('[class*="sectionHeader"]'),
		"折疊規則是「只留那一列」：用 class 認那一列（React 換掉節點也不會把列藏起來）",
	);
	// 2026-10-18：收合時不要再捲整個卡片（否則標題列會被捲走）。
	check(
		(first.head.children.find((child) => child.id === "session-chains-fold-style")?.textContent ?? "").includes(
			'> [data-session-chains-card] > [data-session-chains-card]',
		),
		"收合模式：捲動交給清單，標題列固定在卡片頂端",
	);

	// ② 按一下 → 收合：屬性掛在對的地方，箭頭翻成朝下
	toggle.onclick({ stopPropagation: () => {}, preventDefault: () => {} });
	check(first.region.getAttribute("data-sc-ws-fold") === "1", "收合：讓高度的屬性掛在 regionArea");
	check(first.browser.getAttribute("data-sc-ws-body") === "1", "收合：藏清單的屬性掛在清單的父節點（那一列不在裡面）");
	check(first.header.getAttribute("data-sc-ws-body") === null, "那一列自己沒有被標記（所以它會留著）");
	check(toggle.attrs["data-folded"] === "1", "收合：箭頭翻成朝下");
	check(toggle.attrs["aria-expanded"] === "false", "收合：aria-expanded=false");
	check(store.get(FOLD_KEY) === "1" && readFold() === true, "收合狀態記在 localStorage");

	// ③ 再按一下 → 展開
	toggle.onclick({ stopPropagation: () => {}, preventDefault: () => {} });
	check(first.region.getAttribute("data-sc-ws-fold") === null && first.browser.getAttribute("data-sc-ws-body") === null, "再按一下展開");
	check(toggle.attrs["data-folded"] === "0", "展開：箭頭回到朝上");
	check(store.get(FOLD_KEY) === undefined, "展開也記得（下次不要又收起來）");

	// ④ 被 React 移走 → 2 秒校正會放回那一列的最前面，收合狀態不丟
	toggle.onclick({ stopPropagation: () => {}, preventDefault: () => {} });
	first.header.children = first.header.children.filter((child) => child !== toggle);
	check(first.header.contains(toggle) === false, "（模擬 React 重繪把我們的節點搬走）");
	await new Promise((resolve) => setTimeout(resolve, 260));
	check(first.header.children[0] === toggle, "被移走後會自己回到那一列最前面（不用 observer）");
	check(first.region.getAttribute("data-sc-ws-fold") === "1", "放回去後仍然是收合狀態");

	// ⑤ dispose：箭頭拿掉、屬性拿掉，但**保留使用者的選擇**
	dispose();
	check(toggle.removed === true, "dispose 會把箭頭移除");
	check(first.region.getAttribute("data-sc-ws-fold") === null && first.browser.getAttribute("data-sc-ws-body") === null, "dispose 會把折疊屬性拿掉（畫面復原）");
	check(readFold() === true, "使用者的收合選擇會保留（不是外掛殘留）");

	// ⑥ 重複掛載（模擬 HMR）→ 那一列只留一顆箭頭，樣式也只有一份
	const again = fakeWorkspaceSidebar();
	const d1 = mountFold({ document: again.doc, reconcileMs: 5 });
	const d2 = mountFold({ document: again.doc, reconcileMs: 5 });
	check(again.header.children.filter((child) => child.attrs?.["data-sc-ws-toggle"] !== undefined).length === 1, "重複掛載只留一顆箭頭（HMR 不會疊）");
	check(again.head.children.filter((child) => child.id === "session-chains-fold-style").length === 1, "重複掛載也只有一份樣式");
	check(
		(again.head.children.find((child) => child.id === "session-chains-fold-style")?.textContent ?? "").includes('data-sc-ws-toggle'),
		"重複掛載會**覆寫**樣式內容（HMR 熱重載時新規則才生效）",
	);
	d1();
	d2();

	// ⑦ 側欄收成細軌（56px）時那一顆要跟著隱藏，不然會擠爆軌道
	const rail = fakeWorkspaceSidebar();
	rail.doc.documentElement = { appendChild() {}, hasAttribute: (name) => name === "data-sidebar-collapsed" };
	const railDispose = mountFold({ document: rail.doc, reconcileMs: 5 });
	const railToggle = rail.header.children[0];
	check(railToggle?.style?.display === "none", "側欄收成細軌時，箭頭跟著隱藏", String(railToggle?.style?.display));
	railDispose();

	// ⑧ 找不到 regionArea（版本不同／側欄還沒掛好）→ 安全退回
	const noRegion = mountFold({
		document: {
			createElement: () => ({ attrs: {}, style: {}, setAttribute() {}, removeAttribute() {}, remove() {}, appendChild() {} }),
			querySelector: () => null,
			querySelectorAll: () => [],
			documentElement: { appendChild() {} },
			head: { appendChild() {} },
		},
		reconcileMs: 5,
	});
	check(typeof noRegion === "function", "找不到工作區區塊 → 安全退回（no-op）");
	noRegion();
	store.delete(FOLD_KEY);
}

// ── 2026-10-18：交接強制提醒（超過門檻不能只有右下角變色）──────────
// 使用者追加的兩條規則（實測回饋）：
//   ① 串流中不要跳（「訊息還在跳，你複製的已經是舊資訊」）→ 只在這一輪結束才出現、才複製
//   ② 要長在**輸入框正上方置中**（插槽本來就在那裡、而且已經同寬），不要自己 fixed 到頂部
{
	const handoffLevel = sandbox.captured.exports.handoffLevel;
	const HandoffGuard = sandbox.captured.exports.HandoffGuard;
	const HandoffGuardBody = sandbox.captured.exports.HandoffGuardBody;
	const handoffPrompt = sandbox.captured.exports.handoffPrompt;
	check(
		typeof handoffLevel === "function" && typeof HandoffGuard === "function" && typeof HandoffGuardBody === "function",
		"匯出 handoffLevel／HandoffGuard（提醒元件）",
	);

	// ① 純函式：三個訊號任一達標就要叫
	check(handoffLevel({ steps: 20, tokens: 50000, contextWindow: 200000 }).level === "ok", "未達門檻 → ok");
	check(handoffLevel({ steps: 210 }).level === "warn", "請求 210 次 → warn（預設 200）");
	check(handoffLevel({ steps: 330 }).level === "hard", "請求 330 次 → hard（預設 320）");
	check(handoffLevel({ tokens: 330000 }).level === "warn", "上下文 330k → warn（預設 320k）");
	check(handoffLevel({ tokens: 490000 }).level === "hard", "上下文 490k → hard（預設 480k）");
	check(handoffLevel({ tokens: 140000, contextWindow: 200000 }).level === "hard", "200k 視窗用掉 70% → hard（比例也算，預設 65%）");
	check(handoffLevel({ steps: undefined, tokens: undefined }).level === "ok", "讀不到數字 → 不亂叫");
	check(handoffLevel({ steps: Number.POSITIVE_INFINITY }).level === "ok", "非有限值不觸發");
	check(handoffLevel({ steps: 130, thresholds: { hardSteps: 999 } }).level !== "hard", "門檻可用 thresholds 覆寫（130 次不再算 hard）");
	check(handoffLevel({ steps: 330, tokens: 490000 }).reasons.length >= 2, "hard 會說出哪幾條超標");

	// ② 指示文字
	const prompt = handoffPrompt({ chain: "交接鏈" });
	check(prompt.includes("鏈=交接鏈"), "交接指示帶目前的鏈代號");
	check(prompt.includes("CLAUDE.md 13.6") && prompt.includes("≤60 行"), "交接指示含規則依據與交接單行數上限");
	// 2026-10-18 對照 CLAUDE.md 13.6 補齊的三件事（使用者問「這樣正確嗎」）
	check(prompt.includes("交接-<YYYY-MM-DD>.md"), "交接指示寫出檔名規則");
	check(prompt.includes("HANDOFF.md"), "交接指示說明「已有 HANDOFF.md 就更新它」");
	check(prompt.includes("還要繼續") && prompt.includes("宣布卡住"), "三種結論各自的條件都寫了（不只『宣布完成』）");
	check(prompt.includes("交接單也要記下本場的鏈代號"), "交接單本身也要記鏈代號");
	const noChain = handoffPrompt();
	check(noChain.includes("鏈=<代號>"), "沒有鏈名時用 鏈=<代號> 佔位", noChain.split("\n").find((line) => line.includes("鏈=")) ?? "");
	check(!/鏈=代號[：:]/u.test(prompt) && !/鏈=代號[：:]/u.test(noChain), "不要在 鏈= 後面接冒號（會被解析成鏈名「代號」）");
	// 2026-10-18：門檻改成「依面板 ⚙ 現值」之後，指示裡不能再寫死 240k。
	check(!prompt.includes("240k") && prompt.includes("⚙ 現值"), "交接指示不寫死 240k（以面板 ⚙ 現值為準）");
	// 2026-10-18 收尾「貼上就能開工」：模型自己把產出的提示詞放進剪貼簿，並先核對再動手。
	// 同日第三輪（使用者反映交接太慢）：預設輕交接、只有重交接才重跑全套基線。
	check(
		prompt.includes("pbcopy") &&
			prompt.includes("pbpaste | head -3") &&
			prompt.includes("鏈上前一場") &&
			prompt.includes("回報差異") &&
			prompt.includes("輕交接") &&
			prompt.includes("重交接"),
		"交接指示：分輕／重兩級、產出後 pbcopy＋pbpaste 驗第一行、狀態接鏈上前一場、接手先核對回報",
	);

	// ③ 元件邊界：插槽少給任何一個讀取器就不渲染（不要亂呼叫 hook）
	check(HandoffGuard({}) === null, "插槽沒給讀取器 → 不渲染");
	check(HandoffGuard({ useProjection: () => ({}) }) === null, "只有 useProjection、沒有 useSession → 也不渲染（無法判斷這一輪結束沒）");

	/** 用假的投影／連線狀態渲染一次提醒本體（每次新元件身分，state 才是乾淨的）。 */
	const renderGuard = (values, running = false) => {
		const component = () =>
			HandoffGuardBody({
				useProjection: (name) => values[name],
				useSession: (selector) => selector({ running }),
			});
		return settle(component);
	};
	const warnValues = { contextPressure: { projectedTokens: 330000, contextWindow: 1048576 }, sessionStats: { steps: 210 } };
	const hardValues = { contextPressure: { projectedTokens: 490000, contextWindow: 1048576 }, sessionStats: { steps: 330 } };

	store.delete("dsh.session-chains.handoff-defer");

	// ④ 未達門檻：什麼都沒有
	await renderGuard({ contextPressure: { projectedTokens: 50000, contextWindow: 200000 }, sessionStats: { steps: 20 } });
	check(created.find((node) => node.props?.["data-handoff-guard"] !== undefined) === undefined, "未達門檻：畫面上沒有提醒");

	// ⑤ 達門檻但**這一輪還在跑** → 不跳（使用者回報的那個問題）
	clipboardWrites.length = 0;
	await renderGuard(hardValues, true);
	check(created.find((node) => node.props?.["data-handoff-guard"] !== undefined) === undefined, "串流中（running）不跳提醒 —— 訊息還在跳時不出現");
	check(clipboardWrites.length === 0, "串流中不會先做任何事（沒有自動複製、也沒有自動生成）");

	// ⑥ 這一輪結束 → 出現，而且在輸入框上方（一般區塊、同寬、不 fixed）
	await renderGuard(warnValues, false);
	const warnBanner = created.find((node) => node.props?.["data-handoff-guard"] === "warn");
	check(warnBanner !== undefined, "這一輪結束且超標 → 出現提醒");
	check((warnBanner?.props?.style?.position ?? "") === "fixed", "浮在訊息上面（不佔對話高度）", String(warnBanner?.props?.style?.position));
	check(warnBanner?.props?.style?.transform === "translateX(-50%)", "自己置中（left 由量測決定）");
	check(warnBanner?.props?.style?.left === "50%" && warnBanner?.props?.style?.top === "64px", "量不到座標時的後備位置（視窗中央／上方）", `${warnBanner?.props?.style?.left}/${warnBanner?.props?.style?.top}`);

	// 位置計算：對話欄正中央、訊息區最上面（不是視窗正中央 —— 左邊有側欄）
	const handoffAnchor = sandbox.captured.exports.handoffAnchor;
	const anchored = handoffAnchor({ dock: { left: 280, width: 800, top: 600 }, scroll: { top: 80 } });
	check(anchored?.left === 680 && anchored?.top === 88 && anchored?.width === 800, "座標＝對話欄中心、訊息區頂端＋8px", JSON.stringify(anchored));
	const narrow = handoffAnchor({ dock: { left: 300, width: 120, top: 600 }, scroll: { top: 40 } });
	check(narrow?.width === 240, "太窄時寬度至少 240px（不會擠成一團）", String(narrow?.width));
	check(handoffAnchor({ dock: null }) === null && handoffAnchor({}) === null, "量不到就回 null（元件用後備位置）");
	check(handoffAnchor({ dock: { left: 0, width: 0, top: 10 } }) === null, "寬度 0 也算量不到");
	const numbers = created.find((node) => node.props?.["data-handoff-numbers"] !== undefined);
	check(String(numbers?.children?.[0] ?? "").includes("330k") && String(numbers?.children?.[0] ?? "").includes("210"), "橫幅寫出本場 tokens／請求數", String(numbers?.children?.[0] ?? ""));

	// ⑦ 延後：時間內不再吵，時間到會自己回來
	store.set("dsh.session-chains.handoff-defer", String(Date.now() + 60000));
	await renderGuard(warnValues, false);
	check(created.find((node) => node.props?.["data-handoff-guard"] !== undefined) === undefined, "按了延後 → 時間內不再提醒");
	store.set("dsh.session-chains.handoff-defer", String(Date.now() - 1000));
	await renderGuard(warnValues, false);
	check(created.find((node) => node.props?.["data-handoff-guard"] !== undefined) !== undefined, "延後到期 → 提醒自己回來");
	store.delete("dsh.session-chains.handoff-defer");

	// ⑧ hard：出現提醒、沒有關掉的按鈕（2026-10-18 起不再自動複製，改用「生成交接詞」）
	clipboardWrites.length = 0;
	await renderGuard(hardValues, false);
	const hardBanner = created.find((node) => node.props?.["data-handoff-guard"] === "hard");
	check(hardBanner !== undefined, "超過強制門檻 → hard 級提醒");
	check(clipboardWrites.length === 0, "hard 級不再自動複製（改用一鍵生成交接詞）");
	check(created.find((node) => node.props?.["data-handoff-copy"] !== undefined) === undefined, "「複製交接指令」已移除");
	const deferButton = created.find((node) => node.props?.["data-handoff-defer"] !== undefined);
	check(String(deferButton?.children?.[0] ?? "").includes("5 分鐘"), "hard 級只能延後 5 分鐘（不能一次關掉整天）", String(deferButton?.children?.[0] ?? ""));
	check(
		created.filter((node) => node.props?.onClick !== undefined && String(node.children?.[0] ?? "") === "關閉").length === 0,
		"hard 級沒有「關閉」可按（這是強制提醒）",
	);

	store.delete("dsh.session-chains.handoff-defer");
}

// ── 2026-10-18：設定（打包出去之前，門檻／字級／顏色要能讓使用者自己調）──────
{
	const readSettings = sandbox.captured.exports.readSettings;
	const writeSettings = sandbox.captured.exports.writeSettings;
	const DEFAULT_SETTINGS = sandbox.captured.exports.DEFAULT_SETTINGS;
	check(typeof readSettings === "function" && typeof writeSettings === "function", "匯出 readSettings／writeSettings");

	store.delete("dsh.session-chains.settings");
	const defaults = readSettings();
	check(defaults.hardSteps === 320 && defaults.warnSteps === 200, "預設門檻依實際用量重定（提醒 200／強制 320）", `${defaults.warnSteps}/${defaults.hardSteps}`);
	check(defaults.hardTokens === 480000 && defaults.warnTokens === 320000, "預設上下文門檻依實際用量重定（320k／480k）");
	check(defaults.font === 12 && /^#[0-9A-Fa-f]{6}$/u.test(defaults.accent), "預設字級與提醒顏色");
	check(defaults.autoHandoff === true, "預設：到達門檻自動交接（生成＋開新對話＋切過去；可關）");
	// 後面的橫幅測試先關掉自動，避免一渲染就送訊息／開對話。
	writeSettings({ autoHandoff: false });

	const saved = writeSettings({ font: 14, accent: "#1565C0" });
	check(saved.font === 14 && saved.accent === "#1565C0", "改了就寫進 localStorage");
	check(readSettings().font === 14, "重讀得到（跨重新整理還在）");
	const clamped = writeSettings({ font: 99, accent: "不是顏色" });
	check(clamped.font === 16 && clamped.accent === DEFAULT_SETTINGS.accent, "壞值會被夾住／退回預設", `${clamped.font}/${clamped.accent}`);
	writeSettings({ warnSteps: 60, hardSteps: 90, accent: "#1565C0" });

	// 面板上的 ⚙：打開就看得到欄位，改了立刻反映在根節點的 --sc-font
	const openPanel = async () => {
		await settle(panel.component);
		if (created.some((node) => node.props?.["data-session-chains-panel"] !== undefined)) return;
		const footerTree = await settle(footer.component);
		footerTree?.props?.onClick?.();
		await settle(panel.component);
	};
	await openPanel();
	const gear = created.find((node) => node.props?.["data-sc-settings-toggle"] !== undefined);
	check(gear !== undefined, "面板上有 ⚙ 設定");
	gear.props.onClick();
	await settle(panel.component);
	check(created.some((node) => node.props?.["data-sc-settings"] !== undefined), "按 ⚙ → 出現設定區塊");
	const fontSelect = created.find((node) => node.props?.["data-sc-setting"] === "font");
	check(fontSelect !== undefined, "字級可以選（select）");
	fontSelect.props.onChange({ target: { value: "13" } });
	await settle(panel.component);
	check(readSettings().font === 13, "選了字級就寫入設定");
	const panelRoot = created.find((node) => node.props?.["data-session-chains-panel"] !== undefined);
	check(panelRoot?.props?.style?.["--sc-font"] === "13px", "面板根節點套用 --sc-font（字級真的變了）", String(panelRoot?.props?.style?.["--sc-font"]));
	check(created.some((node) => node.props?.["data-sc-setting"] === "accent" && node.props?.type === "color"), "提醒顏色可以用色票改");
	check(
		created.some((node) => node.props?.["data-sc-setting"] === "foldWorkspace" && node.props?.type === "checkbox"),
		"「工作區可折疊」是勾選項（設定裡決定要不要那顆箭頭）",
	);
	check(
		["showBalance", "showToday", "showWeek", "showMonth", "showSession"].every((key) =>
			created.some((node) => node.props?.["data-sc-setting"] === key && node.props?.type === "checkbox"),
		),
		"HUD 五段各自是勾選項",
	);
	check(
		["sessionColor", "hudBg", "highlight", "badge"].every((key) => created.some((node) => node.props?.["data-sc-setting"] === key && node.props?.type === "color")),
		"HUD 文字／HUD 背景／你在這裡／鏈標籤四個顏色都可以選",
	);
	const hudRow = created.find((node) => node?.children?.[0]?.children?.[0] === "HUD 顏色");
	check(hudRow !== undefined, "設定列的名稱是「HUD 顏色」（不是「本場文字」）");
	const hudColors = (hudRow?.children?.[1]?.children ?? []).filter((child) => child?.props?.type === "color");
	check(hudColors.length === 2, "HUD 的文字與背景兩個色票在同一行", `找到 ${hudColors.length} 個`);
	check(
		hudColors[0]?.props?.["data-sc-setting"] === "sessionColor" && hudColors[1]?.props?.["data-sc-setting"] === "hudBg",
		"同一行依序是「文字」與「背景」",
	);

	// 顏色真的生效：從面板的色票改（跟使用者操作同一條路），再看黃底與亮底
	created.find((node) => node.props?.["data-sc-setting"] === "badge")?.props?.onChange({ target: { value: "#FFD400" } });
	created.find((node) => node.props?.["data-sc-setting"] === "highlight")?.props?.onChange({ target: { value: "#FFE0E0" } });
	await settle(panel.component);
	const chainBadge = created.find((node) => node.props?.["data-chain-label"] === "dsh-demo");
	const badgeSpan = chainBadge?.children?.find((child) => typeof child === "object" && child?.props?.style?.background === "#FFD400");
	check(badgeSpan !== undefined, "鏈標籤的黃底跟著設定（badge）", JSON.stringify(chainBadge?.children?.map?.((c) => c?.props?.style?.background)));
	const currentRowAfter = created.find((node) => node.props?.["data-current-row"] !== undefined);
	check(String(currentRowAfter?.props?.style?.background ?? "").includes("FFE0E0"), "「你在這裡」的亮底跟著設定（highlight）", String(currentRowAfter?.props?.style?.background));
	created.find((node) => node.props?.["data-sc-setting"] === "badge")?.props?.onChange({ target: { value: DEFAULT_SETTINGS.badge } });
	created.find((node) => node.props?.["data-sc-setting"] === "highlight")?.props?.onChange({ target: { value: DEFAULT_SETTINGS.highlight } });
	await settle(panel.component);

	const foldBox = created.find((node) => node.props?.["data-sc-setting"] === "foldWorkspace");
	foldBox.props.onChange({ target: { checked: false } });
	await settle(panel.component);
	check(readSettings().foldWorkspace === false, "取消勾選會寫進設定（折疊器下一次校正就會收掉箭頭）");
	foldBox.props.onChange({ target: { checked: true } });
	await settle(panel.component);
	check(created.some((node) => node.props?.["data-sc-settings-reset"] !== undefined), "可以恢復預設");
	check(
		textsOf().some((text) => String(text).includes("dsh-token-hud")),
		"設定裡說清楚：餘額／今日／本週／本月是另一個外掛畫的",
	);

	// hard 的顏色真的跟著設定走
	const body = (values) => () =>
		sandbox.captured.exports.HandoffGuardBody({
			useProjection: (name) => values[name],
			useSession: (selector) => selector({ running: false }),
		});
	store.delete("dsh.session-chains.handoff-defer");
	const hardValues2 = { contextPressure: { projectedTokens: 490000, contextWindow: 1048576 }, sessionStats: { steps: 330 } };
	await settle(body(hardValues2));
	const hardBanner = created.find((node) => node.props?.["data-handoff-guard"] === "hard");
	check(String(hardBanner?.props?.style?.border ?? "").includes("#1565C0"), "提醒顏色跟著設定（hard 邊框用設定色）", String(hardBanner?.props?.style?.border));
	// 2026-10-18：提醒橫幅也要有「開新對話」（同意交接一鍵）。
	check(
		created.some((node) => node.props?.["data-handoff-start"] !== undefined),
		"提醒橫幅有「開新對話」按鈕",
	);
	// 有交接詞 → 可按；沒有 → 顯示「等交接詞…」且停用（不會再出現「已複製」卻說沒交接詞的矛盾）。
	const readyState = created.find((node) => node.props?.["data-handoff-start"] !== undefined)?.props?.["data-handoff-start"];
	check(readyState === "ready", "有交接詞時「開新對話」可按", `state=${readyState} prompt=${JSON.stringify(nextPromptForFetch)}`);
	nextPromptForFetch = "";
	await settle(body(hardValues2));
	const waitingButton = created.find((node) => node.props?.["data-handoff-start"] !== undefined);
	check(waitingButton?.props?.["data-handoff-start"] === "waiting" && waitingButton?.props?.disabled === true, "沒有交接詞時顯示「等交接詞…」且停用");
	check(String(waitingButton?.children?.[0] ?? "") === "等交接詞…", "按鈕文字是「等交接詞…」", String(waitingButton?.children?.[0] ?? ""));
	nextPromptForFetch = "先讀交接單\n鏈=dsh-demo";
	await settle(body(hardValues2));

	// 「生成交接詞」：把指令直接送進本場（不必複製貼上）。
	store.delete("dsh.session-chains.auto-prepared:s-next");
	writeSettings({ autoHandoff: false });
	promptCalls.length = 0;
	const prepareButton = created.find((node) => node.props?.["data-handoff-prepare"] !== undefined);
	check(prepareButton !== undefined, "橫幅有「生成交接詞」按鈕");
	await prepareButton?.props?.onClick?.();
	await settle(body(hardValues2));
	check(
		promptCalls.length === 1 && String(promptCalls[0]?.content?.[0]?.text ?? "").includes("【現在交接這一場】"),
		"按一下就把交接指令送進目前這一場（sessionId 正確）",
		JSON.stringify(promptCalls.map((call) => call.sessionId)),
	);
	check(promptCalls[0]?.sessionId === "s-next", "送進的是目前這一場", String(promptCalls[0]?.sessionId));

	// 自動交接（一個開關）：門檻到、這一輪結束 → 生成一次 → 交接詞好了就開新對話＋切過去
	store.delete("dsh.session-chains.auto-prepared:s-next");
	writeSettings({ autoHandoff: true });
	nextPromptForFetch = ""; // 還沒有交接詞（真實的一開始就是這樣）
	promptCalls.length = 0;
	createCalls.length = 0;
	const opensBeforeAuto = openCalls.length;
	await settle(body(hardValues2));
	const handoffSends = () => promptCalls.filter((call) => call.sessionId === "s-next").length;
	check(handoffSends() === 1, "自動交接：門檻一到、這一輪結束就送一次交接指令", `實際 ${handoffSends()}`);
	check(createCalls.length === 0, "交接詞還沒好之前不會開新對話");
	// AI 寫好交接詞檔了 → 橫幅再出現時應自動開＋貼＋切
	nextPromptForFetch = "先讀交接單\n鏈=dsh-demo";
	await settle(body(hardValues2));
	check(createCalls.length === 1, "交接詞好了就自動建立新對話", `實際 ${createCalls.length}`);
	check(openCalls.length > opensBeforeAuto && openCalls.includes("s-new"), "建立後自動切過去");
	check(handoffSends() === 1, "同一場不重複自動送（記在 localStorage）", `實際 ${handoffSends()}`);
	writeSettings({ autoHandoff: false });
	store.delete("dsh.session-chains.auto-prepared:s-next");

	// 收尾：回到預設，免得影響後面的檢查
	writeSettings(DEFAULT_SETTINGS);
	store.delete("dsh.session-chains.settings");
	store.delete("dsh.session-chains.suggest-dismissed");
}

// ── 2026-10-18：第一次接入時，把之前的對話整理進交接鏈（只建議、按了才寫）──
// 面板的「已整理過」是元件 state；這裡每次用**新的元件身分**渲染，才會重讀 localStorage。
{
	store.delete("dsh.session-chains.suggest-dismissed");
	// 前面的「自動開新對話」會切走並關掉面板 → 這裡先確保面板是開的。
	await settle(panel.component);
	if (!created.some((node) => node.props?.["data-session-chains-panel"] !== undefined)) {
		const footerTree = await settle(footer.component);
		footerTree?.props?.onClick?.();
		await settle(panel.component);
	}

	/** 開一個新的面板身分（hooks 狀態是乾淨的），並且重抓一次資料。 */
	const openFreshPanel = async () => {
		const fresh = () => panel.component({});
		await settle(fresh);
		const reloadButton = created.find((node) => node.children?.[0] === "重抓");
		reloadButton?.props?.onClick?.();
		await new Promise((resolve) => setTimeout(resolve, 30));
		await settle(fresh);
		return fresh;
	};

	// ① 有建議 → 列出來，而且說清楚不會自己動手
	payloadForFetch = { ...DEMO_PAYLOAD, suggestions: [{ label: "交接", size: 2, sessionIds: ["s-loose", "s-head"] }] };
	await openFreshPanel();
	check(created.some((node) => node.props?.["data-sc-suggest"] !== undefined), "有建議時，面板出現「建議整理」區塊");
	check(created.some((node) => node.props?.["data-sc-suggest-group"] === "交接"), "建議一組一組列（標籤）");
	check(textsOf().some((text) => String(text).includes("2 場")), "建議寫出這一組幾場");
	check(textsOf().some((text) => String(text).includes("按「併入」才會寫入")), "說清楚：不會自己動手（保留手動，避免併錯）");

	// ② 按「併入」→ 逐場走既有的歸鏈端點
	const beforeAssign = fetchCalls.filter((call) => call.url.includes("session-chains.assign")).length;
	const applyButton = created.find((node) => node.props?.["data-sc-suggest-apply"] === "交接");
	check(applyButton !== undefined, "每一組都有「併入」");
	applyButton?.props?.onClick?.();
	await new Promise((resolve) => setTimeout(resolve, 40));
	await settle(() => panel.component({}));
	const assignCalls = fetchCalls.filter((call) => call.url.includes("session-chains.assign"));
	check(assignCalls.length === beforeAssign + 2, "按「併入」逐場呼叫歸鏈（兩場 → 兩次）", `新增 ${assignCalls.length - beforeAssign} 次`);
	check(JSON.parse(assignCalls.at(-1).init.body).chain === "交接", "歸鏈的鏈名就是建議的標籤");
	check(JSON.parse(assignCalls.at(-1).init.body).sessionId === "s-head" || JSON.parse(assignCalls.at(-1).init.body).sessionId === "s-loose", "歸鏈帶的是建議裡的場次");
	check(JSON.parse(store.get("dsh.session-chains.suggest-dismissed")).includes("交接"), "併入後只記住**這一組**（其他組還會出現）");

	// ③ 略過 → 什麼都不寫，也記住
	store.delete("dsh.session-chains.suggest-dismissed");
	payloadForFetch = { ...DEMO_PAYLOAD, suggestions: [{ label: "公文", size: 2, sessionIds: ["s-loose", "s-head"] }] };
	await openFreshPanel();
	const skip = created.find((node) => node.props?.["data-sc-suggest-skip"] === "公文");
	check(skip !== undefined, "每一組都有「略過」");
	const assignsBeforeSkip = fetchCalls.filter((call) => call.url.includes("session-chains.assign")).length;
	skip?.props?.onClick?.();
	await settle(() => panel.component({}));
	check(
		fetchCalls.filter((call) => call.url.includes("session-chains.assign")).length === assignsBeforeSkip,
		"按「略過」不會寫任何東西",
	);
	check(JSON.parse(store.get("dsh.session-chains.suggest-dismissed")).includes("公文"), "略過也只記住那一組");

	payloadForFetch = DEMO_PAYLOAD;
	store.delete("dsh.session-chains.suggest-dismissed");
}

// ── 2026-10-19：置頂／封存（卡片上看得到的部分）──────────────────────────
{
	const createCard = sandbox.captured.exports.createCard;
	const writeSettings = sandbox.captured.exports.writeSettings;
	const DEFAULT_SETTINGS = sandbox.captured.exports.DEFAULT_SETTINGS;
	const quietNumbering = {
		get: () => ({ paused: false, status: "idle", applied: 0, failed: 0, pending: 0, at: 0 }),
		subscribe: () => () => {},
		onApplied: () => () => {},
		run: () => {},
		togglePaused: () => false,
		confirm: () => {},
	};

	// dsh-demo 置頂、dsh-demo-2 封存；排序故意用「名稱倒排」（正常會是 dsh-demo-2 在前）
	writeSettings({ ...DEFAULT_SETTINGS, sortBy: "chain", sortDir: "desc" });
	payloadForFetch = { ...DEMO_PAYLOAD, pinned: ["dsh-demo"], archived: ["dsh-demo-2"] };
	const Card = createCard({ numbering: quietNumbering, openSession: () => {}, workspaceService: () => fakeWorkspace, openPanel: () => {} });
	await settle(Card);

	const rowNames = created.filter((node) => node.props?.["data-chain-row"] !== undefined).map((node) => node.props["data-chain-row"]);
	check(!rowNames.includes("dsh-demo-2"), "封存的鏈不在卡片上", rowNames.join(","));
	check(rowNames.includes("dsh-demo"), "沒封存的鏈照常顯示", rowNames.join(","));
	check(rowNames[0] === "dsh-demo", "置頂的鏈排第一（即使排序鍵會把它排在後面）", rowNames.join(","));
	check(created.some((node) => node.props?.["data-card-pin"] === "dsh-demo"), "置頂的鏈有 📌 標記");

	// 側欄直接置頂（2026-10-19 使用者要求）：卡片列自己有一顆切換，按了就送 .pin
	const pinToggle = created.find((node) => node.props?.["data-card-chain-pin"] === "dsh-demo");
	check(pinToggle !== undefined, "卡片列有置頂切換（不必進面板）");
	const pinsBefore = fetchCalls.filter((call) => call.url.includes("session-chains.pin")).length;
	pinToggle?.props?.onClick?.({ stopPropagation: () => {} });
	await settle(Card);
	const sentPin = fetchCalls.filter((call) => call.url.includes("session-chains.pin")).pop();
	check(fetchCalls.filter((call) => call.url.includes("session-chains.pin")).length === pinsBefore + 1, "按一下送出 POST .pin");
	check(String(sentPin?.init?.body ?? "").includes('"chain":"dsh-demo"') && String(sentPin?.init?.body ?? "").includes('"on":false'), "已置頂的鏈再按＝取消置頂（on:false）", String(sentPin?.init?.body ?? ""));

	// 取消置頂／取消封存 → 回到原本的顯示與排序
	payloadForFetch = { ...DEMO_PAYLOAD, pinned: [], archived: [] };
	await settle(createCard({ numbering: quietNumbering, openSession: () => {}, workspaceService: () => fakeWorkspace, openPanel: () => {} }));
	const plain = created.filter((node) => node.props?.["data-chain-row"] !== undefined).map((node) => node.props["data-chain-row"]);
	check(plain.includes("dsh-demo-2") && plain[0] === "dsh-demo-2", "取消置頂與封存後恢復原狀", plain.join(","));
	check(created.filter((node) => node.props?.["data-card-pin"] !== undefined).length === 0, "沒有置頂就沒有 📌");

	writeSettings(DEFAULT_SETTINGS);
	payloadForFetch = DEMO_PAYLOAD;
}

// ── 2026-10-18：改名的正確介面是 sessions.using()（服務沒有 rename）──────────
{
	const renamer = sandbox.captured.exports.sessionRenamer;
	check(typeof renamer === "function", "匯出 sessionRenamer（改名介面轉接）");

	const calls = [];
	const using = {
		using: async (sessionId, options, run) => {
			calls.push({ sessionId, source: options.source });
			return run({ binding: { session: { rename: async (title) => calls.push({ title }) } } });
		},
	};
	const adapter = renamer(using);
	const ok = await adapter.rename("s1", "示範-001");
	check(ok.ok === true && calls[0]?.sessionId === "s1" && calls[0]?.source === "workspaceOperation", "走 sessions.using（內建同一條路徑）", JSON.stringify(calls));
	check(calls[1]?.title === "示範-001", "標題有傳進 reference.binding.session.rename");

	const failing = await renamer({
		using: async () => ({ ok: false, error: { message: "session/title-invalid" } }),
	}).rename("s1", "x");
	check(failing.ok === false && String(failing.error?.message).includes("title-invalid"), "失敗會把原因帶回來");

	check(renamer({ rename: async () => ({ ok: true }) }) !== null, "舊介面（直接有 rename）也支援");
	check(renamer(null) === null, "真的沒有服務 → null（靜默，不顯示訊息）");
	check(renamer({}) === null, "服務存在但兩個介面都沒有 → null");

	// 端到端：用 adapter 套用一筆
	renameCalls.length = 0;
	const posts = [];
	const applied = await applyPlan({
		plan: planOf([{ sessionId: "s2", from: "舊", to: "示範-001" }]),
		sessions: renamer({
			using: async (sessionId, options, run) => {
				renameCalls.push(sessionId);
				return run({ binding: { session: { rename: async () => {} } } });
			},
		}),
		post: async (payload) => posts.push(payload),
	});
	check(applied.status === "applied" && renameCalls[0] === "s2" && posts.length === 1, "接上 adapter 後真的會改名並回報");
}

// endpoint 規則
console.log(`endpoint（無 transport）=${sandbox.captured.exports.resolveEndpoint()}`);

console.log("");
// ── 2026-10-18：HUD 併入同一個外掛（原 dsh-token-hud），顯示哪幾段由設定勾選 ──
{
	const TokenHud = sandbox.captured.exports.TokenHud;
	const writeSettings = sandbox.captured.exports.writeSettings;
	const DEFAULT_SETTINGS = sandbox.captured.exports.DEFAULT_SETTINGS;
	check(typeof TokenHud === "function", "匯出 TokenHud（原本是另一個外掛）");

	payloadForFetch = {
		...DEMO_PAYLOAD,
		totals: { today: { total: 1000 }, week: { total: 2000 }, month: { total: 3000 } },
		balance: { status: "ready", wallets: [{ currency: "CNY", balance: 12.5 }] },
	};
	const projections = (name) => {
		if (name === "contextPressure") return { projectedTokens: 100000, contextWindow: 200000 };
		if (name === "sessionStats") return { steps: 50 };
		return undefined;
	};
	const renderHud = () => settle(() => TokenHud({ useProjection: projections }));

	// ① 預設全開：五段都在
	writeSettings(DEFAULT_SETTINGS);
	await renderHud();
	const hudText = textsOf().join(" | ");
	check(hudText.includes("餘額 ¥12.50"), "HUD 顯示餘額", hudText.slice(0, 80));
	check(hudText.includes("今日 1k") && hudText.includes("本週 2k") && hudText.includes("本月 3k"), "HUD 顯示日／週／月");
	const sessionElement = created.find((node) => node?.props?.alertSteps !== undefined && node?.props?.sessionColor !== undefined);
	check(sessionElement !== undefined, "HUD 有把「本場」子元件放進去（投影住在那裡）");
	check(sessionElement?.props?.sessionColor === DEFAULT_SETTINGS.sessionColor, "本場文字顏色從設定傳進去", String(sessionElement?.props?.sessionColor));
	const HudSession = sandbox.captured.exports.HudSession;
	await settle(() => HudSession({ useProjection: projections, accent: "#C62828", alertSteps: 120 }));
	check(textsOf().join(" | ").includes("本場 100k/50"), "本場顯示上下文／請求", textsOf().join(" | ").slice(0, 60));

	// ② 取消勾選「本週」→ 其他照舊、本週消失
	writeSettings({ showWeek: false });
	await renderHud();
	const withoutWeek = textsOf().join(" | ");
	check(!withoutWeek.includes("本週"), "取消勾選後本週不出現");
	check(withoutWeek.includes("今日") && withoutWeek.includes("本月"), "其他段不受影響");

	// ③ 取消「本場」→ 不再讀投影、也不顯示
	writeSettings({ showWeek: true, showSession: false });
	await renderHud();
	check(!textsOf().join(" | ").includes("本場"), "取消勾選後本場不出現");

	// ④ 全部關掉 → 整行不渲染
	writeSettings({ showBalance: false, showToday: false, showWeek: false, showMonth: false, showSession: false });
	await renderHud();
	check(created.find((node) => node.props?.["data-token-hud"] !== undefined) === undefined, "全部取消 → HUD 整行消失");

	// ⑤ 本場警示色吃設定
	writeSettings({ ...DEFAULT_SETTINGS, accent: "#1565C0" });
	await settle(() =>
		HudSession({
			useProjection: (name) =>
				name === "contextPressure" ? { projectedTokens: 200000, contextWindow: 400000 } : name === "sessionStats" ? { steps: 130 } : undefined,
			accent: "#1565C0",
			sessionColor: "#1565C0",
			hudBg: "#FFE58F",
			alertSteps: 120,
		}),
	);
	const alertSpan = created.find((node) => node.props?.["data-token-hud-alert"] !== undefined);
	check(String(alertSpan?.props?.style?.color ?? "").toUpperCase() === "#1565C0", "本場文字顏色跟著設定", String(alertSpan?.props?.style?.color));
	check(String(alertSpan?.props?.style?.background ?? "").toUpperCase() === "#FFE58F", "本場警示底色跟著設定", String(alertSpan?.props?.style?.background));

	writeSettings(DEFAULT_SETTINGS);
	payloadForFetch = DEMO_PAYLOAD;
}

// ── 2026-10-18 實測回饋三連修（字級擠掉按鈕／可折疊要能關／歸納只跳一次）──────
{
	const writeSettings = sandbox.captured.exports.writeSettings;
	const DEFAULT_SETTINGS = sandbox.captured.exports.DEFAULT_SETTINGS;
	const createCard = sandbox.captured.exports.createCard;
	const mountFold = sandbox.captured.exports.mountWorkspaceFold;
	const quietNumbering2 = {
		get: () => ({ paused: false, status: "idle", applied: 0, failed: 0, pending: 0, at: 0 }),
		subscribe: () => () => {},
		onApplied: () => () => {},
		run: () => {},
		togglePaused: () => false,
		confirm: () => {},
	};

	// ① 字級調到最大，收合列可以縮、右邊兩顆按鈕不被擠掉
	writeSettings({ font: 16 });
	const BigCard = createCard({ numbering: quietNumbering2, openSession: () => {}, workspaceService: () => fakeWorkspace, openPanel: () => {} });
	await settle(BigCard);
	const strip = created.find((node) => node.props?.["data-card-strip"] !== undefined);
	check(strip?.props?.style?.minWidth === 0, "字級大時，收合列自己可以縮（minWidth: 0）", String(strip?.props?.style?.minWidth));
	check(strip?.props?.style?.flex === "1 1 auto", "收合列是「可縮可長」的那一邊");
	const pauseButton = created.find((node) => node.props?.["data-pause-toggle"] !== undefined);
	const moreButton = created.find((node) => node.props?.["data-card-more"] !== undefined);
	check(pauseButton?.props?.style?.flex === "0 0 auto", "右側 ⏸ 固定寬（不被文字擠掉）");
	check(moreButton?.props?.style?.flex === "0 0 auto", "右側 ⋯ 固定寬（不被文字擠掉）");
	const cardRoot = created.find((node) => node.props?.["data-session-chains-card"] !== undefined);
	check(cardRoot?.props?.style?.["--sc-font"] === "16px", "卡片套用字級設定", String(cardRoot?.props?.style?.["--sc-font"]));

	// ② 設定可以關掉「工作區可折疊」：不插箭頭，畫面回到內建樣子
	writeSettings({ foldWorkspace: false });
	const off = (() => {
		const nodes = [];
		const makeEl = (tag) => {
			const el = {
				tag,
				attrs: {},
				children: [],
				style: {},
				setAttribute(name, value) { this.attrs[name] = String(value); },
				removeAttribute(name) { delete this.attrs[name]; },
				getAttribute(name) { return this.attrs[name] ?? null; },
				appendChild(node) { this.children.push(node); node.parent = this; node.parentElement = this; },
				insertBefore(node, ref) {
					const index = ref === null || ref === undefined ? this.children.length : this.children.indexOf(ref);
					this.children.splice(index < 0 ? this.children.length : index, 0, node);
					node.parent = this;
					node.parentElement = this;
				},
				contains(node) { return this.children.includes(node); },
				querySelector(selector) {
					if (!selector.includes("sectionHeader")) return null;
					const search = (node) => {
						for (const child of node.children) {
							if (String(child.className ?? "").includes("sectionHeader")) return child;
							const deeper = search(child);
							if (deeper !== null) return deeper;
						}
						return null;
					};
					return search(this);
				},
				querySelectorAll(selector) {
					if (!selector.includes("data-sc-ws-toggle")) return [];
					return nodes.filter((node) => node.parent === this && node.attrs?.["data-sc-ws-toggle"] !== undefined);
				},
				remove() { this.removed = true; if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this); },
			};
			Object.defineProperty(el, "firstElementChild", { get() { return this.children[0] ?? null; } });
			nodes.push(el);
			return el;
		};
		const region = makeEl("div");
		const browser = makeEl("div");
		const header = makeEl("div");
		header.className = "_x_sectionHeader";
		browser.appendChild(header);
		region.appendChild(browser);
		const head = makeEl("head");
		const doc = {
			createElement: (tag) => makeEl(tag),
			createElementNS: (_ns, tag) => makeEl(tag),
			querySelector: (selector) => (selector.includes("regionArea") ? region : null),
			querySelectorAll: () => [],
			getElementById: () => null,
			head,
			documentElement: { appendChild() {}, hasAttribute: () => false },
			body: { hasAttribute: () => false },
		};
		return { doc, header };
	})();
	const offDispose = mountFold({ document: off.doc, reconcileMs: 5 });
	check(
		!off.header.children.some((child) => child.attrs?.["data-sc-ws-toggle"] !== undefined),
		"設定關掉「工作區可折疊」→ 完全不插箭頭",
	);
	offDispose();
	writeSettings(DEFAULT_SETTINGS);

	// ③ 建議整理：一組一組記住，併了 A 之後 B 還在
	store.delete("dsh.session-chains.suggest-dismissed");
	payloadForFetch = {
		...DEMO_PAYLOAD,
		suggestions: [
			{ label: "交接", size: 2, sessionIds: ["s-loose", "s-head"], sample: "交接鏈的卡片" },
			{ label: "公文", size: 2, sessionIds: ["s-loose", "s-head"], sample: "寫一份公文" },
		],
	};
	const fresh = () => panel.component({});
	await settle(fresh);
	created.find((node) => node.children?.[0] === "重抓")?.props?.onClick?.();
	await new Promise((resolve) => setTimeout(resolve, 30));
	await settle(fresh);
	check(created.some((node) => node.props?.["data-sc-suggest-group"] === "交接"), "兩組建議都出現（第一組）");
	check(created.some((node) => node.props?.["data-sc-suggest-group"] === "公文"), "兩組建議都出現（第二組）");
	created.find((node) => node.props?.["data-sc-suggest-skip"] === "交接")?.props?.onClick?.();
	await settle(fresh);
	check(created.some((node) => node.props?.["data-sc-suggest-group"] === "公文"), "略過第一組之後，第二組還在（不是全部關掉）");
	check(!created.some((node) => node.props?.["data-sc-suggest-group"] === "交接"), "略過的那一組消失");
	payloadForFetch = DEMO_PAYLOAD;
	store.delete("dsh.session-chains.suggest-dismissed");
}

// ── 2026-10-18 使用者回報：取消「工作區可折疊」後整個工作區消失 ─────────────
// 成因：舊版只清「記住的」host／body 兩個節點，屬性若黏在別的節點上（React 換過、或上一輪留下）
// 就清不掉 → `[data-sc-ws-body="1"] > *:not(.sectionHeader)` 一直把清單藏著，而且箭頭已經被移除，
// 使用者就再也打不開。現在改成掃 DOM 清標記，並把收合偏好重設成展開。
{
	const mountFold = sandbox.captured.exports.mountWorkspaceFold;
	const readWorkspaceFold = sandbox.captured.exports.readWorkspaceFold;
	const writeSettings = sandbox.captured.exports.writeSettings;
	const readSettings = sandbox.captured.exports.readSettings;
	const DEFAULT_SETTINGS = sandbox.captured.exports.DEFAULT_SETTINGS;

	/** 最小假 DOM：側欄區塊 → 清單 → 標題列（工作區／查詢）。 */
	const fixture = () => {
		const nodes = [];
		const makeEl = (tag) => {
			const el = {
				tag,
				attrs: {},
				children: [],
				style: {},
				setAttribute(name, value) { this.attrs[name] = String(value); },
				removeAttribute(name) { delete this.attrs[name]; },
				getAttribute(name) { return this.attrs[name] ?? null; },
				appendChild(node) { this.children.push(node); node.parent = this; node.parentElement = this; },
				insertBefore(node, ref) {
					const index = ref === null || ref === undefined ? this.children.length : this.children.indexOf(ref);
					this.children.splice(index < 0 ? this.children.length : index, 0, node);
					node.parent = this;
					node.parentElement = this;
				},
				contains(node) { return this.children.includes(node); },
				querySelector(selector) {
					if (!selector.includes("sectionHeader")) return null;
					const search = (node) => {
						for (const child of node.children) {
							if (String(child.className ?? "").includes("sectionHeader")) return child;
							const deeper = search(child);
							if (deeper !== null) return deeper;
						}
						return null;
					};
					return search(this);
				},
				querySelectorAll(selector) {
					if (selector.includes("data-sc-ws-toggle")) {
						return nodes.filter((node) => node.parent === this && node.attrs?.["data-sc-ws-toggle"] !== undefined);
					}
					return [];
				},
				remove() { this.removed = true; if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this); },
			};
			Object.defineProperty(el, "firstElementChild", { get() { return this.children[0] ?? null; } });
			nodes.push(el);
			return el;
		};
		const region = makeEl("div");
		const browser = makeEl("div");
		const header = makeEl("div");
		header.className = "_x_sectionHeader";
		browser.appendChild(header);
		region.appendChild(browser);
		const head = makeEl("head");
		const doc = {
			createElement: (tag) => makeEl(tag),
			createElementNS: (_ns, tag) => makeEl(tag),
			querySelector: (selector) => (selector.includes("regionArea") ? region : null),
			// 掃標記的查詢：回傳所有帶 `data-sc-ws-*` 的節點（**包含**不是元件記住的那一個）
			querySelectorAll: (selector) => {
				if (selector.includes("data-sc-ws-toggle")) return nodes.filter((node) => node.attrs?.["data-sc-ws-toggle"] !== undefined);
				if (selector.includes("data-sc-ws-body") || selector.includes("data-sc-ws-fold")) {
					return nodes.filter((node) => node.attrs?.["data-sc-ws-body"] !== undefined || node.attrs?.["data-sc-ws-fold"] !== undefined);
				}
				return [];
			},
			getElementById: () => null,
			head,
			documentElement: { appendChild() {}, hasAttribute: () => false },
			body: { hasAttribute: () => false },
		};
		return { doc, region, browser, header, nodes };
	};

	// ① 先收合（模擬使用者原本就是折疊狀態）
	store.delete("dsh.session-chains.workspace-fold");
	const { doc, region, browser, header } = fixture();
	const dispose = mountFold({ document: doc, reconcileMs: 5 });
	const toggle = header.children[0];
	toggle.onclick({ stopPropagation: () => {} });
	check(region.getAttribute("data-sc-ws-fold") === "1" && browser.getAttribute("data-sc-ws-body") === "1", "（前置）工作區已收合、標記命中");

	// ② 製造「黏在別的節點上」的舊標記：這正是舊版清不到的那一種
	const stray = fixture().region;
	stray.setAttribute("data-sc-ws-body", "1");
	doc.querySelectorAll.__stray = stray;

	// ③ 取消勾選「工作區可折疊」→ 校正一輪之後：標記全清、箭頭移除、狀態重設為展開
	writeSettings({ foldWorkspace: false });
	await new Promise((resolve) => setTimeout(resolve, 260));
	check(region.getAttribute("data-sc-ws-fold") === null, "取消可折疊後，regionArea 的折疊標記被清掉（工作區回來）");
	check(browser.getAttribute("data-sc-ws-body") === null, "取消可折疊後，清單的隱藏標記被清掉");
	check(toggle.removed === true, "取消可折疊後，箭頭被移除（回到內建樣子）");
	check(readWorkspaceFold() === false, "取消可折疊時，收合偏好一併重設為展開（再打開不會立刻又收起來）");

	// ④ 再勾回來 → 箭頭回來，而且是展開狀態
	writeSettings({ foldWorkspace: true });
	await new Promise((resolve) => setTimeout(resolve, 260));
	// 注意：假 DOM 的 removed 旗標在重新插入後不會自己歸零，所以只看「有沒有回到那一列」。
	const backToggle = header.children.find((child) => child.attrs?.["data-sc-ws-toggle"] !== undefined);
	check(backToggle !== undefined && header.contains(backToggle), "勾回來之後箭頭重新出現");
	check(region.getAttribute("data-sc-ws-fold") === null, "勾回來時是展開的（不會一打開就又消失）");

	dispose();
	writeSettings(DEFAULT_SETTINGS);
	store.delete("dsh.session-chains.workspace-fold");
	check(readSettings().foldWorkspace === true, "（收尾）設定回到預設");
}

// ── 2026-10-18：面板搜尋／多選歸鏈／拖拉歸鏈 ─────────────────────────────
{
	/** 確保面板是開著的（前面的檢查可能把它關掉了）。 */
	const ensurePanel = async () => {
		await settle(panel.component);
		if (created.some((node) => node.props?.["data-session-chains-panel"] !== undefined)) return;
		const footerTree = await settle(footer.component);
		footerTree?.props?.onClick?.();
		await settle(panel.component);
	};
	await ensurePanel();

	// ① 搜尋：打 session id／標題 → 只剩命中的場次
	const search = created.find((node) => node.props?.["data-sc-search"] !== undefined);
	check(search !== undefined, "面板有搜尋框（data-sc-search）");
	search.props.onChange({ target: { value: "s-next" } });
	await settle(panel.component);
	const searchedRows = created.filter((node) => node.props?.["data-session-row"] !== undefined).map((node) => node.props["data-session-row"]);
	check(searchedRows.length === 1 && searchedRows[0] === "s-next", "搜尋命中一場就只留那一場", searchedRows.join(","));
	created.find((node) => node.props?.["data-sc-search-clear"] !== undefined)?.props?.onClick?.();
	await settle(panel.component);
	check(
		created.filter((node) => node.props?.["data-session-row"] !== undefined).length > 1,
		"按 ✕ 清掉搜尋 → 場次回來",
	);

	// ② 多選：勾兩場 → 一次歸到 dsh-demo-2（逐場走既有 assign 端點）
	const boxes = created.filter((node) => node.props?.["data-sc-select"] !== undefined);
	check(boxes.length >= 2, "每一場都有勾選框", `找到 ${boxes.length}`);
	// 中繼場會在兩條鏈各列一次，所以要用「兩個不同的 id」來選，不然會勾了又取消。
	const uniqueIds = [...new Set(boxes.map((node) => node.props["data-sc-select"]))];
	const idA = uniqueIds[0];
	const idB = uniqueIds[1];
	created.find((node) => node.props?.["data-sc-select"] === idA)?.props?.onChange?.();
	await settle(panel.component);
	created.find((node) => node.props?.["data-sc-select"] === idB)?.props?.onChange?.();
	await settle(panel.component);
	check(created.some((node) => node.props?.["data-sc-bulk"] !== undefined), "選了兩場 → 出現批次列");
	check(
		created.find((node) => node.props?.["data-sc-bulk-count"] !== undefined)?.props?.children?.includes?.("2") === true ||
			String(created.find((node) => node.props?.["data-sc-bulk-count"] !== undefined)?.children?.[0] ?? "").includes("2"),
		"批次列說出已選 2 場",
		String(created.find((node) => node.props?.["data-sc-bulk-count"] !== undefined)?.children?.[0] ?? ""),
	);
	created.find((node) => node.props?.["data-sc-bulk-chain"] !== undefined)?.props?.onChange?.({ target: { value: "dsh-demo-2" } });
	await settle(panel.component);
	const beforeBulk = fetchCalls.length;
	created.find((node) => node.props?.["data-sc-bulk-apply"] !== undefined)?.props?.onClick?.();
	await settle(panel.component);
	const bulkCalls = fetchCalls.slice(beforeBulk).filter((call) => call.url.includes("assign"));
	check(bulkCalls.length === 2, "批次歸鏈逐場打兩次 assign 端點", `實際 ${bulkCalls.length}`);
	check(
		bulkCalls.every((call) => JSON.parse(call.init.body).chain === "dsh-demo-2") &&
			new Set(bulkCalls.map((call) => JSON.parse(call.init.body).sessionId)).size === 2,
		"兩場都帶著目標鏈名（dsh-demo-2）",
	);
	check(created.every((node) => node.props?.["data-sc-bulk"] === undefined), "歸鏈後批次列收起（選取清空）");

	// ③ 拖拉：拖一列到鏈標頭 → 歸到那條鏈
	await settle(panel.component);
	const dragRow = created.find((node) => node.props?.["data-session-row"] !== undefined);
	const draggedId = dragRow?.props?.["data-session-row"];
	const transfer = { value: "", setData: (_type, value) => { transfer.value = value; }, getData: () => transfer.value };
	dragRow?.props?.onDragStart?.({ dataTransfer: transfer });
	check(String(transfer.value).includes(draggedId), "拖場次列會把 session id 放進 dataTransfer", transfer.value);
	const target = created.find((node) => node.props?.["data-chain-drop"] === "dsh-demo");
	check(target?.props?.onDrop !== undefined, "鏈標頭接受拖放（data-chain-drop）");
	const beforeDrag = fetchCalls.length;
	target?.props?.onDrop?.({ preventDefault: () => {}, stopPropagation: () => {}, dataTransfer: transfer });
	await settle(panel.component);
	const dragCalls = fetchCalls.slice(beforeDrag).filter((call) => call.url.includes("assign"));
	check(
		dragCalls.length === 1 && JSON.parse(dragCalls[0].init.body).chain === "dsh-demo" && JSON.parse(dragCalls[0].init.body).sessionId === draggedId,
		"拖到 dsh-demo 標頭 → 這一場歸到 dsh-demo",
		JSON.stringify(dragCalls.map((call) => JSON.parse(call.init.body))),
	);
}

// ── 2026-10-18：進行狀態圓點（橙＝等你處理／藍＝工作中／綠＝完成／紅＝失敗）──────
{
	const statusOf = sandbox.captured.exports.statusOf;
	const aggregateStatus = sandbox.captured.exports.aggregateStatus;
	check(typeof statusOf === "function" && typeof aggregateStatus === "function", "匯出 statusOf／aggregateStatus");

	const sample = new Map([
		["a", { running: true, completionUnread: false }],
		["b", { running: false, completionUnread: true }],
		["c", { running: false, pendingInteraction: { kind: "approval" }, completionUnread: false }],
		["d", { running: false, completionUnread: false }],
	]);
	check(statusOf(sample, "c")?.level === "warning", "等你同意 → warning（橙）", JSON.stringify(statusOf(sample, "c")));
	check(statusOf(sample, "a")?.level === "ongoing", "跑動中 → ongoing（藍）");
	check(statusOf(sample, "b")?.level === "done", "完成未查看 → done（綠）");
	check(statusOf(sample, "d") === null, "閒置不畫點（回 null）");
	check(aggregateStatus(sample, ["a", "b"]).level === "ongoing", "彙總：工作中優先於完成");
	check(aggregateStatus(sample, ["a", "c", "b"]).level === "warning", "彙總：等你處理最優先（橙壓過藍綠）");
	check(aggregateStatus(sample, ["d"]) === null, "彙總：全部閒置 → 不畫點");

	// 面板：s-head 工作中、s-next 等待同意 → 標題與那一列都是橙點
	setSessionStatuses([
		["s-head", { running: true, completionUnread: false }],
		["s-next", { running: false, pendingInteraction: { kind: "approval" }, completionUnread: false }],
	]);
	await settle(panel.component);
	// 2026-10-18 使用者回報「一個任務三個燈」：最上層標題不再畫點。
	const panelHeader = created.find((node) => (node.children ?? []).some((child) => child?.props?.["data-current-hint"] !== undefined));
	const headerDot = (panelHeader?.children ?? []).find?.((child) => child?.props?.["data-status-dot"] !== undefined);
	check(headerDot === undefined, "面板標題列不畫點（鏈標頭與場次列才是那兩個燈）", String(headerDot?.props?.["data-status-dot"]));
	check(panelHeader?.props?.style?.position === "sticky", "面板標題列 sticky（往下捲也看得到控制項）");
	const rowNext = created.find((node) => node.props?.["data-session-row"] === "s-next");
	const rowDot = rowNext?.children?.find?.((child) => child?.props?.["data-status-dot"] !== undefined);
	check(rowDot?.props?.["data-status-dot"] === "warning", "s-next 那一列左側是橙點", String(rowDot?.props?.["data-status-dot"]));
	check(rowDot?.props?.title === "等待同意", "橙點的 tooltip 說「等待同意」", String(rowDot?.props?.title));

	// 卡片（收合列也要有）：整張卡彙總＝橙（s-next 等你同意）
	const CardWithStatus = createCard({
		numbering: quietNumbering,
		openSession: () => {},
		workspaceService: () => fakeWorkspace,
		openPanel: () => {},
		statusSource: () => fakeUiSession.sessionStatus,
	});
	await settle(CardWithStatus);
	const strip = created.find((node) => node.props?.["data-card-strip"] !== undefined);
	const stripDot = strip?.children?.find?.((child) => child?.props?.["data-status-dot"] !== undefined);
	check(stripDot === undefined, "卡片展開時標題不畫點（鏈列＋場次列已經兩個燈）", String(stripDot?.props?.["data-status-dot"]));

	// 卡片收合時（鏈列看不到）才在標題畫彙總點
	store.set("dsh.session-chains.card", JSON.stringify({ open: false, chains: [] }));
	const CollapsedCard = createCard({
		numbering: quietNumbering,
		openSession: () => {},
		workspaceService: () => fakeWorkspace,
		openPanel: () => {},
		statusSource: () => fakeUiSession.sessionStatus,
	});
	await settle(CollapsedCard);
	const collapsedStrip = created.find((node) => node.props?.["data-card-strip"] !== undefined);
	const collapsedDot = collapsedStrip?.children?.find?.((child) => child?.props?.["data-status-dot"] !== undefined);
	check(collapsedDot?.props?.["data-status-dot"] === "warning", "卡片收合時標題有彙總橙點（仍看得到哪裡在動）", String(collapsedDot?.props?.["data-status-dot"]));
	store.set("dsh.session-chains.card", JSON.stringify({ open: true, chains: ["dsh-demo"] }));

	// 狀態改變（s-head 收工、s-next 完成）→ 面板那一列與卡片標題都變綠
	// 註：只把 s-next 改成完成、s-head 還在跑時，卡片標題仍是藍（工作中優先於完成）——那是刻意的優先序。
	setSessionStatuses([
		["s-head", { running: false, completionUnread: false }],
		["s-next", { running: false, completionUnread: true }],
	]);
	await settle(panel.component);
	const rowNext2 = created.find((node) => node.props?.["data-session-row"] === "s-next");
	const rowDot2 = rowNext2?.children?.find?.((child) => child?.props?.["data-status-dot"] !== undefined);
	check(rowDot2?.props?.["data-status-dot"] === "done", "同意後那一列變綠（面板）", String(rowDot2?.props?.["data-status-dot"]));
	await settle(CardWithStatus);
	// 卡片展開時：綠點在「鏈列」與「場次列」，標題不重複畫。
	const cardChainRow = created.find((node) => node.props?.["data-chain-row"] === "dsh-demo");
	const chainDot = (cardChainRow?.children ?? []).find?.((child) => child?.props?.["data-status-dot"] !== undefined);
	check(chainDot?.props?.["data-status-dot"] === "done", "同意後鏈列變綠（卡片）", String(chainDot?.props?.["data-status-dot"]));
	// 這一張卡片初始是「展開但沒有打開任何鏈」→ 先點開 dsh-demo 才有場次列。
	created.find((node) => node.props?.["data-chain-row"] === "dsh-demo")?.props?.onClick?.();
	await settle(CardWithStatus);
	const cardRowNext = created.find((node) => node.props?.["data-card-session"] === "s-next");
	const cardRowDot = (cardRowNext?.children ?? []).find?.((child) => child?.props?.["data-status-dot"] !== undefined);
	check(cardRowDot?.props?.["data-status-dot"] === "done", "同意後場次列變綠（卡片，第二個燈）", String(cardRowDot?.props?.["data-status-dot"]));

	// 收尾：清掉狀態，免得以後的面板測試互相影響
	statusState.clear();
	setSessionStatuses([]);
}

// ── 2026-10-18：鏈的排序（名稱／建立時間／場次數，可正可反）──────────────
{
	const sortChains = sandbox.captured.exports.sortChains;
	const readSettings = sandbox.captured.exports.readSettings;
	const writeSettings = sandbox.captured.exports.writeSettings;
	check(typeof sortChains === "function", "匯出 sortChains");

	const sample = [
		{ chain: "beta", count: 2, firstAt: 300, lastAt: 400 },
		{ chain: "alpha", count: 5, firstAt: 200, lastAt: 200 },
		{ chain: "gamma", count: 1, firstAt: 100, lastAt: 300 },
	];
	const names = (list) => list.map((entry) => entry.chain).join(",");
	check(names(sortChains(sample, "chain", "asc")) === "alpha,beta,gamma", "名稱正排");
	check(names(sortChains(sample, "chain", "desc")) === "gamma,beta,alpha", "名稱倒排");
	check(names(sortChains(sample, "created", "asc")) === "gamma,alpha,beta", "建立時間正排（舊→新）");
	check(names(sortChains(sample, "created", "desc")) === "beta,alpha,gamma", "建立時間倒排（新→舊）");
	check(names(sortChains(sample, "count", "asc")) === "gamma,beta,alpha", "場次數正排（少→多）");
	check(names(sortChains(sample, "count", "desc")) === "alpha,beta,gamma", "場次數倒排（多→少）");
	check(names(sortChains(sample, "lastAt", "asc")) === "alpha,gamma,beta", "最後對話時間正排（舊→新）");
	check(names(sortChains(sample, "lastAt", "desc")) === "beta,gamma,alpha", "最後對話時間倒排（新→舊，最近在用的在前）");
	check(sample.map((entry) => entry.chain).join(",") === "beta,alpha,gamma", "排序不改原陣列");
	// 2026-10-19 置頂：置頂是「位置」不是「排序」——任何排序鍵、任何方向都排最前。
	check(names(sortChains(sample, "chain", "asc", ["gamma"])) === "gamma,alpha,beta", "置頂排最前（名稱正排）");
	check(names(sortChains(sample, "created", "desc", ["alpha"])) === "alpha,beta,gamma", "置頂排最前（建立時間倒排，不影響其他條的相對順序）");
	check(names(sortChains(sample, "count", "asc", ["beta", "gamma"])) === "gamma,beta,alpha", "多條置頂時，彼此照選定的排序鍵（場次數少→多：gamma 1、beta 2）");
	check(names(sortChains(sample, "chain", "asc", [])) === "alpha,beta,gamma", "沒有置頂＝原本的排序");

	// 設定：預設與壞值
	store.delete("dsh.session-chains.settings");
	check(readSettings().sortBy === "created" && readSettings().sortDir === "asc", "排序預設：建立時間、正排");
	writeSettings({ sortBy: "亂寫", sortDir: "亂寫" });
	check(readSettings().sortBy === "created" && readSettings().sortDir === "asc", "排序壞值回預設");
	writeSettings({ sortBy: "count", sortDir: "desc" });

	// 2026-10-18 使用者指示：排序控制移到卡片標題列（三顆圖示的左邊），面板不再放。
	await settle(Card);
	const panelOrder = () =>
		created
			.filter((node) => node.props?.["data-chain-drop"] !== undefined && node.props["data-chain-drop"] !== "unmarked")
			.map((node) => node.props["data-chain-drop"]);
	const cardOrder = () =>
		created.filter((node) => node.props?.["data-chain-row"] !== undefined).map((node) => node.props["data-chain-row"]);
	check(created.find((node) => node.props?.["data-sc-sort-key"] !== undefined) === undefined, "面板不再放排序控制（已移到卡片標題）");
	const stripSelect = created.find((node) => node.props?.["data-card-sort-key"] !== undefined);
	check(stripSelect !== undefined, "卡片標題列有排序選單（data-card-sort-key）");
	check(
		(stripSelect?.children ?? []).some((option) => option?.props?.value === "lastAt"),
		"排序選單有「最後」（最後一次對話時間）",
	);
	const stripButtons = (created.find((node) => node.props?.["data-card-strip"] !== undefined)?.props ? created : []).length; // 佔位，不影響檢查
	// 目前是「場次數倒排」（上面 writeSettings 設的）；只換鍵、不動方向 → 名稱倒排
	stripSelect.props.onChange({ target: { value: "chain" } });
	await settle(Card);
	check(cardOrder().join(",") === "dsh-demo-2,dsh-demo", "換成名稱、方向不變（卡片倒排）", cardOrder().join(","));
	await settle(panel.component);
	check(panelOrder().join(",") === "dsh-demo-2,dsh-demo", "面板跟著卡片的排序（名稱倒排）", panelOrder().join(","));
	await settle(Card);
	created.find((node) => node.props?.["data-card-sort-dir"] !== undefined)?.props?.onClick?.();
	await settle(Card);
	check(cardOrder().join(",") === "dsh-demo,dsh-demo-2", "按方向鈕 → 名稱正排（卡片）", cardOrder().join(","));
	await settle(panel.component);
	check(panelOrder().join(",") === "dsh-demo,dsh-demo-2", "面板同步正排", panelOrder().join(","));
	check(readSettings().sortBy === "chain" && readSettings().sortDir === "asc", "從卡片改排序會寫進設定");

	// 方向還是正排；只換成場次數 → 1 場的 dsh-demo-2 在前
	await settle(Card);
	created.find((node) => node.props?.["data-card-sort-key"] !== undefined)?.props?.onChange?.({ target: { value: "count" } });
	await settle(Card);
	check(cardOrder().join(",") === "dsh-demo-2,dsh-demo", "卡片改成場次數正排：1 場的在前", cardOrder().join(","));
	created.find((node) => node.props?.["data-card-sort-dir"] !== undefined)?.props?.onClick?.();
	await settle(Card);
	check(cardOrder().join(",") === "dsh-demo,dsh-demo-2", "卡片方向鈕 → 場次數倒排", cardOrder().join(","));

	// 收尾：回預設，免得影響後面的檢查
	writeSettings({ sortBy: "created", sortDir: "asc" });
	store.delete("dsh.session-chains.settings");
}

// ── 2026-10-18：卡片標題的摘要可關、右側三顆圖示可放大 ──────────────────
{
	const readSettings = sandbox.captured.exports.readSettings;
	const writeSettings = sandbox.captured.exports.writeSettings;
	store.delete("dsh.session-chains.settings");
	check(readSettings().showCardSummary === false && readSettings().stripIconSize === 15, "卡片摘要預設關閉、圖示預設 15px");
	check(writeSettings({ stripIconSize: 99 }).stripIconSize === 24, "圖示大小上限 24px");
	check(writeSettings({ stripIconSize: 1 }).stripIconSize === 10, "圖示大小下限 10px");

	writeSettings({ showCardSummary: false, stripIconSize: 20 });
	await settle(Card);
	const strip = created.find((node) => node.props?.["data-card-strip"] !== undefined);
	const label = (strip?.children ?? []).find((child) => typeof child?.children?.[0] === "string" && String(child.children[0]).startsWith("交接鏈"));
	check(label?.children?.[0] === "交接鏈", "關掉摘要 → 標題只剩「交接鏈」（沒有幾條鏈幾場）", String(label?.children?.[0]));
	const foldButton = created.find((node) => node.props?.["data-card-fold"] !== undefined);
	check(foldButton?.props?.style?.fontSize === 20, "右側第一顆（收合箭頭）跟著放大", String(foldButton?.props?.style?.fontSize));
	const pauseButton = created.find((node) => node.props?.["data-pause-toggle"] !== undefined && node.props?.["data-pause-toggle"] !== "paused");
	const moreButton = created.find((node) => node.props?.["data-card-more"] !== undefined);
	check(pauseButton?.props?.style?.fontSize === 20, "右側第二顆（暫停）跟著放大", String(pauseButton?.props?.style?.fontSize));
	check(moreButton?.props?.style?.fontSize === 20, "右側第三顆（⋯）跟著放大", String(moreButton?.props?.style?.fontSize));

	// ⚙ 裡看得到這兩個設定
	await settle(panel.component);
	const gear2 = created.find((node) => node.props?.["data-sc-settings-toggle"] !== undefined);
	if (!created.some((node) => node.props?.["data-sc-settings"] !== undefined)) {
		gear2?.props?.onClick?.();
		await settle(panel.component);
	}
	const iconSelect = created.find((node) => node.props?.["data-sc-setting"] === "stripIconSize");
	check(iconSelect !== undefined && String(iconSelect.props.value) === "20", "⚙ 有「卡片圖示」大小可選（目前 20px）", String(iconSelect?.props?.value));
	check(
		created.some((node) => node.props?.["data-sc-setting"] === "showCardSummary" && node.props?.type === "checkbox"),
		"⚙ 有「卡片標題顯示 N 條鏈・M 場」勾選項",
	);
	// 從 ⚙ 改一次，確認真的生效（跟使用者操作同一條路）
	iconSelect.props.onChange({ target: { value: "24" } });
	await settle(panel.component);
	check(readSettings().stripIconSize === 24, "從 ⚙ 改圖示大小會寫進設定");

	writeSettings({ showCardSummary: true, stripIconSize: 15 });
	store.delete("dsh.session-chains.settings");
}

// ── 2026-10-18：交接→新對話（讀 AI 寫好的提示詞，開對話並送出）──────────────
{
	const ensurePanel3 = async () => {
		await settle(panel.component);
		if (created.some((node) => node.props?.["data-session-chains-panel"] !== undefined)) return;
		const footerTree = await settle(footer.component);
		footerTree?.props?.onClick?.();
		await settle(panel.component);
	};
	await ensurePanel3();
	const button = created.find((node) => node.props?.["data-sc-new-handoff"] !== undefined);
	check(button !== undefined, "面板有『交接→新對話』按鈕");
	check(String(button?.children?.[0] ?? "").includes("交接"), "按鈕文字說得出是交接", String(button?.children?.[0] ?? ""));

	createCalls.length = 0;
	promptCalls.length = 0;
	const opensBefore = openCalls.length;
	nextPromptForFetch = "先讀交接單\n鏈=dsh-demo";
	await button?.props?.onClick?.();
	await settle(panel.component);
	check(createCalls.length === 1 && createCalls[0].cwd === "/work/my-project", "在同一個工作區（cwd）開了一個新對話", JSON.stringify(createCalls));
	check(
		promptCalls.length === 1 && promptCalls[0].sessionId === "s-new" && String(promptCalls[0].content?.[0]?.text ?? "").includes("先讀交接單"),
		"把交接詞當第一個訊息送進新對話（queue）",
		JSON.stringify(promptCalls),
	);
	check(openCalls.length > opensBefore && openCalls.includes("s-new"), "送出後切到新對話");
	const clearCall = fetchCalls.find((call) => call.url.includes("next-prompt") && String(call.init?.method ?? "").toUpperCase() === "POST");
	check(clearCall !== undefined && JSON.parse(clearCall.init.body).clear === true, "用過就把提示詞檔清掉（不會重複貼舊的）");

	// 沒有提示詞：要說清楚，不要開一個空白對話
	// （成功的交接會關掉面板、切到新對話，所以這裡先重新打開面板再按。）
	createCalls.length = 0;
	promptCalls.length = 0;
	nextPromptForFetch = "";
	await ensurePanel3();
	const button2 = created.find((node) => node.props?.["data-sc-new-handoff"] !== undefined);
	await button2?.props?.onClick?.();
	// 面板剛打開時「抓取中…」至少 400ms，會蓋住錯誤訊息 → 等它過去再看。
	await new Promise((resolve) => setTimeout(resolve, 450));
	await settle(panel.component);
	check(createCalls.length === 0 && promptCalls.length === 0, "沒有交接詞就不會開新對話");
	check(
		created.some((node) => String(node.children?.[0] ?? "").includes("還沒有交接詞")),
		"沒有交接詞時顯示原因（不是靜默失敗）",
	);
	nextPromptForFetch = "先讀交接單\n鏈=dsh-demo";
}

if (failed === 0) {
	console.log("結論：插槽註冊、開關面板、資料列（含鏈的起點）都通過。剩下的只有「真實畫面好不好看」要人眼。");
} else {
	console.log(`結論：有 ${failed} 項未通過。`);
	process.exit(1);
}
