/**
 * session-chains — 瀏覽器半（spike）
 *
 * 兩個註冊點（都取自 DSH 官方的插槽目錄，`replaceRisk: none`）：
 *   1. `sidebar.footer.action`（左側欄底部，齒輪旁）→ 一顆「交接鏈」按鈕。
 *   2. `shell.overlay`（全框浮層，可點穿）→ 面板本體，按鈕切換開關。
 *
 * 資料來自宿主唯讀路由 `GET /local/session-chains`（見 `index.mjs`）。
 * 點一列 → `ctx.uiWorkspace.openSession(id)`（內建插件切換對話用的同一個 API）。
 * **目前這一場**：讀 `uiWorkspace.selection`（內建「目前選取的對話」store）→ 那一列給亮色底色。
 * 沒有這個提示的話，使用者得在面板與左側欄之間來回核對「我現在在哪一場」。
 *
 * 硬約束（照 `dsh-token-hud` 的實測）：
 *   - 只能 `require("react")`，不可 import 任何 Harness Client 套件。
 *   - 取資料的 URL 不可寫死開頭斜線（頁面 origin 是 `dsh-app://app`）。
 *   - 浮層 root 要自己開 `pointerEvents: "auto"`，否則整個圖層是點穿的。
 */
window.__ModuleLoader__.load({
	id: "session-chains",
	factory: (require) => {
		const React = require("react");
		const h = React.createElement;
		// 卡片是 DOM 掛載（像 dsh-usage 那樣）。拿不到 react-dom/client 就**只少了卡片**，
		// 原本的「交接鏈」按鈕與浮層照常運作。
		let createRoot = null;
		try {
			const reactDomClient = require("react-dom/client");
			createRoot = typeof reactDomClient?.createRoot === "function" ? reactDomClient.createRoot : null;
		} catch {
			createRoot = null;
		}

		/** 面板開著時多久重抓一次（毫秒）。 */
		const POLL_MS = 15000;

		/** 追蹤「目前這一場」的輪詢間隔（毫秒）——輕量，只是讀一個 getter。 */
		const CURRENT_POLL_MS = 1000;

		/**
		 * 「你在這裡」那一列的文字色（底色與色條現在吃設定 `highlight`，見 `DEFAULT_SETTINGS`）。
		 * 文字刻意固定深藍：使用者可能挑淺色底，深字在任何淺底上都還讀得出來。
		 */
		const CURRENT_TEXT = "#0B4C8C";

		/**
		 * 組出對宿主取資料的 URL。**不可改成寫死開頭斜線的字串**（會解析成 dsh-app://local/…）。
		 * @returns 絕對 URL
		 */
		function resolveEndpoint() {
			const base = globalThis.__DSH_TRANSPORT__?.streamBaseUrl ?? document.baseURI;
			return new URL("local/session-chains", base).href;
		}

		/** 改名端點（面板上唯一會寫檔的動作：把「舊代號 → 新名稱」登錄進對照表）。 */
		function resolveRenameEndpoint() {
			const base = globalThis.__DSH_TRANSPORT__?.streamBaseUrl ?? document.baseURI;
			return new URL("local/session-chains.rename", base).href;
		}

		/** 歸鏈端點（把某**一場**對話手動指定到一條鏈；給沒用過交接指令的舊對話）。 */
		function resolveAssignEndpoint() {
			const base = globalThis.__DSH_TRANSPORT__?.streamBaseUrl ?? document.baseURI;
			return new URL("local/session-chains.assign", base).href;
		}

		/** 接續提示詞端點（AI 寫好的交接詞；「交接→新對話」讀它）。 */
		function resolveNextPromptEndpoint() {
			const base = globalThis.__DSH_TRANSPORT__?.streamBaseUrl ?? document.baseURI;
			return new URL("local/session-chains.next-prompt", base).href;
		}

		/** 標題回報端點（套用編號後回報，宿主記原標題備份／還原清單）。 */
		function resolveTitlesEndpoint() {
			const base = globalThis.__DSH_TRANSPORT__?.streamBaseUrl ?? document.baseURI;
			return new URL("local/session-chains.titles", base).href;
		}

		/**
		 * 送出改名（`POST /local/session-chains.rename`）。面板與**側邊欄卡片**共用這一支 ——
		 * 卡片上就地改名時，走的必須是跟面板完全同一條路（否則會出現「卡片改得動、面板改不動」這種分叉）。
		 * @param from - 目前的鏈名
		 * @param to - 新名稱（伺服器會再驗一次）
		 * @returns 宿主回的新 payload（或 null）
		 */
		/** 置頂端點（`{chain, on}`）。 */
		function resolvePinEndpoint() {
			const base = globalThis.__DSH_TRANSPORT__?.streamBaseUrl ?? document.baseURI;
			return new URL("local/session-chains.pin", base).href;
		}

		/** 封存端點（`{chain, on}`）。 */
		function resolveArchiveEndpoint() {
			const base = globalThis.__DSH_TRANSPORT__?.streamBaseUrl ?? document.baseURI;
			return new URL("local/session-chains.archive", base).href;
		}

		/**
		 * 送出「置頂／封存」（兩個端點同一個 body 形狀）。
		 * @param chain - 鏈名（伺服器會再過一次對照表）
		 * @param on - true＝加上、false＝拿掉
		 * @param kind - `pin` 或 `archive`
		 * @returns 宿主回的新 payload（或 null）
		 */
		async function requestFlag(kind, chain, on) {
			const response = await fetch(kind === "pin" ? resolvePinEndpoint() : resolveArchiveEndpoint(), {
				method: "POST",
				headers: { "content-type": "application/json", accept: "application/json" },
				body: JSON.stringify({ chain, on }),
			});
			if (!response.ok) {
				const payload = await response.json().catch(() => ({}));
				throw new Error(payload?.error ?? `HTTP ${response.status}`);
			}
			return response.json().catch(() => null);
		}

		async function requestRename(from, to) {
			const response = await fetch(resolveRenameEndpoint(), {
				method: "POST",
				headers: { "content-type": "application/json", accept: "application/json" },
				body: JSON.stringify({ from, to }),
			});
			if (!response.ok) {
				const payload = await response.json().catch(() => ({}));
				throw new Error(payload?.error ?? `HTTP ${response.status}`);
			}
			return response.json().catch(() => null);
		}

		/**
		 * 取「第一句話」的前 20 字當內容預覽（改名之後，這是唯一還認得出內容的線索）。
		 * @param text - 第一句話
		 * @returns 預覽字串（空字串代表沒有）
		 */
		function previewOf(text) {
			const value = typeof text === "string" ? text.replace(/\s+/gu, " ").trim() : "";
			if (value === "") return "";
			return value.length > 20 ? `${value.slice(0, 20)}…` : value;
		}

		/** 時間戳 → `MM-DD HH:mm`（本地時區）。 */
		function formatTime(ms) {
			if (!Number.isFinite(ms)) return "—";
			const date = new Date(ms);
			const pad = (value) => String(value).padStart(2, "0");
			return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
		}

		/** 時間戳 → `HH:mm:ss`（含秒；「重抓」有沒有作用要看得出差別）。 */
		function formatClock(ms) {
			if (!Number.isFinite(ms)) return "—";
			const date = new Date(ms);
			const pad = (value) => String(value).padStart(2, "0");
			return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
		}

		/**
		 * 從內建側邊欄的 DOM 讀「目前這一場」。
		 *
		 * 內建清單列（`dsh-client-ui-workspace` 的 shipped bundle 實測，2026-10-17）長這樣：
		 *   `<div data-row-key="session:<id>" role="treeitem" aria-selected={selected}>`
		 * 這是所有來源裡**最貼近使用者眼睛**的一個：他就是看到那一列被選取。
		 * @param doc - `document`（測試會塞替身）
		 * @returns session id 或 null
		 */
		function readCurrentSessionIdFromDom(doc) {
			try {
				const row = doc?.querySelector?.('[data-row-key^="session:"][aria-selected="true"]');
				const key = row?.getAttribute?.("data-row-key");
				if (typeof key === "string" && key.startsWith("session:")) return key.slice("session:".length);
			} catch {
				/* DOM 換了形狀就當作讀不到 */
			}
			return null;
		}

		/**
		 * 從 `uiWorkspace` 服務讀「目前這一場」（DOM 讀不到時的來源）。
		 *
		 * 兩個公開欄位（依可信度）：
		 *   1. `selection`：內建「目前選取的對話」store（持久化名 `dsh.sessions.current`），
		 *      `replaceMain()` 每次切換都會 `selection.set({sessionId, …})`；
		 *   2. `mainReference`：主視窗目前持有的那場對話。
		 * @param workspace - `ctx.get("uiWorkspace")` 拿到的服務（可為 undefined）
		 * @returns session id 或 null
		 */
		function readCurrentSessionIdFromService(workspace) {
			try {
				const snapshot = workspace?.selection?.getSnapshot?.();
				const fromSelection = snapshot?.sessionId ?? snapshot?.subagentAddress?.sessionId;
				if (typeof fromSelection === "string" && fromSelection !== "") return fromSelection;
				const fromMain = workspace?.mainReference?.sessionId;
				if (typeof fromMain === "string" && fromMain !== "") return fromMain;
			} catch {
				/* 服務換了形狀就當作讀不到 */
			}
			return null;
		}

		/**
		 * 讀「目前這一場」的 session id —— 面板要標出「你在這裡」。
		 *
		 * 兩條來路，**DOM 優先**：使用者眼睛看到的是側邊欄那一列，所以先問 DOM；
		 * 側邊欄還沒掛好（例如剛建立的新對話）才問服務。兩條都讀不到就回 `null`：
		 * 面板只會少一個亮底與提示，**不會壞掉**（版本不合時的安全網）。
		 * @param workspace - `ctx.get("uiWorkspace")` 拿到的服務（可為 undefined）
		 * @returns session id 或 null
		 */
		function readCurrentSessionId(workspace) {
			return readCurrentSessionIdFromDom(globalThis.document) ?? readCurrentSessionIdFromService(workspace);
		}

		/**
		 * 套用「編號計畫」：只呼叫 `sessions.rename()`，改完 POST 回報一次。
		 *
		 * 為什麼要抽成可注入依賴的函式：暫停、要確認、失敗不中斷、服務缺席 —— 這四個判斷
		 * 錯了會很難看（例如暫停失效就變成「每次輪詢都改標題」），做成可測單元比在元件裡 try/catch 可靠。
		 * @param {{plan?: object, sessions?: object|null, post?: Function,
		 *          paused?: boolean, force?: boolean}} [input] - 計畫、改名服務、回報函式與兩個開關
		 * @returns {Promise<{status: string, applied: Array, failed: Array, payload?: any}>}
		 *   `status`：`applied`／`skipped-paused`／`skipped-confirm`／`skipped-nothing`／`skipped-no-service`
		 */
		async function applyNumberingPlan(input = {}) {
			const plan = input?.plan;
			const items = Array.isArray(plan?.items) ? plan.items : [];
			const restores = Array.isArray(plan?.restores) ? plan.restores : [];
			if (input?.paused === true) return { status: "skipped-paused", applied: [], failed: [] };
			if (plan?.needsConfirm === true && input?.force !== true) return { status: "skipped-confirm", applied: [], failed: [] };
			if (items.length === 0 && restores.length === 0) return { status: "skipped-nothing", applied: [], failed: [] };
			const sessions = input?.sessions;
			if (typeof sessions?.rename !== "function") return { status: "skipped-no-service", applied: [], failed: [] };

			const applied = [];
			const failed = [];
			// 先 items（已由宿主依號碼由大到小排好），再 restores（取消歸鏈的還原）。
			for (const entry of [...items, ...restores]) {
				if (typeof entry?.sessionId !== "string" || typeof entry?.to !== "string") continue;
				try {
					const result = await sessions.rename(entry.sessionId, entry.to);
					if (result !== undefined && result !== null && result.ok === false) {
						failed.push({ sessionId: entry.sessionId, reason: String(result?.error?.message ?? result?.error ?? "rename failed") });
					} else {
						applied.push({ sessionId: entry.sessionId, from: typeof entry.from === "string" ? entry.from : null, to: entry.to });
					}
				} catch (error) {
					failed.push({ sessionId: entry.sessionId, reason: String(error?.message ?? error) });
				}
			}
			let payload;
			if (applied.length > 0 && typeof input?.post === "function") {
				try {
					payload = await input.post({ applied, failed });
				} catch (error) {
					console.warn("[session-chains] 標題回報失敗：", error?.message ?? error);
				}
			}
			return { status: "applied", applied, failed, payload };
		}

		/**
		 * 把 `sessions` 服務包成 `{rename}` 介面（改名只走**內建同一條路徑**）。
		 *
		 * 內建側邊欄的重新命名是：
		 * `sessions.using(id, { source: "workspaceOperation" }, (ref) => ref.binding.session.rename(title))`
		 * —— 服務本身**沒有** `rename()`（2026-10-18 實測：這裡原本誤判成「找不到 sessions 服務」）。
		 * @param sessions - `ctx.get("sessions")` 的服務
		 * @returns `{rename}` 或 null（真的沒有可用介面時）
		 */
		function sessionRenamer(sessions) {
			if (sessions === null || sessions === undefined) return null;
			if (typeof sessions.using === "function") {
				return {
					async rename(sessionId, title) {
						const result = await sessions.using(sessionId, { source: "workspaceOperation" }, (reference) =>
							reference.binding.session.rename(title),
						);
						if (result !== undefined && result !== null && result.ok === false) {
							return { ok: false, error: result.error ?? { message: "rename failed" } };
						}
						return { ok: true };
					},
				};
			}
			// 舊介面（若哪天服務直接提供 rename）。
			if (typeof sessions.rename === "function") {
				return { rename: (sessionId, title) => sessions.rename(sessionId, title) };
			}
			return null;
		}

		// ── 常駐 HUD（原 `dsh-token-hud` 專案，2026-10-18 併入同一個外掛）──────────
		// 使用者要「歸納成一個 skill」：HUD 與交接提醒共用同一個插槽、同一組設定，
		// 分成兩個專案只會讓安裝與設定分岔（而且兩邊都要各改一次）。
		// 資料：日／週／月＋餘額由宿主路由 `/local/session-chains.usage` 提供；本場由投影（反應式）供給。
		/** 餘額／日週月的輪詢間隔（毫秒）。 */
		const HUD_POLL_MS = 5000;

		/** 拿不到數字時的佔位字元。 */
		const HUD_DASH = "—";

		/**
		 * 組出用量路由的 URL（照內建 transport 規則；頁面 origin 不是 http）。
		 * @returns 絕對 URL
		 */
		function resolveUsageEndpoint() {
			const base = globalThis.__DSH_TRANSPORT__?.streamBaseUrl ?? document.baseURI;
			return new URL("local/session-chains.usage", base).href;
		}

		/**
		 * token 數的短寫法（<1000 原值、<1e6 用 k、其餘用 M）。
		 * @param value - 非負整數
		 * @returns 顯示字串；不是有限數時回 `—`
		 */
		function formatTokens(value) {
			if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return HUD_DASH;
			const scaled = (candidate) => (candidate >= 100 ? String(Math.round(candidate)) : String(Math.round(candidate * 10) / 10));
			if (value < 1e3) return String(value);
			if (value < 1e6) return `${scaled(value / 1e3)}k`;
			return `${scaled(value / 1e6)}M`;
		}

		/**
		 * 餘額：只有 `ready` 才顯示金額，其餘一律 `—`（**絕不顯示 0**，那會讓人以為沒錢）。
		 * @param balance - 路由回的 balance 區塊
		 * @returns 例如 `¥93.40`
		 */
		function formatBalance(balance) {
			if (balance === null || balance === undefined || balance.status !== "ready") return HUD_DASH;
			const wallets = (Array.isArray(balance.wallets) ? balance.wallets : []).filter((candidate) => Number.isFinite(Number(candidate?.balance)));
			if (wallets.length === 0) return HUD_DASH;
			const wallet = wallets.reduce((best, candidate) => (Number(candidate.balance) > Number(best.balance) ? candidate : best));
			const symbol = wallet.currency === "CNY" ? "¥" : wallet.currency === "USD" ? "$" : `${wallet.currency ?? ""} `;
			return `${symbol}${Number(wallet.balance).toFixed(2)}`;
		}

		/** 帶千分位的完整數字（給 tooltip 用）。 */
		function formatFull(value) {
			return typeof value === "number" && Number.isFinite(value) ? value.toLocaleString("en-US") : HUD_DASH;
		}

		/**
		 * 「本場」那一段（投影 hooks 住在這裡；父層只決定要不要渲染它）。
		 * @param {{useProjection: Function, accent: string, alertSteps: number}} props - 投影、警示色、提醒門檻
		 * @returns 元素
		 */
		function HudSession({ useProjection, accent, sessionColor, hudBg, alertSteps }) {
			const pressure = useProjection("contextPressure");
			const stats = useProjection("sessionStats");
			const usage = useProjection("tokenUsage");
			const contextTokens = pressure?.projectedTokens ?? pressure?.pressureTokens;
			const steps = stats?.steps;
			const text =
				contextTokens === undefined && steps === undefined
					? HUD_DASH
					: `${contextTokens === undefined ? HUD_DASH : formatTokens(contextTokens)}/${steps === undefined ? HUD_DASH : steps}`;
			const alert = typeof steps === "number" && Number.isFinite(steps) && steps >= alertSteps;
			const title = [
				`本場：上下文 ${formatFull(contextTokens)} ・ 請求 ${steps === undefined ? HUD_DASH : formatFull(steps)}`,
				usage === undefined
					? null
					: `四桶：未快取 ${formatFull(usage.uncachedInputTokens)}／快取讀 ${formatFull(usage.cacheReadTokens)}／快取寫 ${formatFull(usage.cacheWriteTokens)}／輸出 ${formatFull(usage.outputTokens)}`,
				alert ? `⚠ 本場請求數已達 ${alertSteps}：依 CLAUDE.md 13.5 建議開新對話` : null,
			]
				.filter((line) => line !== null)
				.join("\n");
			return h(
				"span",
				{
					"data-token-hud-session": "",
					"data-token-hud-alert": alert ? "" : undefined,
					title,
					// 顏色（2026-10-18）：文字色與警示底色都在面板 ⚙ 改。
					style: {
						borderRadius: "3px",
						color: sessionColor,
						fontWeight: alert ? "bold" : undefined,
						background: alert ? hudBg : undefined,
						padding: alert ? "0 4px" : undefined,
					},
				},
				`本場 ${text}`,
			);
		}

		/**
		 * 常駐 HUD 本體：哪幾段要顯示由設定決定（五個勾選）。
		 * @param props - 插槽 props（需要 `useProjection` 才有「本場」）
		 * @returns 元素或 null（全部關掉／讀不到就整行隱藏）
		 */
		function TokenHud(props) {
			const [remote, setRemote] = React.useState(null);
			const [failed, setFailed] = React.useState(false);
			const [hovered, setHovered] = React.useState(false);
			const settings = readSettings();

			React.useEffect(() => {
				let cancelled = false;
				const load = async () => {
					if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
					try {
						const response = await fetch(resolveUsageEndpoint(), { headers: { accept: "application/json" } });
						if (!response.ok) throw new Error(`HTTP ${response.status}`);
						const data = await response.json();
						if (!cancelled) {
							setRemote(data);
							setFailed(false);
						}
					} catch (error) {
						console.warn("[session-chains] 取不到用量：", error?.message ?? error);
						if (!cancelled) setFailed(true);
					}
				};
				load();
				const timer = setInterval(load, HUD_POLL_MS);
				return () => {
					cancelled = true;
					clearInterval(timer);
				};
			}, []);

			if (failed) return null;
			const totals = remote?.totals;
			const parts = [];
			if (settings.showBalance) parts.push(`餘額 ${formatBalance(remote?.balance)}`);
			if (settings.showToday) parts.push(`今日 ${formatTokens(totals?.today?.total)}`);
			if (settings.showWeek) parts.push(`本週 ${formatTokens(totals?.week?.total)}`);
			if (settings.showMonth) parts.push(`本月 ${formatTokens(totals?.month?.total)}`);
			if (settings.showSession && typeof props?.useProjection === "function") {
				parts.push(
					h(HudSession, {
						useProjection: props.useProjection,
						accent: settings.accent,
						sessionColor: settings.sessionColor,
						hudBg: settings.hudBg,
						alertSteps: settings.warnSteps,
					}),
				);
			}
			if (parts.length === 0) return null;

			const children = [];
			parts.forEach((part, index) => {
				if (index > 0) children.push(" · ");
				children.push(part);
			});

			return h(
				"span",
				{
					"data-token-hud": "",
					title: [
						// 2026-10-18：使用者問「為什麼和『今日消費』不一樣」——把統計方式寫在 tooltip 裡。
						"統計方式：讀 ~/.dsh/sessions 的日誌（input＋快取讀＋快取寫＋output），涵蓋整個本地日、所有工作區。",
						"與『今日消費』(dsh-usage) 不同：那一個只記它執行時看到的事件，沒有回填，所以數字會比較小。",
						`今日 ${formatFull(totals?.today?.total)} ・ 本週 ${formatFull(totals?.week?.total)} ・ 本月 ${formatFull(totals?.month?.total)}`,
					].join("\n"),
					onMouseEnter: () => setHovered(true),
					onMouseLeave: () => setHovered(false),
					style: {
						alignItems: "center",
						color: hovered ? "var(--dsw-alias-label-secondary)" : "var(--dsw-alias-label-tertiary)",
						display: "inline-flex",
						fontFamily: "inherit",
						fontSize: "var(--dsh-content-font-size-secondary, 13px)",
						fontVariantNumeric: "tabular-nums",
						lineHeight: "calc(20px + var(--dsh-content-font-delta-secondary, 0px))",
						padding: "1px 8px",
						whiteSpace: "nowrap",
					},
				},
				...children,
			);
		}

		// ── 交接強制提醒（2026-10-18 使用者指示：超過門檻不能只有右下角變色）──────
		// 資料來源：插槽 `conversation.composer.dock` 會把 `useProjection` 帶進來（`dsh-token-hud`
		// 就是這樣拿到「本場 x/y」的），所以我們讀得到 `contextPressure`（上下文）與 `sessionStats`（請求數），
		// 而且是**反應式**的（不用輪詢）。門檻照面板設定（預設 80／120 次、160k／240k；
		// `CLAUDE.md` 13.5 已改成「以面板現值為準」，不再寫死 100–150／30 萬）。
		// ── 設定（2026-10-18 使用者指示：未來要打包到 GitHub，門檻／字級／顏色都要能調）──
		/** 設定的 localStorage key。整包只有這一份，面板上的 ⚙ 就是在改它。 */
		const SETTINGS_KEY = "dsh.session-chains.settings";

		/**
		 * 預設設定。
		 *
		 * 2026-10-18 依實際用量重定（使用者指示「寫進預設」；舊值 80／120、160k／240k 切太早）：
		 * 回放 42 場有工作的對話 —— 步數中位 91、p75 188、p90 303、最大 463；
		 * 場末上下文中位 226k、p90 470k、最大 593k（視窗 1,048,576）。
		 * 舊值會在 **25/42 場**觸發（觸發時中位還剩 103 步 ＝ 一定半路被切），
		 * 新值 200／320 步、320k／480k 只在 **6/42 場**觸發，且都是 300 步以上或 470k 以上的長場。
		 * 分工：**warn 是「該收尾了」的提示（不動作）**，**hard 才是自動交接的緊急煞車**。
		 * 比例留 50%／65%：1M 視窗下幾乎不會先觸發，但換成小視窗模型時它會自動先擋。
		 * 這些都只是**預設值**，面板上改得動、也跟著 localStorage 走；
		 * `CLAUDE.md` 13.5／13.6 一律以面板現值為準（不另設固定下限）。
		 */
		const DEFAULT_SETTINGS = {
			font: 12,
			accent: "#C62828",
			// 顏色（2026-10-18 使用者指示）：三處各自可調。
			sessionColor: "#C62828", // HUD「本場 448k/276k」的文字色
			hudBg: "#FFE58F", // HUD 警示時的底色（達門檻才出現）
			highlight: "#CFE7FF", // 交接鏈「你在這裡」的亮底（反光）
			badge: "#FFE58F", // 面板鏈標題／「起點」的黃底
			// 勾選項：工作區區塊要不要出現那顆上下箭頭（使用者可以在設定裡關掉）。
			foldWorkspace: true,
			// HUD 五段：哪幾段要顯示（2026-10-18 使用者指示）。
			showBalance: true,
			showToday: true,
			showWeek: true,
			showMonth: true,
			showSession: true,
			warnSteps: 200,
			hardSteps: 320,
			warnTokens: 320000,
			hardTokens: 480000,
			warnRatio: 0.5,
			hardRatio: 0.65,
			// 鏈的排序（2026-10-18 使用者指示）：名稱／建立時間／場次數，可正可反。
			sortBy: "created",
			sortDir: "asc",
			// 卡片標題（2026-10-18 使用者指示）：預設不顯示「N 條鏈・M 場」（可在 ⚙ 打開）；
			// 右側三顆圖示預設比原本大兩級。
			showCardSummary: false,
			stripIconSize: 15,
			// 2026-10-18 使用者指定：到達門檻、這一輪結束後**自動交接**——
			// 生成交接詞 → 開新對話 → 貼上 → 送出 → 切過去（一個開關；預設開，可關）。
			autoHandoff: true,
		};

		/** 排序鍵的合法值（讀到別的一律回預設）。 */
		const SORT_KEYS = ["chain", "created", "count", "lastAt"];

		/**
		 * 讀設定（壞值一律回預設；缺的欄位補預設）。
		 * @returns 設定物件
		 */
		function readSettings() {
			const settings = { ...DEFAULT_SETTINGS };
			try {
				const raw = globalThis.localStorage?.getItem(SETTINGS_KEY);
				const parsed = raw === null || raw === undefined ? null : JSON.parse(raw);
				if (parsed !== null && typeof parsed === "object") {
					for (const key of Object.keys(DEFAULT_SETTINGS)) {
						const value = parsed[key];
						if (typeof DEFAULT_SETTINGS[key] === "boolean") {
							if (typeof value === "boolean") settings[key] = value;
						} else if (typeof DEFAULT_SETTINGS[key] === "number") {
							const number = Number(value);
							if (Number.isFinite(number) && number > 0) settings[key] = number;
						} else if (typeof value === "string" && value !== "") {
							settings[key] = value;
						}
					}
				}
			} catch {
				/* 壞值就用預設 */
			}
			// 字級夾在看得見的範圍（10–16）：存壞了也不會讓側欄爆掉。
			settings.font = Math.min(16, Math.max(10, Math.round(Number(settings.font) || DEFAULT_SETTINGS.font)));
			// 排序鍵／方向：只收白名單（存壞了不會讓清單消失或排序亂掉）。
			if (!SORT_KEYS.includes(settings.sortBy)) settings.sortBy = DEFAULT_SETTINGS.sortBy;
			if (settings.sortDir !== "asc" && settings.sortDir !== "desc") settings.sortDir = DEFAULT_SETTINGS.sortDir;
			// 卡片右側圖示：夾在 10–24px（存壞了也不會把標題擠爆）。
			settings.stripIconSize = Math.min(24, Math.max(10, Math.round(Number(settings.stripIconSize) || DEFAULT_SETTINGS.stripIconSize)));
			// 顏色一律驗成 `#RRGGBB`，壞值回預設（避免把整個畫面變成透明或黑字黑底）。
			for (const key of ["accent", "sessionColor", "hudBg", "highlight", "badge"]) {
				settings[key] = /^#[0-9a-fA-F]{6}$/u.test(String(settings[key])) ? String(settings[key]) : DEFAULT_SETTINGS[key];
			}
			return settings;
		}

		/**
		 * 寫設定（只覆寫給的欄位，其餘保留）。
		 * @param patch - 要改的欄位
		 * @returns 寫入後的完整設定
		 */
		function writeSettings(patch = {}) {
			const next = { ...readSettings(), ...(patch ?? {}) };
			try {
				globalThis.localStorage?.setItem(SETTINGS_KEY, JSON.stringify(next));
			} catch {
				/* 記不住就算了（這一次仍然生效） */
			}
			// 卡片與面板各自一份 state：改了要讓另一邊立刻跟上（不用等下一次輪詢）。
			for (const listener of SETTINGS_LISTENERS) {
				try {
					listener();
				} catch {
					/* 單一訂閱者壞掉不影響其他人 */
				}
			}
			return readSettings();
		}

		/** 設定變更的訂閱者（卡片／面板同步用）。 */
		const SETTINGS_LISTENERS = new Set();

		/**
		 * 訂閱設定變更。
		 * @param listener - 變更後呼叫（讀 `readSettings()` 拿新值）
		 * @returns 取消訂閱
		 */
		function subscribeSettings(listener) {
			SETTINGS_LISTENERS.add(listener);
			return () => SETTINGS_LISTENERS.delete(listener);
		}

		/**
		 * 依設定排序鏈（不改變原陣列）。
		 *
		 * @param chains - 鏈的陣列
		 * @param sortBy - `chain`（名稱）／`created`（建立時間＝第一場的 startedAt）／`count`（場次數）
		 *                 ／`lastAt`（最後一次對話時間）
		 * @param sortDir - `asc`／`desc`
		 * @returns 排序後的新陣列
		 */
		function sortChains(chains, sortBy, sortDir, pinned = []) {
			const list = Array.isArray(chains) ? [...chains] : [];
			const direction = sortDir === "desc" ? -1 : 1;
			// 置頂是「位置」不是「排序」：不管選哪個排序鍵，置頂的鏈一律在最前面。
			const pinnedSet = new Set(Array.isArray(pinned) ? pinned : []);
			let collator = null;
			try {
				collator = new Intl.Collator("zh-Hant", { numeric: true, sensitivity: "base" });
			} catch {
				collator = null;
			}
			const byName = (a, b) => {
				const left = String(a?.chain ?? "");
				const right = String(b?.chain ?? "");
				return collator === null ? left.localeCompare(right) : collator.compare(left, right);
			};
			list.sort((a, b) => {
				const leftPinned = pinnedSet.has(String(a?.chain ?? "")) ? 1 : 0;
				const rightPinned = pinnedSet.has(String(b?.chain ?? "")) ? 1 : 0;
				if (leftPinned !== rightPinned) return rightPinned - leftPinned;
				let compare = 0;
				if (sortBy === "chain") compare = byName(a, b);
				else if (sortBy === "count") compare = (Number(a?.count) || 0) - (Number(b?.count) || 0);
				else if (sortBy === "lastAt") compare = (Number(a?.lastAt) || 0) - (Number(b?.lastAt) || 0);
				else compare = (Number(a?.firstAt) || 0) - (Number(b?.firstAt) || 0);
				// 同值時用名稱當第二鍵：順序穩定，重新整理不會跳來跳去。
				if (compare === 0 && sortBy !== "chain") compare = byName(a, b);
				return compare * direction;
			});
			return list;
		}

		/**
		 * 讀「哪些建議已經按過」（**一組一組**記）。
		 *
		 * 舊版只記一個 `"1"`（全域關掉）——使用者實測：併了第一組之後，其他組再也不出現。
		 * 這裡對舊格式回空陣列，讓建議重新出現一次（反正它只是建議、不會自己寫入）。
		 * @returns 已略過／已併入的標籤陣列
		 */
		function readDismissedSuggestions() {
			try {
				const raw = globalThis.localStorage?.getItem("dsh.session-chains.suggest-dismissed");
				if (raw === null || raw === undefined || raw === "") return [];
				const parsed = JSON.parse(raw);
				return Array.isArray(parsed) ? parsed.filter((label) => typeof label === "string" && label !== "") : [];
			} catch {
				return [];
			}
		}

		/** 交接門檻（預設值；實際值由 `readHandoffThresholds()` 從設定取）。 */
		const HANDOFF_THRESHOLDS = { ...DEFAULT_SETTINGS };

		/** 按了「延後」之後暫時不再提醒（毫秒時間戳）。 */
		const HANDOFF_DEFER_KEY = "dsh.session-chains.handoff-defer";

		/**
		 * 讀門檻（預設值 ＋ localStorage 覆寫；壞值一律忽略）。
		 * @returns 門檻物件
		 */
		function readHandoffThresholds() {
			// 門檻現在跟字級／顏色一起放在設定裡（面板上的 ⚙ 改的就是這一份）。
			const settings = readSettings();
			const merged = {};
			for (const key of Object.keys(HANDOFF_THRESHOLDS)) merged[key] = Number(settings[key]) || HANDOFF_THRESHOLDS[key];
			return merged;
		}

		/**
		 * 判斷「該不該交接」——**純函式**（給測試與 UI 共用）。
		 *
		 * 三個訊號任一達標就算：請求數、上下文 tokens、相對於 contextWindow 的比例。
		 * 之所以同時看比例：不同模型的視窗大小不同（200k／1M），只看絕對值會誤判。
		 * @param {{steps?: number, tokens?: number, contextWindow?: number, thresholds?: object}} [input] - 三個訊號與門檻
		 * @returns {{level: "ok"|"warn"|"hard", reasons: string[], steps?: number, tokens?: number, ratio?: number}}
		 */
		function handoffLevel(input = {}) {
			const limits = { ...HANDOFF_THRESHOLDS, ...(input.thresholds ?? {}) };
			const finite = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;
			const steps = finite(input.steps) ? input.steps : undefined;
			const tokens = finite(input.tokens) ? input.tokens : undefined;
			const window = finite(input.contextWindow) && input.contextWindow > 0 ? input.contextWindow : undefined;
			const ratio = tokens !== undefined && window !== undefined ? tokens / window : undefined;

			const reasons = [];
			const hit = (condition, text) => {
				if (condition) reasons.push(text);
			};
			hit(steps !== undefined && steps >= limits.hardSteps, `請求 ${steps} 次（上限 ${limits.hardSteps}）`);
			hit(tokens !== undefined && tokens >= limits.hardTokens, `上下文 ${tokens} tokens（上限 ${limits.hardTokens}）`);
			hit(ratio !== undefined && ratio >= limits.hardRatio, `上下文已用 ${Math.round(ratio * 100)}%（上限 ${Math.round(limits.hardRatio * 100)}%）`);
			const hard = reasons.length > 0;
			if (!hard) {
				hit(steps !== undefined && steps >= limits.warnSteps, `請求 ${steps} 次（提醒 ${limits.warnSteps}）`);
				hit(tokens !== undefined && tokens >= limits.warnTokens, `上下文 ${tokens} tokens（提醒 ${limits.warnTokens}）`);
				hit(ratio !== undefined && ratio >= limits.warnRatio, `上下文已用 ${Math.round(ratio * 100)}%（提醒 ${Math.round(limits.warnRatio * 100)}%）`);
			}
			const level = hard ? "hard" : reasons.length > 0 ? "warn" : "ok";
			return { level, reasons, steps, tokens, ratio };
		}

		/**
		 * 要貼給模型看的交接指示（使用者按「複製」拿到的就是這一段）。
		 *
		 * 為什麼不是「產生好的提示詞」：接續提示詞要寫「這一場做了什麼、下一步是什麼」，
		 * 只有這一場的模型知道；所以我們給的是**指令**，讓它照 `CLAUDE.md` 13.6 產出。
		 * @param {{chain?: string|null}} [input] - 目前的鏈名（有就一起寫進去）
		 * @returns 指示文字
		 */
		function handoffPrompt({ chain = null } = {}) {
			// 鏈代號那一行要**整行就是**標記：面板解析時，`鏈=` 後面接一個中文詞再加冒號
			// 也會被當成鏈名（實測會生出一個叫「代號」的鏈），所以這裡把格式寫死、不要留「：」。
			const chainRule =
				typeof chain === "string" && chain !== ""
					? `那一行整行就是 鏈=${chain}（不要接冒號或說明）。`
					: "那一行整行就是 鏈=<代號>（代號沿用本場第一句話的鏈；沒有就用專案目錄名），後面不要接冒號或說明。";
			// 這段話是**貼在這一場送出**的（不是貼到新對話）：先寫交接單，最後才產出「接續提示詞」。
			// 2026-10-18 使用者問「這樣正確嗎」→ 對照 CLAUDE.md 13.6 補齊三件事：
			// 檔名規則、HANDOFF.md 的處理、三種結論各自的條件（舊版只寫了「宣布完成」）。
			// 2026-10-18 再補（把交接收尾成「貼上就能開工」）：狀態接鏈上前一場、接手先核對回報、
			// 產出提示詞後自己 pbcopy 並用 pbpaste 驗第一行（使用者不必再手動複製）。
			// 2026-10-18 第三輪（使用者反映交接太慢）：分輕／重兩級，預設輕交接不重跑全套基線。
			return [
				"【現在交接這一場】請依 CLAUDE.md 13.6 直接開始做，不用先問我：",
				"0. 先分級（預設輕交接）：輕交接＝同一條線、有明確下一步、交接時未達面板 hard 門檻（以 ⚙ 現值為準）→ 只寫重點、不重跑全套基線；",
				"   重交接＝跨專案、高風險、換人、狀態不明 → 才寫完整單並重跑基線。",
				"1. 交接單：在專案目錄寫 `交接-<YYYY-MM-DD>.md`（該專案已有 HANDOFF.md 就更新它，不要另開新檔）；",
				"   正文 ≤60 行；結論三選一 —— 「還要繼續」要給至少一條下一步；「宣布完成」要附可重跑的指令與輸出；",
				"   「宣布卡住」要寫出具體阻塞條件（連續三輪才算卡住）。交接單也要記下本場的鏈代號。",
				"   「目前狀態」以鏈上前一場為主體（別寫成「本場沒做事」，那樣下一場接不到脈絡）。",
				"2. 記憶：用 cross-session-memory 寫一則標題為 交接：<專案>（<日期>） 的記憶，只寫結論與理由。",
				"3. 接續提示詞（給新對話貼的）：第一句就是「先讀哪幾個檔」；要有目前狀態、下一個動作、不要重做的事、",
				`   不變的約束，而且每個路徑都要真的存在。必須含一行鏈代號：${chainRule}`,
				"   輕交接寫明「只讀交接單＋哪一個關鍵檔，抽查 1–2 個數字，不要重跑五條基線」；",
				"   重交接寫明「讀完整交接單與基線，回報差異才動手」。",
				"4. 跑驗證並貼出輸出（不要只說「都通過了」）：輕交接只跑這次會動到的指令；重交接跑完整基線。",
				"5. 產出提示詞後直接 pbcopy，再用 pbpaste | head -3 確認第一行是「先讀」——讓使用者貼上就能開工。",
				"6. 最後把**接續提示詞全文**寫到 `30-CodingSkills/dsh-session-chains/.state/next-prompt.txt`（只寫提示詞本身、不要加說明）；面板的「交接→新對話」會讀它，按一下就會開新對話並貼上。",
			].join("\n");
		}

		/**
		 * 算出提醒要貼在哪裡：**對話欄的正中央、訊息區的最上面**。
		 *
		 * 為什麼不直接 `left: 50%`：那是「視窗」的正中央。左邊有側欄（280px）、右邊可能有面板，
		 * 對話欄並不是視窗的正中央 —— 上一版就是這樣被說「位置沒有貼齊」。
		 * 這裡拿兩個**實際的**長方形來算：
		 *   - `dock`：輸入框那一區（`[data-composer-dock]`）＝ 對話欄的寬度與左右位置；
		 *   - `scroll`：訊息捲動區（`[class*="scrollBody"]`）＝ 對話框的最上面。
		 * @param {{dock?: object, scroll?: object}} [input] - 兩個元素的 `getBoundingClientRect()`
		 * @returns `{left, top, width}` 或 null（量不到就讓呼叫端用後備值）
		 */
		function handoffAnchor(input = {}) {
			const dock = input?.dock;
			const scroll = input?.scroll;
			if (dock === null || dock === undefined) return null;
			if (!Number.isFinite(dock.left) || !Number.isFinite(dock.width) || dock.width <= 0) return null;
			const left = dock.left + dock.width / 2;
			const top = (scroll !== null && scroll !== undefined && Number.isFinite(scroll.top) ? scroll.top : dock.top) + 8;
			if (!Number.isFinite(left) || !Number.isFinite(top)) return null;
			return {
				left: Math.round(left),
				top: Math.round(top),
				// 寬度跟輸入框一樣（再寬也不會超出），最小 240px 免得窄視窗擠成一團。
				width: Math.max(240, Math.round(dock.width)),
			};
		}

		/** 讀「延後到什麼時候」（毫秒；0＝沒延後）。 */
		function readHandoffDefer() {
			try {
				const value = Number(globalThis.localStorage?.getItem(HANDOFF_DEFER_KEY));
				return Number.isFinite(value) && value > 0 ? value : 0;
			} catch {
				return 0;
			}
		}

		/**
		 * 記住「延後到什麼時候」。**只存在本機**（不寫進 session log）。
		 * @param until - 毫秒時間戳
		 */
		function writeHandoffDefer(until) {
			try {
				globalThis.localStorage?.setItem(HANDOFF_DEFER_KEY, String(until));
			} catch {
				/* 記不住就算了 */
			}
		}

		/**
		 * 交接提醒元件（外層）：插槽沒有給 `useProjection` 時整顆不渲染。
		 *
		 * 為什麼要拆兩層：`useProjection` 底下是 hook，**不能條件式呼叫**；
		 * 由外層決定「要不要渲染內層」，內層的 hook 數量才會固定（`dsh-token-hud` 同一個教訓）。
		 * @param props - 插槽 props（需要 `useProjection`）
		 * @returns 元素或 null
		 */
		function HandoffGuard(props) {
			// 兩個投影讀取器都要在：`useProjection`（數字）與 `useSession`（這一輪跑完沒）。
			// 少一個就整顆不渲染 —— 寧可沒有提醒，也不要在串流中亂跳。
			if (typeof props?.useProjection !== "function" || typeof props?.useSession !== "function") return null;
			return h(HandoffGuardBody, props);
		}

		/**
		 * 交接提醒本體：超過門檻就在畫面上方壓一條**看不見也難**的橫幅。
		 *
		 * 設計上的取捨：不擋住整個畫面（那會讓人沒辦法存檔），但
		 * **hard 級沒有「關掉」**，只有「延後 5 分鐘」；過了延後時間會自己回來。
		 * @param {{useProjection: Function}} props - 投影讀取器
		 * @returns 元素或 null
		 */
		function HandoffGuardBody({ useProjection, useSession }) {
			const pressure = useProjection("contextPressure");
			const stats = useProjection("sessionStats");
			// **關鍵**：串流中（這一輪還沒結束）不要跳提醒。
			// 使用者實測回報：「訊息還在跳，你複製的已經是舊資訊了」——數字與狀態都還在變，
			// 這時候叫人交接、或先把交接指示放進剪貼簿，都是拿一個下一秒就過期的畫面當依據。
			const running = useSession((state) => state?.running === true || state?.busy === true) === true;
			const [tick, setTick] = React.useState(0);
			// 「開新對話」：進行中與失敗原因（沒有實作就不顯示這顆按鈕）。
			const [starting, setStarting] = React.useState(false);
			const [startError, setStartError] = React.useState("");
			// 「在本場生成交接詞」：送交接指令進這一場（省掉複製貼上）。
			const [preparing, setPreparing] = React.useState(false);
			const [prepareError, setPrepareError] = React.useState("");

			// 延後到期要自己回來：30 秒看一次時鐘（便宜，且不依赖使用者操作）。
			React.useEffect(() => {
				const timer = setInterval(() => setTick((value) => value + 1), 30000);
				return () => clearInterval(timer);
			}, []);

			const contextTokens = pressure?.projectedTokens ?? pressure?.pressureTokens;
			const verdict = handoffLevel({
				steps: stats?.steps,
				tokens: contextTokens,
				contextWindow: pressure?.contextWindow,
				thresholds: readHandoffThresholds(),
			});
			const deferredUntil = readHandoffDefer();
			// 三個理由才顯示：真的超標、這一輪已經結束、沒有在延後期內。
			const hidden = verdict.level === "ok" || running || deferredUntil > Date.now();
			// 有沒有交接詞可以先按？橫幅出現時問一次（AI 跑完、橫幅再出現時會再問）。
			const [promptReady, setPromptReady] = React.useState(false);
			// 門檻自動生成：只在 hard、這一輪已結束、設定有開、而且這一場還沒做過時送一次。
			React.useEffect(() => {
				if (hidden || verdict.level !== "hard" || typeof handoffPreparer !== "function") return undefined;
				if (readSettings().autoHandoff !== true) return undefined;
				let cancelled = false;
				Promise.resolve(handoffPreparer({ auto: true })).catch((error) => {
					if (!cancelled) setPrepareError(`自動生成失敗：${error?.message ?? error}`);
				});
				return () => {
					cancelled = true;
				};
			}, [hidden, verdict.level]);

			React.useEffect(() => {
				if (hidden) return undefined;
				let cancelled = false;
				fetch(resolveNextPromptEndpoint(), { headers: { accept: "application/json" } })
					.then((response) => (response.ok ? response.json() : null))
					.then((payload) => {
						if (!cancelled) setPromptReady(typeof payload?.prompt === "string" && payload.prompt.trim() !== "");
					})
					.catch(() => {
						/* 讀不到就當作還沒好（按鈕會顯示等待） */
					});
				return () => {
					cancelled = true;
				};
			}, [hidden]);
			// 自動開新對話：交接詞一好就開＋貼＋切（預設關；只在「這次真的生成過」之後才作用）。
			const autoStarted = React.useRef(false);
			React.useEffect(() => {
				if (hidden || promptReady !== true || autoStarted.current === true) return undefined;
				if (readSettings().autoHandoff !== true || typeof handoffStarter !== "function") return undefined;
				if (handoffPreparedSession === null) return undefined;
				autoStarted.current = true;
				setStarting(true);
				Promise.resolve()
					.then(() => handoffStarter())
					.catch((error) => setStartError(`自動開新對話失敗：${error?.message ?? error}`))
					.finally(() => setStarting(false));
				return undefined;
			}, [hidden, promptReady]);

			// 提醒要貼在「對話欄的正中央、訊息區的最上面」—— 位置是用量的，不是猜的。
			const bannerRef = React.useRef(null);
			const [anchor, setAnchor] = React.useState(null);
			React.useEffect(() => {
				if (hidden) return undefined;
				const measure = () => {
					try {
						const element = bannerRef.current;
						const dock = element?.closest?.("[data-composer-dock]") ?? element?.parentElement ?? null;
						if (dock === null || dock === undefined) return;
						const scroll = dock.closest?.('[class*="scrollBody"]') ?? null;
						const next = handoffAnchor({
							dock: dock.getBoundingClientRect?.() ?? null,
							scroll: scroll?.getBoundingClientRect?.() ?? null,
						});
						if (next !== null) setAnchor((previous) => (previous?.left === next.left && previous?.top === next.top && previous?.width === next.width ? previous : next));
					} catch {
						/* 量不到就用後備位置（畫面不會壞） */
					}
				};
				measure();
				const timer = setInterval(measure, 500);
				globalThis.addEventListener?.("resize", measure);
				return () => {
					clearInterval(timer);
					globalThis.removeEventListener?.("resize", measure);
				};
			}, [hidden]);

			if (hidden) return null;

			const hard = verdict.level === "hard";
			// 「提醒顏色」可以在面板的 ⚙ 改（設定裡的 accent）；warn 固定琥珀色，兩級才分得出來。
			const accent = hard ? readSettings().accent : "#A66300";
			const background = hard ? "rgba(198, 40, 40, 0.10)" : "rgba(214, 137, 16, 0.12)";
			const stepsText = verdict.steps === undefined ? "—" : String(verdict.steps);
			const tokensText =
				verdict.tokens === undefined ? "—" : verdict.tokens >= 1000 ? `${Math.round(verdict.tokens / 1000)}k` : String(verdict.tokens);

			return h(
				"div",
				{
					"data-handoff-guard": verdict.level,
					// 插槽在輸入框上方（畫面底部）；提醒要出現在**眼睛會看到的地方**，所以用 fixed 壓在頂部。
					// 位置：**對話欄的正中央、訊息區最上面**（座標是量 `[data-composer-dock]` 與
					// `[class*="scrollBody"]` 算出來的；量不到才退回視窗置中）。
					// 用 `fixed` 是刻意的：它要浮在訊息上面、不佔用對話的高度。
					ref: bannerRef,
					style: {
						alignItems: "center",
						background: `linear-gradient(180deg, ${background}, transparent), var(--dsw-alias-bg-base, #ffffff)`,
						border: `1px solid ${accent}`,
						borderLeft: `4px solid ${accent}`,
						borderRadius: "10px",
						boxSizing: "border-box",
						boxShadow: "0 2px 10px rgba(0,0,0,0.12)",
						color: "var(--dsw-alias-label-primary, #1f1f1f)",
						display: "flex",
						flexWrap: "wrap",
						fontSize: "12px",
						gap: "6px 10px",
						left: anchor === null ? "50%" : `${anchor.left}px`,
						maxWidth: anchor === null ? "min(560px, calc(100vw - 48px))" : `${anchor.width}px`,
						padding: "8px 12px",
						pointerEvents: "auto",
						position: "fixed",
						top: anchor === null ? "64px" : `${anchor.top}px`,
						transform: "translateX(-50%)",
						width: "max-content",
						zIndex: 70,
					},
				},
				h("strong", { style: { color: accent } }, hard ? "⚠ 該交接了" : "⚠ 接近交接門檻"),
				h(
					"span",
					{ "data-handoff-numbers": "", style: { opacity: 0.85 } },
					`本場 ${tokensText} tokens／${stepsText} 請求`,
				),
				h("span", { style: { opacity: 0.65 } }, verdict.reasons.join("；")),
				// 2026-10-18 使用者指示：生成交接詞可以一鍵完成，**移除「複製指令」按鈕**（與自動複製）。
				// 直接把交接指令送進這一場，AI 就會開始寫。
				typeof handoffPreparer === "function"
					? h(
							"button",
							{
								"data-handoff-prepare": preparing ? "preparing" : "idle",
								type: "button",
								disabled: preparing,
								title: "把交接指令直接送進這一場（不必複製貼上）；AI 寫好交接詞後，「開新對話」就會亮",
								onClick: async () => {
									if (preparing) return;
									setPreparing(true);
									setPrepareError("");
									try {
										await handoffPreparer({ auto: false });
									} catch (error) {
										setPrepareError(`生成失敗：${error?.message ?? error}`);
									} finally {
										setPreparing(false);
									}
								},
								style: {
									background: "transparent",
									border: `1px solid ${accent}`,
									borderRadius: "5px",
									color: accent,
									cursor: "pointer",
									font: "inherit",
									padding: "3px 10px",
									opacity: preparing ? 0.5 : 1,
								},
							},
							preparing ? "生成中…" : "生成交接詞",
						)
					: null,
				// 2026-10-18：同意交接 → 直接開新對話、貼上 AI 寫好的交接詞（一鍵）。
				typeof handoffStarter === "function"
					? h(
							"button",
							{
								"data-handoff-start": starting ? "starting" : promptReady ? "ready" : "waiting",
								type: "button",
								disabled: starting || !promptReady,
								title: promptReady
									? "讀 .state/next-prompt.txt 的交接詞，開新對話並送出"
									: "還沒有交接詞：先按「生成交接詞」讓本場 AI 寫好（會多一輪），這顆才會亮",
								onClick: async () => {
									if (starting) return;
									setStarting(true);
									setStartError("");
									try {
										await handoffStarter();
									} catch (error) {
										setStartError(`開不了新對話：${error?.message ?? error}`);
									} finally {
										setStarting(false);
									}
								},
								style: {
									background: "transparent",
									border: `1px solid ${accent}`,
									borderRadius: "5px",
									color: accent,
									cursor: "pointer",
									font: "inherit",
									padding: "3px 10px",
									opacity: starting || !promptReady ? 0.5 : 1,
								},
							},
							starting ? "開對話中…" : promptReady ? "開新對話" : "等交接詞…",
						)
					: null,
				h(
					"button",
					{
						"data-handoff-defer": "",
						type: "button",
						onClick: () => {
							// hard 只給 5 分鐘（強制：不能一次關掉整天）；warn 給 30 分鐘。
							const minutes = hard ? 5 : 30;
							writeHandoffDefer(Date.now() + minutes * 60000);
							setTick((value) => value + 1);
						},
						style: {
							background: "transparent",
							border: `1px solid ${accent}`,
							borderRadius: "5px",
							color: accent,
							cursor: "pointer",
							font: "inherit",
							padding: "3px 10px",
						},
					},
					hard ? "延後 5 分鐘" : "延後 30 分鐘",
				),
				startError !== ""
					? h("span", { "data-handoff-start-error": "", style: { color: "#B3261E", flexBasis: "100%", fontSize: "11px" } }, startError)
					: null,
				prepareError !== ""
					? h("span", { "data-handoff-prepare-error": "", style: { color: "#B3261E", flexBasis: "100%", fontSize: "11px" } }, prepareError)
					: null,
				h(
					"span",
					{ "data-handoff-hint": "", style: { opacity: 0.65, flexBasis: "100%" } },
					"一鍵流程：按「生成交接詞」→ AI 寫交接單與提示詞（.state/next-prompt.txt）→「開新對話」自動開對話＋貼上＋送出。⚙ 的「到達門檻自動交接」一個開關就含這兩步（只有 hard 會自動出手，warn 不動作）。",
				),
			);
		}

		/**
		 * 「開新對話」的橋：真正的實作在 `apply()` 裡（需要 sessions／uiWorkspace），
		 * 但提醒橫幅是模組層元件，拿不到 ctx —— 所以由 apply 掛進來（沒有就整個按鈕不顯示）。
		 */
		let handoffStarter = null;
		/** 「在本場生成交接詞」的橋（把交接指令直接送進目前這一場，省掉複製貼上）。 */
		let handoffPreparer = null;
		/** 剛剛在哪一場生成過交接詞（只有「這次頁面開啟後真的生成過」才允許自動開新對話，避免撿到舊檔）。 */
		let handoffPreparedSession = null;

		/** 暫停自動編號的 localStorage key（使用者按一下就要記得，跨重新整理）。 */
		const PAUSE_KEY = "dsh.session-chains.pause";

		/**
		 * 讀「暫停自動編號」旗標（localStorage 不可用時視為未暫停）。
		 * @returns 是否暫停
		 */
		function readPauseFlag() {
			try {
				return globalThis.localStorage?.getItem(PAUSE_KEY) === "1";
			} catch {
				return false;
			}
		}

		/**
		 * 寫「暫停自動編號」旗標。
		 * @param paused - 是否暫停
		 */
		function writePauseFlag(paused) {
			try {
				if (paused) globalThis.localStorage?.setItem(PAUSE_KEY, "1");
				else globalThis.localStorage?.removeItem(PAUSE_KEY);
			} catch {
				/* 不能寫就算了（只是記不住） */
			}
		}

		/** 卡片展開狀態的 localStorage key（展開與「哪幾條鏈被打開」都要記住）。 */
		const CARD_KEY = "dsh.session-chains.card";

		/**
		 * 讀卡片狀態：`{open, chains}`（壞值一律回預設：收合、沒有展開的鏈）。
		 * @returns `{open: boolean, chains: string[]}`
		 */
		function readCardState() {
			try {
				const raw = globalThis.localStorage?.getItem(CARD_KEY);
				const parsed = raw === null || raw === undefined ? null : JSON.parse(raw);
				return {
					open: parsed?.open === true,
					chains: Array.isArray(parsed?.chains) ? parsed.chains.filter((name) => typeof name === "string" && name !== "") : [],
				};
			} catch {
				return { open: false, chains: [] };
			}
		}

		/**
		 * 寫卡片狀態。
		 * @param {{open: boolean, chains: string[]}} state - 要記住的狀態
		 */
		function writeCardState(state) {
			try {
				globalThis.localStorage?.setItem(CARD_KEY, JSON.stringify(state));
			} catch {
				/* 記不住就算了 */
			}
		}

		// ── 進行狀態圓點（2026-10-18 使用者要求）────────────────────────────
		// 原生側欄的點點來自宿主 `uiSession.sessionStatus`：
		//   Map<sessionId, { running, pendingInteraction: { kind }, completionUnread }>
		// （`dsh-client-ui-session` 的 `sessionStatus` store；`dsh-client-ui-workspace` 的
		//   `sessionStatuses()` 也是同一份）。這裡**不重造資料**，只訂閱同一個 store，
		// 把狀態畫成小圓點：橙＝等你處理、藍＝工作中、綠＝完成未查看、紅＝失敗。
		// 為什麼不用插槽的 `useSessionStatus`：卡片是 DOM 直掛（不是插槽元件），拿不到標準 props；
		// 兩邊共用同一條 `ctx.get("uiSession").sessionStatus` 才不會有兩套行為。

		/** 狀態顏色（以主題 token 為主，取不到才用固定色）。 */
		const STATUS_COLORS = {
			error: "var(--dsw-alias-state-error-primary, #D32F2F)",
			warning: "var(--dsw-alias-state-warn-primary, #C77700)",
			ongoing: "var(--dsw-alias-state-business-primary, #2F6BFF)",
			done: "var(--dsw-alias-state-success-primary, #2E9E5B)",
		};

		/** 嚴重度（越小越優先）：失敗 > 等你處理 > 工作中 > 完成。 */
		const STATUS_RANK = { error: 0, warning: 1, ongoing: 2, done: 3 };

		/** 等你處理的三種（原生 hover 卡也是這三種寫法）。 */
		const PENDING_LABELS = { approval: "等待同意", "plan-review": "計畫待審", question: "等待回答" };

		/**
		 * 訂閱宿主的 sessionStatus store。
		 *
		 * @param source - `() => store`（`getSnapshot`／`subscribe`）；缺席就回 null
		 * @returns `Map<sessionId, status>` 或 null
		 */
		function useSessionStatuses(source) {
			const [statuses, setStatuses] = React.useState(null);
			React.useEffect(() => {
				let store = null;
				try {
					store = typeof source === "function" ? source() : null;
				} catch {
					store = null;
				}
				if (store === null || typeof store.getSnapshot !== "function" || typeof store.subscribe !== "function") return;
				const update = () => {
					try {
						setStatuses(store.getSnapshot());
					} catch {
						/* 讀不到就維持上一個畫面 */
					}
				};
				update();
				return store.subscribe(update);
			}, [source]);
			return statuses;
		}

		/**
		 * 單一場次的狀態。
		 * @param statuses - `useSessionStatuses()` 的回傳
		 * @param sessionId - 場次 id
		 * @returns `{level, label}` 或 null（閒置／沒有資料）
		 */
		function statusOf(statuses, sessionId) {
			if (statuses === null || statuses === undefined || typeof sessionId !== "string") return null;
			let status = null;
			try {
				status = typeof statuses.get === "function" ? statuses.get(sessionId) : statuses[sessionId];
			} catch {
				status = null;
			}
			if (status === null || status === undefined) return null;
			if (status.error === true || status.failed === true) return { level: "error", label: "失敗" };
			const kind = status.pendingInteraction?.kind;
			if (typeof kind === "string" && kind !== "") {
				return { level: "warning", label: PENDING_LABELS[kind] ?? "等待你處理" };
			}
			if (status.running === true) return { level: "ongoing", label: "工作中" };
			if (status.completionUnread === true) return { level: "done", label: "已完成（未查看）" };
			return null;
		}

		/**
		 * 一組場次的彙總狀態（鏈列、卡片標題用）。
		 * @param statuses - `useSessionStatuses()` 的回傳
		 * @param sessionIds - 場次 id 陣列
		 * @returns `{level, label, count}` 或 null
		 */
		function aggregateStatus(statuses, sessionIds) {
			const counts = {};
			for (const sessionId of Array.isArray(sessionIds) ? sessionIds : []) {
				const info = statusOf(statuses, sessionId);
				if (info === null) continue;
				counts[info.level] = (counts[info.level] ?? 0) + 1;
			}
			const levels = Object.keys(counts).sort((a, b) => (STATUS_RANK[a] ?? 9) - (STATUS_RANK[b] ?? 9));
			if (levels.length === 0) return null;
			const level = levels[0];
			const label =
				level === "warning" ? "有場次等你處理" : level === "ongoing" ? "有場次正在工作" : level === "done" ? "有場次完成未查看" : "有場次失敗";
			return { level, label: `${label}（${counts[level]} 場）`, count: counts[level] };
		}

		/**
		 * 一顆 8px 的狀態點；`level` 為空時只留同寬的空位（列不會因為點出現／消失而跳動）。
		 * @param {{level?: string, label?: string}} props - 狀態與 tooltip
		 * @returns 元素
		 */
		function StatusDot({ level, label }) {
			const style = { display: "inline-block", flex: "0 0 auto", height: "8px", width: "8px" };
			if (level === undefined || level === null || level === "") return h("span", { "data-status-slot": "", style });
			return h("span", {
				"data-status-dot": level,
				title: label,
				style: {
					...style,
					background: STATUS_COLORS[level] ?? "transparent",
					borderRadius: "50%",
					// 工作中多一圈光暈：不是只有顏色，弱視或色差也看得出來。
					boxShadow: level === "ongoing" ? "0 0 0 3px rgba(47,107,255,0.18)" : undefined,
				},
			});
		}

		/**
		 * 造出側邊欄卡片元件（收合＝一行；展開＝鏈清單，**點哪條鏈才展開那條鏈的場次**）。
		 *
		 * 依賴用注入的：`numbering`（套用狀態機）、`openSession`（切換對話）、`workspaceService`
		 * （認「你在這裡」）。這樣 smoke 可以把元件直接渲染起來測，不必真的開 GUI。
		 * @param {{numbering: object, openSession: Function, workspaceService: Function}} deps - 注入依賴
		 * @returns 卡片元件
		 */
		function createCard({ numbering, openSession, workspaceService, openPanel, statusSource }) {
			return function Card() {
				const [card, setCard] = React.useState(readCardState);
				const [state, setState] = React.useState(numbering.get());
				// 就地改名（2026-10-18 使用者回報「要改名只能再進去下一層，太麻煩」）：
				// 卡片上點鏈列右側的 `✎` 直接變成輸入框，Enter 送出，不必開浮層。
				const [editing, setEditing] = React.useState(null);
				// 封存是兩段式確認：第一次按只把那一列變成「確定封存？」，第二次按才真的送。
				// 不用 window.confirm —— Electron/iframe 底下不一定彈得出來，彈不出來就等於沒有確認。
				const [archiveAsk, setArchiveAsk] = React.useState("");
				const [draft, setDraft] = React.useState("");
				const [renameError, setRenameError] = React.useState("");
				// 收合時只顯示「幾條鏈／幾場」，不需要勤抓：5 分鐘。展開才 30 秒。
				const { data, reload } = useChains(true, card.open ? 30000 : 300000);
				const current = useCurrentSession(true, workspaceService);
				// 進行狀態（2026-10-18）：跟原生側欄同一份 store，卡片不做輪詢。
				const statuses = useSessionStatuses(statusSource);
				// 排序（2026-10-18）：卡片與面板共用同一份設定；任一處改，另一處立刻跟上。
				const [settings, setSettings] = React.useState(readSettings);
				React.useEffect(() => subscribeSettings(() => setSettings(readSettings())), []);
				React.useEffect(() => numbering.subscribe(() => setState(numbering.get())), [numbering]);
				React.useEffect(() => {
					if (data !== null) numbering.run(data);
				}, [data]);
				React.useEffect(() => numbering.onApplied(() => reload()), [numbering]);

				const update = (next) => {
					setCard(next);
					writeCardState(next);
				};
				/**
				 * 展開時替「工作區區塊」留一個高度下限。
				 *
				 * 使用者回報（2026-10-18）：展開卡片後，若工作區沒有收合，整塊會被卡片吃掉
				 * （regionArea 是 `flex:1; min-height:0`，卡片在 `flex:none` 的 footArea 裡長多高都行）。
				 * 這裡只掛一個屬性，實際高度由 FOLD_CSS 決定；區域找不到就什麼都不做。
				 */
				React.useEffect(() => {
					const region = globalThis.document?.querySelector?.('[class*="sidebarCol"] [class*="regionArea"]');
					if (region === null || region === undefined) return;
					try {
						if (card.open) region.setAttribute?.("data-sc-keep", "1");
						else region.removeAttribute?.("data-sc-keep");
					} catch {
						/* 掛不上就算了（等於沒有保底） */
					}
					return () => {
						try {
							region.removeAttribute?.("data-sc-keep");
						} catch {
							/* 忽略 */
						}
					};
				}, [card.open]);
				const toggleChain = (name) => {
					const chains = card.chains.includes(name) ? card.chains.filter((entry) => entry !== name) : [...card.chains, name];
					update({ open: true, chains });
				};
				/**
				 * 送出就地改名。成功後把「記住的展開狀態」也換成新名字 ——
				 * 否則改完名那一條鏈會突然收起來（記住的是舊名），使用者會以為改名把東西弄丟了。
				 * @param from - 舊鏈名
				 * @param to - 新鏈名
				 */
				const saveChainRename = async (from, to) => {
					const name = typeof to === "string" ? to.trim() : "";
					if (name === "" || name === from) {
						setEditing(null);
						return;
					}
					try {
						await requestRename(from, name);
						setRenameError("");
						setEditing(null);
						if (card.chains.includes(from)) {
							update({ open: card.open, chains: card.chains.map((entry) => (entry === from ? name : entry)) });
						}
						reload();
					} catch (error) {
						setRenameError(`改名失敗：${error?.message ?? error}`);
					}
				};

				// 封存＝卡片不顯示（資料仍在 payload，面板的封存庫看得到）。
				const archivedNames = new Set(Array.isArray(data?.archived) ? data.archived : []);
				const pinnedNames = Array.isArray(data?.pinned) ? data.pinned : [];
				const pinnedSet = new Set(pinnedNames);
				const groups = (Array.isArray(data?.chains) ? data.chains : []).filter(
					(group) => group.chain !== null && !archivedNames.has(group.chain),
				);
				const sortedGroups = sortChains(groups, settings.sortBy, settings.sortDir, pinnedNames);
				const total = groups.reduce((sum, group) => sum + (Number(group.count) || 0), 0);
				/** 整張卡片（所有已命名的鏈）的彙總狀態：收合時也看得到「哪裡在動」。 */
				const allSessionIds = groups.flatMap((group) => (Array.isArray(group.sessions) ? group.sessions.map((session) => session.id) : []));
				const cardStatus = aggregateStatus(statuses, allSessionIds);
				const rows = [];
				rows.push(
					h(
						"div",
						{ style: { display: "flex", alignItems: "center" } },
						h(
							"button",
							{
								"data-card-strip": "",
								type: "button",
								title: card.open ? "收合交接鏈" : "展開交接鏈",
								onClick: () => update({ open: !card.open, chains: card.chains }),
								// 字級調大時，文字要讓路：自己可以縮（minWidth: 0），右邊幾顆不可縮。
								style: { ...cardStripStyle, flex: "1 1 auto", minWidth: 0 },
							},
							// 收合時才在標題畫彙總點；展開後由「鏈列＋場次列」負責，
							// 否則同一件事會在鏈列／場次列之外多亮一顆（使用者回報「一個任務三個燈」）。
							StatusDot({ level: card.open ? null : cardStatus?.level, label: card.open ? null : cardStatus?.label }),
							h(
								"span",
								{ style: { flex: "1", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
								settings.showCardSummary ? `交接鏈 · ${groups.length} 條鏈 · ${total} 場` : "交接鏈",
							),
						),
						// 排序（2026-10-18 使用者指示）：移到卡片標題列、三顆圖示的左邊。
						h(
							"select",
							{
								"data-card-sort-key": settings.sortBy,
								value: settings.sortBy,
								title: "排序方式：名稱／建立時間／場次數／最後一次對話",
								onChange: (event) => setSettings(writeSettings({ sortBy: event.target.value })),
								style: {
									background: "transparent",
									border: "1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.35))",
									borderRadius: "4px",
									color: "inherit",
									flex: "0 0 auto",
									font: "inherit",
									fontSize: "10px",
									padding: "0 1px",
									width: "54px",
								},
							},
							h("option", { value: "chain" }, "名稱"),
							h("option", { value: "created" }, "建立"),
							h("option", { value: "count" }, "場次"),
							// 2026-10-18 使用者要求：用「最後一次對話時間」找最近在用的鏈。
							h("option", { value: "lastAt" }, "最後"),
						),
						h(
							"button",
							{
								"data-card-sort-dir": settings.sortDir,
								type: "button",
								title: settings.sortDir === "asc" ? "目前正排（按一下倒排）" : "目前倒排（按一下正排）",
								onClick: () => setSettings(writeSettings({ sortDir: settings.sortDir === "asc" ? "desc" : "asc" })),
								style: { ...cardStripStyle, flex: "0 0 auto", width: "auto", opacity: 0.75, fontSize: "11px", lineHeight: 1, padding: "4px 3px" },
							},
							settings.sortDir === "asc" ? "↑" : "↓",
						),
						// 折疊箭頭（2026-10-18：從標題按鈕裡獨立出來，才能排在排序右邊）。
						h(
							"button",
							{
								"data-card-fold": card.open ? "open" : "closed",
								type: "button",
								title: card.open ? "收合交接鏈" : "展開交接鏈",
								onClick: () => update({ open: !card.open, chains: card.chains }),
								style: { ...cardStripStyle, flex: "0 0 auto", width: "auto", opacity: 0.7, fontSize: settings.stripIconSize, lineHeight: 1, padding: "4px 5px" },
							},
							card.open ? "▾" : "▴",
						),
						// 暫停／恢復自動編號（按一下記住；暫停後任何來源都不改標題）。
						h(
							"button",
							{
								"data-pause-toggle": state.paused ? "paused" : "auto",
								type: "button",
								title: state.paused ? "自動編號已暫停：按一下恢復" : "暫停自動編號",
								onClick: () => numbering.togglePaused(),
								style: { ...cardStripStyle, flex: "0 0 auto", width: "auto", opacity: 0.7, fontSize: settings.stripIconSize, lineHeight: 1, padding: "4px 5px" },
							},
							state.paused ? "▶" : "⏸",
						),
						// 開啟既有浮層（改名鏈名／歸鏈／未標記／重抓都在那裡）。
						h(
							"button",
							{
								"data-card-more": "",
								type: "button",
								title: "開啟交接鏈面板（歸鏈／未標記／重抓；改名可直接按鏈列右側的 ✎）",
								onClick: () => openPanel?.(),
								style: { ...cardStripStyle, flex: "0 0 auto", width: "auto", opacity: 0.7, fontSize: settings.stripIconSize, lineHeight: 1, padding: "4px 5px" },
							},
							"⋯",
						),
					),
				);

				if (card.open) {
					for (const group of sortedGroups) {
						const expanded = card.chains.includes(group.chain);
						if (editing === group.chain) {
							// 就地改名：鏈列自己變成輸入框（不再往下開一層浮層）。
							// 輸入框在 `div` 裡，不嵌進 `button`（按鈕裡放 input 在真 DOM 會壞）。
							rows.push(
								h(
									"div",
									{
										"data-card-chain-edit": group.chain,
										onClick: (event) => event.stopPropagation(),
										style: { ...cardRowStyle, fontWeight: "bold", cursor: "default" },
									},
									h("span", { style: { width: "10px", opacity: 0.6 } }, "✎"),
									h("input", {
										"data-card-chain-input": "",
										autoFocus: true,
										defaultValue: group.chain,
										onChange: (event) => setDraft(event.target.value),
										onClick: (event) => event.stopPropagation(),
										onKeyDown: (event) => {
											if (event.key === "Enter") {
												event.stopPropagation?.();
												saveChainRename(group.chain, draft);
											}
											if (event.key === "Escape") setEditing(null);
										},
										onBlur: (event) => {
											// 點「改」／「✕」時會先 blur：那兩個按鈕在這一列裡面，
											// 不能因為 blur 就把整列收掉（否則點擊永遠落不到按鈕上）。
											const row = event?.currentTarget?.closest?.("[data-card-chain-edit]");
											const next = event?.relatedTarget;
											if (row !== undefined && row !== null && next !== undefined && next !== null && row.contains?.(next)) return;
											setEditing(null);
										},
										style: {
											background: "var(--dsw-alias-bg-base, #ffffff)",
											border: "1px solid #d9a400",
											borderRadius: "3px",
											color: "var(--dsw-alias-label-primary)",
											flex: "1",
											font: "inherit",
											fontSize: "11px",
											minWidth: "0",
											padding: "0 4px",
										},
									}),
									h(
										"button",
										{
											"data-card-chain-save": group.chain,
											type: "button",
											title: "套用新名稱（Enter）",
											onClick: (event) => {
												event.stopPropagation();
												saveChainRename(group.chain, draft);
											},
											style: { ...cardStripStyle, width: "auto", padding: "1px 5px", opacity: 0.8 },
										},
										"改",
									),
									h(
										"button",
										{
											"data-card-chain-cancel": group.chain,
											type: "button",
											title: "不改了（Esc）",
											onClick: (event) => {
												event.stopPropagation();
												setEditing(null);
											},
											style: { ...cardStripStyle, width: "auto", padding: "1px 5px", opacity: 0.6 },
										},
										"✕",
									),
								),
							);
						} else {
							rows.push(
								h(
									"button",
									{
										"data-chain-row": group.chain,
										type: "button",
										onClick: () => toggleChain(group.chain),
										style: { ...cardRowStyle, fontWeight: "bold" },
									},
									StatusDot({
										level: aggregateStatus(statuses, (Array.isArray(group.sessions) ? group.sessions : []).map((session) => session.id))?.level,
										label: aggregateStatus(statuses, (Array.isArray(group.sessions) ? group.sessions : []).map((session) => session.id))?.label,
									}),
									h("span", { style: { width: "10px", opacity: 0.6 } }, expanded ? "▾" : "▸"),
									h("span", { style: { flex: "1", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, group.chain),
									h("span", { style: { opacity: 0.6, fontSize: "10px" } }, `${group.count} 場`),
									// 置頂（2026-10-19 使用者要求：直接在側欄按，不必進面板）。
									h(
										"span",
										{
											"data-card-chain-pin": group.chain,
											title: pinnedSet.has(group.chain) ? "取消置頂" : "置頂（永遠排在卡片最上面）",
											onClick: (event) => {
												event.stopPropagation();
												requestFlag("pin", group.chain, !pinnedSet.has(group.chain))
													.then(() => reload())
													.catch(() => {});
											},
											style: {
												cursor: "pointer",
												flex: "0 0 auto",
												fontSize: "10px",
												opacity: pinnedSet.has(group.chain) ? 1 : 0.3,
												padding: "0 2px",
											},
										},
										pinnedSet.has(group.chain) ? "📌" : "📍",
									),
									// 封存（2026-10-19 使用者要求：側欄就能按，**按了先確認**）。
									// 兩段式：第一次按把這一列換成「確定封存？」＋「取消」，第二次按才真的送。
									archiveAsk === group.chain
										? h(
												"span",
												{ "data-card-chain-archive": group.chain, "data-archive-confirm": "ask", style: { alignItems: "center", display: "inline-flex", gap: "3px" } },
												h(
													"span",
													{
														"data-archive-confirm-go": group.chain,
														title: "封存：從側欄收起，不會刪掉任何對話；面板的封存庫可以還原",
														onClick: (event) => {
															event.stopPropagation();
															requestFlag("archive", group.chain, true)
																.then(() => {
																	setArchiveAsk("");
																	reload();
																})
																.catch(() => {});
														},
														style: { background: "#8a4b00", borderRadius: "3px", color: "#fff", cursor: "pointer", fontSize: "10px", padding: "0 4px", whiteSpace: "nowrap" },
													},
													"確定封存？",
												),
												h(
													"span",
													{
														onClick: (event) => {
															event.stopPropagation();
															setArchiveAsk("");
														},
														style: { color: "var(--dsw-alias-label-tertiary)", cursor: "pointer", fontSize: "10px" },
													},
													"取消",
												),
											)
										: h(
												"span",
												{
													"data-card-chain-archive": group.chain,
													title: `封存「${group.chain}」：從側欄收起，之後可在面板的封存庫還原`,
													onClick: (event) => {
														event.stopPropagation();
														setArchiveAsk(group.chain);
													},
													style: { cursor: "pointer", flex: "0 0 auto", fontSize: "10px", opacity: 0.45, padding: "0 2px" },
												},
												"🗄",
											),
									// 就地改名的入口（與面板的「點鏈標籤改名」同一個寫入路徑）。
									h(
										"span",
										{
											"data-card-chain-rename": group.chain,
											title: "改名（就地編輯，Enter 送出）",
											onClick: (event) => {
												event.stopPropagation();
												setEditing(group.chain);
												setDraft(group.chain);
												setRenameError("");
											},
											style: { cursor: "text", flex: "0 0 auto", fontSize: "10px", opacity: 0.55, padding: "0 2px" },
										},
										"✎",
									),
								),
							);
						}
						if (renameError !== "" && editing === group.chain) {
							rows.push(
								h(
									"div",
									{ "data-card-rename-error": "", style: { color: "#B3261E", fontSize: "10px", padding: "0 8px 2px 18px" } },
									renameError,
								),
							);
						}
						if (!expanded) continue;
						(group.sessions ?? []).forEach((session, index) => {
							const isCurrent = session.id === current;
							rows.push(
								h(
									"button",
									{
										"data-card-session": session.id,
										...(isCurrent ? { "data-current-row": session.id } : {}),
										type: "button",
										title: `${isCurrent ? "（你在這裡）\n" : ""}${session.id}\n${session.firstLine ?? ""}`,
										onClick: () => openSession(session.id),
										style: { ...cardRowStyle, background: isCurrent ? readSettings().highlight : "transparent", paddingLeft: "18px" },
									},
									StatusDot({ level: statusOf(statuses, session.id)?.level, label: statusOf(statuses, session.id)?.label }),
									h(
										"span",
										{ "data-card-number": "", style: { fontVariantNumeric: "tabular-nums", opacity: 0.6, width: "26px" } },
										String(index + 1).padStart(3, "0"),
									),
									h(
										"span",
										{ "data-card-title": session.title ?? "", style: { flex: "1", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
										session.title || session.firstLine || "（沒有第一句話）",
									),
									session.subagent === true ? h("span", { style: { opacity: 0.5, fontSize: "10px" } }, "子代理") : null,
									session.title
										? h("span", { style: { opacity: 0.45, fontSize: "10px", maxWidth: "40%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, previewOf(session.firstLine))
										: null,
								),
							);
						});
					}
					if (state.status === "needs-confirm" || state.failed > 0) {
						rows.push(
							h(
								"div",
								{ "data-numbering-status": state.status, style: { fontSize: "10px", opacity: 0.7, padding: "2px 8px" } },
								state.status === "needs-confirm"
									? `要重編 ${state.pending} 場 — 按這裡套用`
									: `編號失敗 ${state.failed} 場（下一輪再試）`,
								state.status === "needs-confirm"
									? h("button", { "data-confirm-numbering": String(state.pending), type: "button", onClick: () => numbering.confirm(data), style: { ...cardStripStyle, marginLeft: "6px" } }, "套用")
									: null,
							),
						);
					}
				}

				return h(
					"div",
					{
						"data-session-chains-card": "",
						// 展開狀態給 CSS 認（限高／捲動區只在展開時出現；收合時仍是一行）。
						"data-open": card.open ? "1" : "0",
						onClick: (event) => event.stopPropagation(),
						style: {
							// 字級設定（面板 ⚙）從這裡往下傳：卡片與面板共用同一個 `--sc-font`。
							"--sc-font": `${readSettings().font}px`,
							borderRadius: "10px",
							display: "flex",
							flexDirection: "column",
							margin: "2px 0 4px",
							minHeight: 0,
							overflow: "hidden",
						},
					},
					rows[0],
					// 表頭（收合列）固定在上面，只有清單捲動 —— 否則清單一長，收合鈕就捲走了。
					h("div", { "data-card-body": "", style: { display: "flex", flexDirection: "column", minHeight: 0 } }, ...rows.slice(1)),
				);
			};
		}

		/** 卡片用的樣式（窄側邊欄；用主題 token，不寫死顏色）。 */
		const cardStripStyle = {
			alignItems: "center",
			background: "transparent",
			border: "none",
			borderRadius: "8px",
			color: "var(--dsw-alias-label-secondary)",
			cursor: "pointer",
			display: "flex",
			font: "inherit",
			fontSize: "var(--sc-font, 11px)",
			gap: "4px",
			padding: "6px 8px",
			textAlign: "left",
			width: "100%",
		};

		/** 卡片裡的鏈列／場次列樣式。 */
		const cardRowStyle = {
			alignItems: "center",
			background: "transparent",
			border: "none",
			borderRadius: "6px",
			color: "var(--dsw-alias-label-primary)",
			cursor: "pointer",
			display: "flex",
			font: "inherit",
			fontSize: "var(--sc-font, 11px)",
			gap: "4px",
			padding: "4px 8px",
			textAlign: "left",
			width: "100%",
		};

		/**
		 * 把卡片掛進側邊欄底部（**放在第三方「今日消費」卡之前**）。
		 *
		 * 為什麼用 DOM 掛載而不是插槽：內建的 footer 插槽只有一列按鈕的大小，
		 * 而這張卡要能收合／展開、還要排在別人的卡片前面 —— `dsh-usage` 也是這樣做的。
		 * 任何一步找不到（版本改了、側邊欄還沒掛好）都**安全退回**：回傳 no-op disposer，
		 * 原本的「交接鏈」按鈕照常可用。
		 * @param {{document?: object, createRoot?: Function, component: Function}} options - 注入（測試用）
		 * @returns disposer
		 */
		/** 卡片挂載器的全域鍵：HMR 會重新載入模組，只有掛在 globalThis 上才活得过重載。 */
		const CARD_DISPOSE_KEY = "__sessionChainsCardDispose";

		function mountCard({ document: doc = globalThis.document, createRoot, component, reconcileMs = 2000, onPlaced } = {}) {
			if (doc === undefined || doc === null || typeof doc.createElement !== "function" || typeof createRoot !== "function") {
				return () => {};
			}
			// **防重複掛載**（2026-10-18 崩潰後補）：HMR 每次重載都會再呼叫 mountCard；
			// 沒有這段，畫面上會疊出多個 React root（各自帶著輪詢與觀察器），足以讓 GUI 卡死。
			try {
				const previous = globalThis[CARD_DISPOSE_KEY];
				if (typeof previous === "function") previous();
			} catch {
				/* 舊的收不掉就算了，下面會把孤兒容器移除 */
			}
			try {
				// 前一個實例留下的容器（收不掉時）先移除，避免 DOM 疊兩張卡。
				const orphans = doc.querySelectorAll?.("[data-session-chains-card]") ?? [];
				for (const orphan of orphans) orphan.remove?.();
			} catch {
				/* 忽略 */
			}
			const container = doc.createElement("div");
			container.setAttribute("data-session-chains-card", "");
			const root = createRoot(container);
			try {
				root.render(h(component, {}));
			} catch (error) {
				console.warn("[session-chains] 卡片渲染失敗：", error?.message ?? error);
			}
			/** 找到側邊欄底部，插在「今日消費」卡之前（沒有就插在設定列之前）。 */
			const place = () => {
				const foot = doc.querySelector?.('[class*="sidebarCol"] [class*="footArea"]') ?? doc.querySelector?.('[data-pane="sidebar"] [class*="footArea"]');
				if (foot === undefined || foot === null) {
					onPlaced?.(false);
					return false;
				}
				const anchor = foot.querySelector?.("[data-dsh-usage-foot-card]") ?? foot.querySelector?.('[class*="settingsArea"]');
				// 「已經在裡面了嗎」用 contains 判斷（被 React 移走時 nextElementSibling 可能是舊值）。
				const inside =
					typeof foot.contains === "function" ? foot.contains(container) : (foot.children?.includes?.(container) ?? false);
				if (!inside) {
					foot.insertBefore(container, anchor ?? null);
					onPlaced?.(true);
					return true;
				}
				if (anchor !== undefined && anchor !== null && container.nextElementSibling !== anchor) foot.insertBefore(container, anchor);
				onPlaced?.(true);
				return true;
			};
			const syncCollapsed = () => {
				const collapsed =
					doc.documentElement?.hasAttribute?.("data-sidebar-collapsed") === true ||
					doc.body?.hasAttribute?.("data-sidebar-collapsed") === true;
				container.style.display = collapsed ? "none" : "";
			};
			place();
			syncCollapsed();
			// **不用 MutationObserver**（2026-10-18）：掛在 document.body 的 subtree 觀察器會在
			// 串流輸出時被上千次 DOM 變動觸發，而每次都要查詢＋可能搬動節點 —— 那是卡死的高風險來源。
			// 改成每 2 秒做一次「還在不在？被移走就放回去；側邊欄收合就跟著隱藏」的便宜校正。
			const timer = setInterval(() => {
				try {
					place();
					syncCollapsed();
				} catch {
					/* 這一輪失敗，下一輪再試 */
				}
			}, Math.max(200, Number(reconcileMs) || 2000));
			const dispose = () => {
				try {
					clearInterval(timer);
				} catch {
					/* 忽略 */
				}
				try {
					root.unmount?.();
				} catch {
					/* 忽略 */
				}
				try {
					container.remove?.();
				} catch {
					/* 忽略 */
				}
				try {
					if (globalThis[CARD_DISPOSE_KEY] === dispose) delete globalThis[CARD_DISPOSE_KEY];
				} catch {
					/* 忽略 */
				}
				onPlaced?.(false);
			};
			try {
				globalThis[CARD_DISPOSE_KEY] = dispose;
			} catch {
				/* 記不住就算了 */
			}
			return dispose;
		}

		// ── 上方「工作區／會話」區塊的折疊（2026-10-18 使用者指示：**整合進原生那一列**）──
		// 內建的 `sectionHeader` 就是那一列：左邊「工作區」，右邊依序是查詢（放大鏡）、分組方式、
		// 新增工作區（資料夾）。第一版做成自己一條（「⌃ 收合工作區」）→ 看起來像外掛硬貼上去的。
		// 這一版：箭頭**放進那一列**（標題左邊），只有上下箭頭、沒有文字；折起來的是列**下方**的清單，
		// 那一列本身留著（搜尋／分組／新增工作區照樣可按）。
		/** 收合狀態的 localStorage key。 */
		const WORKSPACE_FOLD_KEY = "dsh.session-chains.workspace-fold";

		/** 樣式只注入一次；用 id 認，避免 HMR 重載疊出多份。 */
		const FOLD_STYLE_ID = "session-chains-fold-style";

		/** 折疊器的 disposer 放在 globalThis（HMR 重載才收得掉上一個）。 */
		const FOLD_DISPOSE_KEY = "__sessionChainsWorkspaceFoldDispose";

		/**
		 * 折疊用的 CSS。
		 *
		 * 為什麼用 CSS 而不是改內建節點的 style：那些節點是 React 管的，inline style 會被下一次
		 * render 蓋掉；掛屬性再由我們自己的樣式反應，React 重繪不會動到屬性。
		 * 第二個判斷要用 `[class*="sectionHeader"]` 而不是我們自己掛的標記：React 若把那一列換掉，
		 * 新節點沒有我們的標記就會被自己的規則藏起來（列不見、沒得展開）；用 class 認就免疫。
		 */
		const FOLD_CSS = [
			// 折起來：只留 sectionHeader，其餘（清單、搜尋結果）全部隱藏。
			'[data-sc-ws-body="1"] > *:not([class*="sectionHeader"]) { display: none !important; }',
			// 讓高度：regionArea 不再搶 flex，footArea（交接鏈卡片）接手。
			'[data-sc-ws-fold="1"] { flex: 0 0 auto !important; }',
			'[data-sc-ws-fold="1"] ~ [class*="footArea"] { flex: 1 1 auto !important; min-height: 0 !important; }',
			// 工作區收合時，卡片吃掉剩下的高度；**捲動交給清單，不要捲整個卡片** ——
			// 否則標題列（排序／收合／暫停／詳細）會跟著捲走（使用者回報「滑動就看不到控制項」）。
			'[data-sc-ws-fold="1"] ~ [class*="footArea"] > [data-session-chains-card] { flex: 1 1 auto; min-height: 0; overflow: hidden; display: flex; flex-direction: column; }',
			'[data-sc-ws-fold="1"] ~ [class*="footArea"] > [data-session-chains-card] > [data-session-chains-card] { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; }',
			'[data-sc-ws-fold="1"] ~ [class*="footArea"] [data-session-chains-card][data-open="1"] [data-card-body] { max-height: none; flex: 1 1 auto; min-height: 0; overflow-y: auto; }',
			// 展開卡片時：清單限高自捲，工作區保底（2026-10-18 使用者回報「工作區沒收合時整個被覆蓋」）。
			// 44vh／380px 是「還看得到工作區、卡片也夠用」的折衷；128px 大約是工作區標題列＋兩列。
			'[data-session-chains-card][data-open="1"] [data-card-body] { max-height: min(44vh, 380px); overflow-y: auto; }',
			'[class*="regionArea"][data-sc-keep="1"]:not([data-sc-ws-fold="1"]) { min-height: 128px; }',
			// 那一列裡的小箭頭：尺寸貼齊內建圖示（20px），顏色用主題 token，不寫死。
			'button[data-sc-ws-toggle] { align-items: center; background: transparent; border: 0; border-radius: 4px;',
			'  color: var(--dsw-alias-label-tertiary); cursor: pointer; display: inline-flex; flex: none; height: 20px;',
			'  justify-content: center; margin: 0 2px 0 0; padding: 0; width: 20px; }',
			'button[data-sc-ws-toggle]:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.14));',
			'  color: var(--dsw-alias-label-primary); }',
			'button[data-sc-ws-toggle] svg { transition: transform 0.12s ease; }',
			'button[data-sc-ws-toggle][data-folded="1"] svg { transform: rotate(180deg); }',
		].join("\n");

		/**
		 * 讀「工作區是否收合」（localStorage 不可用時視為展開）。
		 * @returns 是否收合
		 */
		function readWorkspaceFold() {
			try {
				return globalThis.localStorage?.getItem(WORKSPACE_FOLD_KEY) === "1";
			} catch {
				return false;
			}
		}

		/**
		 * 記住「工作區是否收合」。
		 * @param folded - 是否收合
		 */
		function writeWorkspaceFold(folded) {
			try {
				if (folded) globalThis.localStorage?.setItem(WORKSPACE_FOLD_KEY, "1");
				else globalThis.localStorage?.removeItem(WORKSPACE_FOLD_KEY);
			} catch {
				/* 記不住就算了（只是下次要重按） */
			}
		}

		/**
		 * 找側欄的「工作區區塊」（`regionArea`，內建 `sidebar.workspaces` 席位所在）。
		 *
		 * 選擇器與卡片同一個教訓：這一版**沒有 `data-pane="sidebar"`**，實測可用的是 class 子字串。
		 * @param doc - `document`
		 * @returns 元素或 null
		 */
		function findWorkspaceRegion(doc) {
			try {
				return (
					doc?.querySelector?.('[class*="sidebarCol"] [class*="regionArea"]') ??
					doc?.querySelector?.('[data-pane="sidebar"] [class*="regionArea"]') ??
					null
				);
			} catch {
				return null;
			}
		}

		/**
		 * 把「上下箭頭」掛進內建的工作區區塊標題列（**單一實例、不用 observer**）。
		 *
		 * 展開時箭頭朝上（按一下收起來）、收合時朝下（按一下展開）；沒有任何文字。
		 * 收合只藏「那一列以下」的清單，那一列（查詢／分組方式／新增工作區）照樣可用。
		 * 找不到 `regionArea` 或那一列（版本改了／側欄還沒掛好）就回 no-op，其他功能照常。
		 * @param {{document?: object, folded?: boolean, reconcileMs?: number, onFold?: Function}} [options] - 注入（測試用）
		 * @returns disposer
		 */
		function mountWorkspaceFold({ document: doc = globalThis.document, folded = readWorkspaceFold(), reconcileMs = 2000, onFold } = {}) {
			if (doc === undefined || doc === null || typeof doc.createElement !== "function" || typeof doc.querySelector !== "function") {
				return () => {};
			}
			// 單一實例：HMR 每次重載都會再呼叫一次，沒有這段就會疊出很多顆箭頭。
			try {
				const previous = globalThis[FOLD_DISPOSE_KEY];
				if (typeof previous === "function") previous();
			} catch {
				/* 舊的收不掉就算了，下面會把孤兒移除 */
			}
			try {
				for (const orphan of doc.querySelectorAll?.("[data-sc-ws-toggle]") ?? []) orphan.remove?.();
			} catch {
				/* 忽略 */
			}
			// 樣式只留一份。
			try {
				let style = doc.getElementById?.(FOLD_STYLE_ID) ?? doc.querySelector?.(`#${FOLD_STYLE_ID}`) ?? null;
				if (style === null || style === undefined) {
					style = doc.createElement("style");
					style.id = FOLD_STYLE_ID;
					style.textContent = FOLD_CSS;
					(doc.head ?? doc.documentElement)?.appendChild?.(style);
				} else {
					// HMR 熱重載時舊的 style 還在：一定要**覆寫**內容，
					// 否則新規則永遠不會生效（會留著上一版的選擇器，畫面看起來像沒改到）。
					style.textContent = FOLD_CSS;
				}
			} catch {
				/* 樣式注入失敗 → 至少不要崩（等於沒有折疊） */
			}

			let state = folded === true;
			const svgNS = "http://www.w3.org/2000/svg";

			/**
			 * 造一顆 14px 的上下箭頭（與內建圖示同一種筆畫：無填色、1.6 粗、圓端點）。
			 * 沒有 `createElementNS`（極舊環境／測試替身）就退回文字箭頭。
			 * @returns svg 或 null
			 */
			const makeChevron = () => {
				try {
					if (typeof doc.createElementNS !== "function") return null;
					const svg = doc.createElementNS(svgNS, "svg");
					svg.setAttribute("width", "14");
					svg.setAttribute("height", "14");
					svg.setAttribute("viewBox", "0 0 16 16");
					svg.setAttribute("fill", "none");
					svg.setAttribute("stroke", "currentColor");
					svg.setAttribute("stroke-width", "1.6");
					svg.setAttribute("stroke-linecap", "round");
					svg.setAttribute("stroke-linejoin", "round");
					svg.setAttribute("aria-hidden", "true");
					const path = doc.createElementNS(svgNS, "path");
					// 朝上＝目前展開（按一下收起來）；收起來時整顆旋轉 180°（CSS）。
					path.setAttribute("d", "M4 9.5 8 5.5l4 4");
					svg.appendChild(path);
					return svg;
				} catch {
					return null;
				}
			};

			const toggle = doc.createElement("button");
			toggle.setAttribute("data-sc-ws-toggle", "");
			toggle.setAttribute("type", "button");
			toggle.className = "session-chains-ws-toggle";
			const chevron = makeChevron();
			if (chevron === null) toggle.textContent = "⌃";
			else toggle.appendChild(chevron);

			/** 目前掛在哪裡（換了就要把舊的屬性清掉）。 */
			let host = null;
			let body = null;

			const paint = () => {
				toggle.setAttribute("aria-expanded", state ? "false" : "true");
				toggle.setAttribute("aria-label", state ? "展開工作區與會話清單" : "收合工作區與會話清單");
				toggle.setAttribute("title", state ? "展開工作區與會話清單" : "收合工作區與會話清單");
				toggle.setAttribute("data-folded", state ? "1" : "0");
			};

			/**
			 * 清掉所有折疊標記。
			 *
			 * 2026-10-18 修正：原本只清「記住的」host／body 兩個節點 ——
			 * 使用者回報「取消可折疊之後整個工作區消失」，那正是因為屬性留在**別的**節點上
			 * （React 換過節點、或上一輪留下來的），記住的參考清不到它，清單就永遠被藏著。
			 * 現在直接掃 DOM：只要還帶著標記的元素，一律拆掉。
			 */
			const clearHost = () => {
				try {
					for (const element of doc.querySelectorAll?.('[data-sc-ws-body], [data-sc-ws-fold]') ?? []) {
						element.removeAttribute?.("data-sc-ws-body");
						element.removeAttribute?.("data-sc-ws-fold");
					}
				} catch {
					/* 忽略 */
				}
				try {
					host?.removeAttribute?.("data-sc-ws-fold");
					body?.removeAttribute?.("data-sc-ws-body");
				} catch {
					/* 忽略 */
				}
				host = null;
				body = null;
			};

			const apply = () => {
				if (host === null || body === null) return;
				try {
					if (state) {
						host.setAttribute("data-sc-ws-fold", "1");
						body.setAttribute("data-sc-ws-body", "1");
					} else {
						host.removeAttribute?.("data-sc-ws-fold");
						body.removeAttribute?.("data-sc-ws-body");
					}
				} catch {
					/* 屬性設不上就算了 */
				}
			};

			toggle.onclick = (event) => {
				event?.stopPropagation?.();
				event?.preventDefault?.();
				state = !state;
				writeWorkspaceFold(state);
				paint();
				apply();
				onFold?.(state);
			};
			paint();

			/**
			 * 校正：箭頭還在那一列的最前面嗎？被 React 搬走就放回去；換了區塊就把舊屬性清掉。
			 * @returns 是否掛上了
			 */
			const place = () => {
				// 設定可以關掉這個功能（2026-10-18：使用者要求「工作區是否可折疊」寫進設定）。
				// 關掉時連屬性一起清掉，畫面就回到內建的樣子（不會留下收合的狀態）。
				if (readSettings().foldWorkspace === false) {
					// 關掉時要「回到內建的樣子」：清標記（掃 DOM，不只記住的節點）、移掉箭頭，
					// 並且把收合偏好重設成展開 —— 否則再打開功能時會立刻又收起來，看起來像又壞了。
					clearHost();
					if (state) {
						state = false;
						writeWorkspaceFold(false);
						paint();
					}
					try {
						toggle.remove?.();
					} catch {
						/* 忽略 */
					}
					return false;
				}
				const region = findWorkspaceRegion(doc);
				if (region === null) {
					clearHost();
					return false;
				}
				// 從那一列（sectionHeader）往上找它的父節點，而不是假設「區塊的第一個子節點就是清單」：
				// slot 可能被多個外掛佔用、區塊裡也可能有別的節點，認那一列本身最穩。
				const header = region.querySelector?.('[class*="sectionHeader"]') ?? null;
				const browser = header?.parentElement ?? header?.parent ?? null;
				if (browser === null || header === null) {
					clearHost();
					return false;
				}
				if (host !== region || body !== browser) {
					clearHost();
					host = region;
					body = browser;
				}
				// 一次只留一顆（HMR／重繪都可能留下孤兒）。
				try {
					for (const extra of header.querySelectorAll?.("[data-sc-ws-toggle]") ?? []) {
						if (extra !== toggle) extra.remove?.();
					}
				} catch {
					/* 忽略 */
				}
				const first = header.firstElementChild ?? header.children?.[0] ?? null;
				const inside = typeof header.contains === "function" ? header.contains(toggle) : (header.children?.includes?.(toggle) ?? false);
				if (!inside || first !== toggle) {
					try {
						header.insertBefore(toggle, first);
					} catch {
						try {
							header.insertBefore?.(toggle, null);
						} catch {
							/* 插不進去：下一輪再試 */
						}
					}
				}
				// 側欄收成 56px 細軌時，那一列只剩圖示 → 這顆也藏起來，免得擠爆軌道。
				try {
					const collapsed =
						doc.documentElement?.hasAttribute?.("data-sidebar-collapsed") === true ||
						doc.body?.hasAttribute?.("data-sidebar-collapsed") === true;
					toggle.style.display = collapsed ? "none" : "";
				} catch {
					/* 讀不到就照常顯示 */
				}
				apply();
				return true;
			};

			place();
			// 不用 MutationObserver：串流時每秒上千次 DOM 變動會被打爆（卡片那兩次崩潰的教訓）。
			const timer = setInterval(() => {
				try {
					place();
				} catch {
					/* 這一輪失敗，下一輪再試 */
				}
			}, Math.max(200, Number(reconcileMs) || 2000));

			const dispose = () => {
				try {
					clearInterval(timer);
				} catch {
					/* 忽略 */
				}
				clearHost();
				try {
					toggle.remove?.();
				} catch {
					/* 忽略 */
				}
				try {
					if (globalThis[FOLD_DISPOSE_KEY] === dispose) delete globalThis[FOLD_DISPOSE_KEY];
				} catch {
					/* 忽略 */
				}
				// 收合狀態**保留**：那是使用者的選擇，不是外掛的殘留。
			};
			try {
				globalThis[FOLD_DISPOSE_KEY] = dispose;
			} catch {
				/* 記不住就算了 */
			}
			return dispose;
		}

		/**
		 * 極簡 store：footer 按鈕與浮層面板是兩個獨立的插槽元件，需要共用一個開關狀態。
		 * @returns `{isOpen, setOpen, subscribe}`
		 */		function createStore() {
			let open = false;
			// 側邊欄卡片掛好之後，footer 的「交接鏈」按鈕就收起來 ——
			// 同一個入口在左側欄出現兩次（卡片 ＋ 按鈕）是 2026-10-18 使用者回報的「兩個交接鏈」。
			let cardPlaced = false;
			const listeners = new Set();
			const notify = () => {
				for (const listener of listeners) listener();
			};
			return {
				isOpen: () => open,
				setOpen(next) {
					if (open === next) return;
					open = next;
					notify();
				},
				isCardPlaced: () => cardPlaced,
				setCardPlaced(next) {
					if (cardPlaced === next) return;
					cardPlaced = next;
					notify();
				},
				subscribe(listener) {
					listeners.add(listener);
					return () => listeners.delete(listener);
				},
			};
		}

		/** 訂閱 store 的 hook。 */
		function useOpen(store) {
			const [open, setOpen] = React.useState(store.isOpen());
			React.useEffect(() => {
				const unsubscribe = store.subscribe(() => setOpen(store.isOpen()));
				setOpen(store.isOpen());
				return unsubscribe;
			}, [store]);
			return open;
		}

		/**
		 * 追蹤「目前這一場」：面板開著時，那一列要亮起來。
		 *
		 * 為什麼要訂閱＋輪詢兩套：使用者可能在面板開著時從左側欄切對話（`selection.subscribe`
		 * 會即時通知），但 `selection` 是內建實作細節、形狀可能改 —— 1 秒一次的輕量輪詢當保險
		 * （只讀一個 getter，成本可忽略）。面板關著就不追。
		 * @param open - 面板是否開著
		 * @param workspaceService - 取 uiWorkspace 服務的函式（每次重新讀，服務晚點才上線也吃得到）
		 * @returns 目前的 session id（讀不到＝null）
		 */
		function useCurrentSession(open, workspaceService) {
			const [current, setCurrent] = React.useState(null);
			React.useEffect(() => {
				if (!open) return undefined;
				const read = () => {
					let next = null;
					try {
						next = readCurrentSessionId(workspaceService());
					} catch {
						next = null;
					}
					setCurrent((previous) => (previous === next ? previous : next));
				};
				read();
				let unsubscribe;
				try {
					const subscribe = workspaceService()?.selection?.subscribe;
					if (typeof subscribe === "function") unsubscribe = subscribe(read);
				} catch {
					unsubscribe = undefined;
				}
				const timer = setInterval(read, CURRENT_POLL_MS);
				return () => {
					clearInterval(timer);
					if (typeof unsubscribe === "function") {
						try {
							unsubscribe();
						} catch {
							/* 退訂失敗不影響面板 */
						}
					}
				};
			}, [open, workspaceService]);
			return current;
		}

		/**
		 * 面板開著時抓資料（開著才輪詢；關掉就停）。
		 *
		 * 「重抓」的回饋做厚一點，理由是**第一次做太細、人眼看不到**：
		 * 抓取只要幾毫秒，`抓取中…` 在畫面重繪之前就結束；而 `更新 HH:mm` 在同一分鐘內
		 * 按幾次都是同一個字串 → 使用者判定「按鍵沒反應」（2026-10-16 使用者實測回報）。
		 * 現在：①`抓到` 顯示到**秒** ②手動抓成功後按鈕自己變成 `✓ 已更新` 1.5 秒
		 * ③`抓取中…` 至少顯示 400ms（不靠瀏覽器的重繪時機）。
		 * @param open - 面板是否開著
		 * @returns `{data, failed, loading, flash, receivedAt, reload}`
		 */
		function useChains(open, pollMs = POLL_MS) {
			const [data, setData] = React.useState(null);
			const [failed, setFailed] = React.useState(false);
			const [loading, setLoading] = React.useState(false);
			const [flash, setFlash] = React.useState(false);
			const [receivedAt, setReceivedAt] = React.useState(Number.NaN);
			const [nonce, setNonce] = React.useState(0);

			React.useEffect(() => {
				if (!open) return undefined;
				let cancelled = false;
				const timers = [];
				// nonce > 0 ⇒ 這一次是使用者按了「重抓」（不是 15 秒輪詢）。
				const manual = nonce > 0;
				const load = async () => {
					if (cancelled) return;
					// 分頁看不見就不打宿主（卡片是常駐元件，這是最容易被忽略的成本）。
					try {
						if (globalThis.document?.visibilityState === "hidden") return;
					} catch {
						/* 讀不到就照常 */
					}
					setLoading(true);
					const startedAt = Date.now();
					try {
						const response = await fetch(resolveEndpoint(), { headers: { accept: "application/json" } });
						if (!response.ok) throw new Error(`HTTP ${response.status}`);
						const payload = await response.json();
						if (!cancelled) {
							setData(payload);
							setReceivedAt(Date.now());
							setFailed(false);
							if (manual) {
								setFlash(true);
								timers.push(
									setTimeout(() => {
										if (!cancelled) setFlash(false);
									}, 1500),
								);
							}
						}
					} catch (error) {
						console.warn("[session-chains] 取不到 /local/session-chains：", error?.message ?? error);
						if (!cancelled) setFailed(true);
					} finally {
						// 讓「抓取中…」至少看得到 400ms。
						timers.push(
							setTimeout(
								() => {
									if (!cancelled) setLoading(false);
								},
								Math.max(0, 400 - (Date.now() - startedAt)),
							),
						);
					}
				};
				load();
				const timer = setInterval(load, pollMs);
				return () => {
					cancelled = true;
					clearInterval(timer);
					for (const pending of timers) clearTimeout(pending);
				};
			}, [open, nonce, pollMs]);

			return {
				data,
				failed,
				loading,
				flash,
				receivedAt,
				reload: () => setNonce((value) => value + 1),
			};
		}

		/**
		 * 掛載兩個插槽元件。
		 * @param ctx - cordis client context
		 */
		function apply(ctx) {
			/**
			 * 進行狀態的來源（2026-10-18）：宿主 `uiSession` 服務的 `sessionStatus` store。
			 * 卡片與面板共用同一個來源；取不到就回 null（圓點不出現，其餘照常）。
			 */
			const statusSource = () => {
				try {
					return ctx.get?.("uiSession")?.sessionStatus ?? null;
				} catch {
					return null;
				}
			};
			const store = createStore();

			/** 取 `uiWorkspace` 服務（缺席時回 null，面板不能因為它掛掉）。 */
			const workspaceService = () => {
				try {
					return ctx.get?.("uiWorkspace") ?? ctx.uiWorkspace ?? null;
				} catch {
					return null;
				}
			};

			/** 取 `sessions` 服務（改標題用；內建側邊欄的「重新命名」就是走它）。 */
			const sessionsService = () => {
				try {
					return ctx.get?.("sessions") ?? null;
				} catch {
					return null;
				}
			};

			/**
			 * 把編號結果回報給宿主（宿主才記得住原標題備份）。失敗只警告。
			 * @param {{applied: Array, failed: Array}} body - 套用結果
			 * @returns 宿主回的新 payload 或 undefined
			 */
			const postTitles = async (body) => {
				const response = await fetch(resolveTitlesEndpoint(), {
					method: "POST",
					headers: { "content-type": "application/json", accept: "application/json" },
					body: JSON.stringify(body),
				});
				if (!response.ok) throw new Error(`HTTP ${response.status}`);
				return response.json();
			};

			/**
			 * 自動編號的共用狀態機（浮層與卡片都可能觸發，所以只能有一份）。
			 *
			 * - `paused`：使用者按了暫停 → 任何來源都不再改標題。
			 * - 簽章：同一份計畫只跑一次（兩個 UI 同時輪詢也不會重複改名）。
			 * - `needsConfirm`：一次要改太多場時先停在 `needs-confirm`，等 `confirm()`。
			 */
			const numbering = (() => {
				let paused = readPauseFlag();
				let lastSignature = null;
				let state = { paused, status: "idle", applied: 0, failed: 0, pending: 0, at: 0 };
				const listeners = new Set();
				const setState = (patch) => {
					state = { ...state, ...patch };
					for (const listener of listeners) listener();
				};
				const signatureOf = (plan) => JSON.stringify([plan?.items ?? [], plan?.restores ?? []]);
				const run = async (payload, { force = false } = {}) => {
					const plan = payload?.numbering;
					if (plan === undefined || plan === null) return;
					const signature = signatureOf(plan);
					if (!force && signature === lastSignature) return;
					if (!force && plan.needsConfirm === true) {
						// 顯示「會被換號」的場次數（首次編號不算重編，所以不會走到這裡）。
						const pending = Number.isFinite(Number(plan.renumbered)) ? Number(plan.renumbered) : Array.isArray(plan.items) ? plan.items.length : 0;
						setState({ status: "needs-confirm", pending });
						return;
					}
					lastSignature = signature;
					setState({ status: "running" });
					const result = await applyNumberingPlan({
						plan,
						sessions: sessionRenamer(sessionsService()),
						post: postTitles,
						paused,
						force,
					});
					// 暫停／服務缺席／沒有差異：不要留下「running」卡住畫面。
					setState({
						status: result.status,
						applied: result.applied.length,
						failed: result.failed.length,
						pending: 0,
						at: Date.now(),
					});
					if (result.applied.length > 0) for (const listener of appliedListeners) listener(result);
				};
				const appliedListeners = new Set();
				return {
					get: () => state,
					subscribe(listener) {
						listeners.add(listener);
						return () => listeners.delete(listener);
					},
					onApplied(listener) {
						appliedListeners.add(listener);
						return () => appliedListeners.delete(listener);
					},
					isPaused: () => paused,
					setPaused(next) {
						paused = next === true;
						writePauseFlag(paused);
						setState({ paused });
					},
					togglePaused() {
						paused = !paused;
						writePauseFlag(paused);
						setState({ paused });
						return paused;
					},
					run,
					/** 使用者按了「套用」：用同一份計畫強制再跑一次。 */
					confirm(payload) {
						return run(payload, { force: true });
					},
				};
			})();

			/** 切換到某一場既有對話（服務缺席時只警告，不丟例外）。 */
			const openSession = (sessionId) => {
				try {
					const workspace = workspaceService();
					if (typeof workspace?.openSession !== "function") {
						console.warn("[session-chains] 找不到 uiWorkspace.openSession");
						return;
					}
					workspace.openSession(sessionId);
					store.setOpen(false);
				} catch (error) {
					console.warn("[session-chains] 開不了對話：", error?.message ?? error);
				}
			};

			/** 左側欄底部的那顆按鈕（**只有卡片掛不上時才出現**）。 */
			function FooterButton() {
				const open = useOpen(store);
				if (store.isCardPlaced()) return null;
				return h(
					"button",
					{
						"data-session-chains-toggle": "",
						type: "button",
						title: "交接鏈：把互相交接的對話聚在一起",
						onClick: () => store.setOpen(!open),
						style: {
							background: open ? "var(--dsw-alias-bg-module-platform, rgba(127,127,127,0.18))" : "transparent",
							border: "none",
							borderRadius: "6px",
							color: open ? "var(--dsw-alias-label-primary)" : "var(--dsw-alias-label-secondary)",
							cursor: "pointer",
							font: "inherit",
							fontSize: "12px",
							padding: "4px 8px",
						},
					},
					"交接鏈",
				);
			}

			/**
			 * 「交接→新對話」：讀 AI 寫好的接續提示詞，開一個新對話、把提示詞當第一個訊息送出，然後切過去。
			 *
			 * 為什麼不是一鍵全自動：提示詞只有**這一場的 AI**寫得出來（它才知道狀態與下一步）；
			 * 外掛只負責「開對話＋貼上＋送出」。所以流程是：AI 寫檔案 → 使用者按一下同意。
			 * 任何一步失敗都回報原因（不會偷偷開一個空白對話）。
			 * @returns 新對話的 id
			 */
			const startHandoffSession = async () => {
				const sessions = sessionsService();
				if (sessions === null || typeof sessions.create !== "function" || typeof sessions.using !== "function") {
					throw new Error("找不到 sessions 服務，無法開新對話");
				}
				const response = await fetch(resolveNextPromptEndpoint(), { headers: { accept: "application/json" } });
				if (!response.ok) throw new Error(`讀不到交接詞（HTTP ${response.status}）`);
				const payload = await response.json().catch(() => ({}));
				const prompt = typeof payload?.prompt === "string" ? payload.prompt.trim() : "";
				if (prompt === "") {
					throw new Error(
						"還沒有交接詞：先按「生成交接詞」讓本場 AI 寫好交接單與提示詞（.state/next-prompt.txt），寫好後再按一次「開新對話」",
					);
				}
				const workspace = workspaceService();
				const currentId = readCurrentSessionId(workspace);
				const snapshot = sessions.list?.getSnapshot?.();
				const cwd = currentId !== null ? snapshot?.byId?.[currentId]?.cwd : undefined;
				const sessionId = await sessions.create(cwd !== undefined ? { cwd } : {});
				await sessions.using(sessionId, { source: "workspaceOperation" }, async (reference) => {
					const result = await reference.binding.session.prompt([{ type: "text", text: prompt }], "queue");
					if (result?.ok !== true) throw new Error(result?.error?.message ?? "訊息送出失敗");
				});
				// 用過就清掉：避免下一次按到舊的交接詞。
				await fetch(resolveNextPromptEndpoint(), {
					method: "POST",
					headers: { "content-type": "application/json", accept: "application/json" },
					body: JSON.stringify({ clear: true }),
				}).catch(() => {});
				openSession(sessionId);
				return sessionId;
			};

			/**
			 * 把交接指令**直接送進目前這一場**（省掉複製→貼上），AI 就會開始寫交接單與提示詞。
			 * `auto: true` 是門檻自動觸發：要開設定、而且同一場只做一次（localStorage 記 id）。
			 * @param {{auto?: boolean}} [options] - 是否為自動觸發
			 * @returns 有沒有送出
			 */
			const prepareHandoff = async ({ auto = false } = {}) => {
				const sessions = sessionsService();
				if (sessions === null || typeof sessions.using !== "function") throw new Error("找不到 sessions 服務");
				const sessionId = readCurrentSessionId(workspaceService());
				if (sessionId === null) throw new Error("偵測不到目前這一場");
				if (auto === true) {
					if (readSettings().autoHandoff !== true) return false;
					try {
						if (globalThis.localStorage?.getItem(`dsh.session-chains.auto-prepared:${sessionId}`) === "1") return false;
					} catch {
						/* 記不住就照送（頂多多一輪） */
					}
				}
				await sessions.using(sessionId, { source: "workspaceOperation" }, async (reference) => {
					const result = await reference.binding.session.prompt([{ type: "text", text: handoffPrompt() }], "queue");
					if (result?.ok !== true) throw new Error(result?.error?.message ?? "訊息送出失敗");
				});
				handoffPreparedSession = sessionId;
				try {
					globalThis.localStorage?.setItem(`dsh.session-chains.auto-prepared:${sessionId}`, "1");
				} catch {
					/* 忽略 */
				}
				return true;
			};

			// 提醒橫幅（模組層元件）要用同一支「開新對話」。
			handoffStarter = startHandoffSession;
			handoffPreparer = prepareHandoff;

			/** 面板本體。 */
			function Panel() {
				const open = useOpen(store);
				const { data, failed, loading, flash, receivedAt, reload } = useChains(open);
				// 進行狀態（2026-10-18）：與左側欄卡片同一份 store。
				const statuses = useSessionStatuses(statusSource);
				// 目前這一場（亮底提示用）；hook 必須在 early return 之前呼叫。
				const currentSessionId = useCurrentSession(open, workspaceService);
				// hook 必須在 early return 之前呼叫（規則：hook 數跨 render 要一致）。
				const [showUnmarked, setShowUnmarked] = React.useState(false);
				// 封存庫：側欄卡片看不到封存的鏈，只有面板切到「封存庫」才列得出來、也才還原得回去。
				const [showArchive, setShowArchive] = React.useState(false);
				// 2026-10-18 使用者要求：面板要有搜尋、多選歸鏈、拖拉歸鏈。
				const [query, setQuery] = React.useState("");
				const [selected, setSelected] = React.useState([]);
				const [bulkChain, setBulkChain] = React.useState("");
				const [dragOver, setDragOver] = React.useState(null);
				// 正在改名的鏈（null＝沒有）與輸入中的草稿。
				const [editing, setEditing] = React.useState(null);
				const [draft, setDraft] = React.useState("");
				// 正在歸鏈的那一場（sessionId）與輸入中的鏈名。
				const [assigning, setAssigning] = React.useState(null);
				// 「交接→新對話」進行中（避免連點開出兩個對話）。
				const [starting, setStarting] = React.useState(false);
				const [assignDraft, setAssignDraft] = React.useState("");
				const [renameError, setRenameError] = React.useState("");
				// ⚙ 設定（門檻／字級／提醒顏色）。改一個欄位就立刻寫入並套用，不用按儲存。
				const [settings, setSettings] = React.useState(readSettings);
				// 卡片改了排序／顏色，面板要立刻跟上（同一份設定）。
				React.useEffect(() => subscribeSettings(() => setSettings(readSettings())), []);
				const [showSettings, setShowSettings] = React.useState(false);
				// 第一次接入的「整理舊對話」建議：**一組一組**記住（併入或略過只影響那一組）。
				// 舊版是全域的一個旗標 → 併了第一組，其他組就再也不出現（使用者實測回報的 bug）。
				const [dismissedLabels, setDismissedLabels] = React.useState(readDismissedSuggestions);
				// 「你在這裡」那一列的 ref：面板打開或換場時把它帶進視野。
				const currentRowRef = React.useRef(null);
				const hasCurrentRow =
					currentSessionId === null || !Array.isArray(data?.chains)
						? false
						: data.chains.some((chain) =>
								(Array.isArray(chain.sessions) ? chain.sessions : []).some((session) => session.id === currentSessionId),
							);
				React.useEffect(() => {
					if (!open || currentSessionId === null) return;
					// `block: "nearest"`＝已經看得到就不動；所以 15 秒輪詢重抓資料不會把畫面拉走
					// （相依只有「開關／目前哪一場／那一列在不在」，不含 data 本身）。
					try {
						currentRowRef.current?.scrollIntoView?.({ block: "nearest" });
					} catch {
						/* 捲不動不影響面板 */
					}
				}, [open, currentSessionId, hasCurrentRow]);
				// 自動編號：共用狀態（暫停／已套用／要確認）＋ 每次資料到手就嘗試套用。
				const [numberingState, setNumberingState] = React.useState(numbering.get());
				React.useEffect(() => numbering.subscribe(() => setNumberingState(numbering.get())), []);
				React.useEffect(() => {
					if (!open || data === null) return;
					numbering.run(data);
				}, [open, data]);
				// 套用成功 → 重抓（標題變了，面板與左側欄都要跟上）。
				React.useEffect(() => numbering.onApplied(() => reload()), [numbering]);
				if (!open) return null;

				/**
				 * 送出「置頂／封存」。成功後重抓：卡片與面板吃的是同一份 payload。
				 * @param chain - 鏈名
				 * @param on - true＝加上、false＝拿掉
				 * @param kind - `pin` 或 `archive`
				 */
				const saveFlag = async (chain, on, kind) => {
					try {
						await requestFlag(kind, chain, on);
						setRenameError("");
						reload();
					} catch (error) {
						setRenameError(`${kind === "pin" ? "置頂" : "封存"}失敗：${error?.message ?? error}`);
					}
				};

				/** 送出改名。成功就重抓（面板立刻顯示新名字）。 */
				const saveRename = async (from, to) => {
					try {
						await requestRename(from, to);
						setRenameError("");
						setEditing(null);
						reload();
					} catch (error) {
						setRenameError(`改名失敗：${error?.message ?? error}`);
						console.warn("[session-chains] 改名失敗：", error?.message ?? error);
					}
				};

				/** 這一條鏈用過的舊代號（改名後仍抓得到的那個），給 tooltip 用。 */
				const oldNamesOf = (chain) =>
					Object.entries(data?.aliases ?? {})
						.filter(([, to]) => to === chain.chain)
						.map(([from]) => from);

				/** 送出歸鏈。成功就重抓（那一場會立刻搬到目標鏈底下）。 */
				const saveAssign = async (sessionId, chain) => {
					try {
						const response = await fetch(resolveAssignEndpoint(), {
							method: "POST",
							headers: { "content-type": "application/json", accept: "application/json" },
							body: JSON.stringify({ sessionId, chain }),
						});
						if (!response.ok) {
							const payload = await response.json().catch(() => ({}));
							throw new Error(payload?.error ?? `HTTP ${response.status}`);
						}
						setRenameError("");
						setAssigning(null);
						reload();
					} catch (error) {
						setRenameError(`歸鏈失敗：${error?.message ?? error}`);
						console.warn("[session-chains] 歸鏈失敗：", error?.message ?? error);
					}
				};

				/**
				 * 一次把多場歸到同一條鏈。
				 *
				 * 刻意**逐場**走既有的歸鏈端點（跟手動歸鏈同一條路）：不新增批次端點，
				 * 壞掉時才知道是哪一場；空的鏈名＝取消指定、回到自動判定。
				 * @param sessionIds - 要歸鏈的場次（會去重）
				 * @param chain - 目標鏈名（空字串＝取消）
				 */
				const assignMany = async (sessionIds, chain) => {
					const name = typeof chain === "string" ? chain.trim() : "";
					const ids = [...new Set((Array.isArray(sessionIds) ? sessionIds : []).filter((id) => typeof id === "string" && id !== ""))];
					if (ids.length === 0) return;
					try {
						for (const sessionId of ids) {
							const response = await fetch(resolveAssignEndpoint(), {
								method: "POST",
								headers: { "content-type": "application/json", accept: "application/json" },
								body: JSON.stringify({ sessionId, chain: name }),
							});
							if (!response.ok) {
								const payload = await response.json().catch(() => ({}));
								throw new Error(payload?.error ?? `HTTP ${response.status}`);
							}
						}
						setRenameError("");
						setSelected([]);
						setBulkChain("");
						setAssigning(null);
						reload();
					} catch (error) {
						setRenameError(`歸鏈失敗：${error?.message ?? error}`);
						console.warn("[session-chains] 批次歸鏈失敗：", error?.message ?? error);
					}
				};

				const toggleSelect = (sessionId) =>
					setSelected((current) =>
						current.includes(sessionId) ? current.filter((id) => id !== sessionId) : [...current, sessionId],
					);

				/** 改一個設定欄位：立刻寫入 localStorage 並套用（下一次 render 就生效）。 */
				const updateSetting = (patch) => setSettings(writeSettings(patch));

				/** 只讓「這一組」消失（併入或略過都算）；其他組照常出現。 */
				const dismissSuggestion = (label) => {
					const next = [...new Set([...readDismissedSuggestions(), String(label)])];
					try {
						globalThis.localStorage?.setItem("dsh.session-chains.suggest-dismissed", JSON.stringify(next));
					} catch {
						/* 記不住就算了 */
					}
					setDismissedLabels(next);
				};

				/**
				 * 把一組建議併進一條鏈：**逐場**走既有的歸鏈端點（跟手動歸鏈同一條路）。
				 * 不新增「批次」端點的理由：同一條路才知道每一場的結果，壞掉也知道是哪一場。
				 * @param group - `{label, sessionIds}`
				 */
				const applySuggestion = async (group) => {
					try {
						for (const sessionId of group.sessionIds ?? []) {
							const response = await fetch(resolveAssignEndpoint(), {
								method: "POST",
								headers: { "content-type": "application/json", accept: "application/json" },
								body: JSON.stringify({ sessionId, chain: group.label }),
							});
							if (!response.ok) throw new Error(`HTTP ${response.status}`);
						}
						dismissSuggestion(group.label);
						reload();
					} catch (error) {
						setRenameError(`整理失敗：${error?.message ?? error}`);
					}
				};

				const allChains = Array.isArray(data?.chains) ? data.chains : [];
				const archivedSet = new Set(Array.isArray(data?.archived) ? data.archived : []);
				const pinnedNames = Array.isArray(data?.pinned) ? data.pinned : [];
				const pinnedSet = new Set(pinnedNames);
				const archivedCount = allChains.filter((chain) => chain.chain !== null && archivedSet.has(chain.chain)).length;
				const namedChains = showUnmarked ? allChains : allChains.filter((chain) => chain.chain !== null);
				// 在封存庫就只看封存的；在主清單就完全不顯示封存的。
				const baseChains = namedChains.filter((chain) =>
					showArchive ? chain.chain !== null && archivedSet.has(chain.chain) : !archivedSet.has(chain.chain),
				);
				// 搜尋（2026-10-18）：鏈名命中就整條留著；否則只留標題／第一句話／id／cwd 命中的場次。
				// 不改 `data`（重抓就回來），只做這一輪的顯示過濾。
				const normalizedQuery = query.trim().toLowerCase();
				const filteredChains =
					normalizedQuery === ""
						? baseChains
						: baseChains.flatMap((chain) => {
								const label = chain.chain ?? "未標記";
								const nameHit = label.toLowerCase().includes(normalizedQuery);
								const sessions = (Array.isArray(chain.sessions) ? chain.sessions : []).filter((session) => {
									if (nameHit) return true;
									return [session.title, session.firstLine, session.id, session.cwd].some(
										(value) => typeof value === "string" && value.toLowerCase().includes(normalizedQuery),
									);
								});
								if (sessions.length === 0) return [];
								// 命中鏈名時顯示整條（count 不變）；只命中場次時，場次數要反映目前看到的數量。
								return [{ ...chain, sessions, count: nameHit ? chain.count : sessions.length }];
							});
				// 排序在過濾之後：搜尋結果也照同一套規則。
				const chains = sortChains(filteredChains, settings.sortBy, settings.sortDir, pinnedNames);
				const unmarkedCount = allChains
					.filter((chain) => chain.chain === null)
					.reduce((sum, chain) => sum + chain.count, 0);
				// 目前這一場在資料裡的落點：`currentEntry` 可能沒有（剛開的新對話還沒落檔）。
				const currentEntry =
					currentSessionId === null
						? null
						: (allChains.flatMap((chain) => chain.sessions).find((session) => session.id === currentSessionId) ?? null);
				/** 目前這一場所屬的鏈（沒有 `chains` 欄位時退回單一 `chain`）。 */
				const currentChains = (() => {
					if (currentEntry === null) return [];
					if (Array.isArray(currentEntry.chains) && currentEntry.chains.length > 0) return currentEntry.chains;
					return typeof currentEntry.chain === "string" && currentEntry.chain !== "" ? [currentEntry.chain] : [];
				})();
				/** 目前這一場沒有任何鏈 → 落在「未標記」那一組（預設收起，所以要提示怎麼展開）。 */
				const currentIsUnmarked = currentEntry !== null && currentChains.length === 0;
				const currentLabel =
					currentSessionId === null
						? "偵測不到（內建服務讀不到目前這一場）"
						: currentEntry === null
							? `這一場（${String(currentSessionId).replace(/^session-/u, "").slice(0, 8)}…）不在清單裡`
							: currentChains.length === 0
								? "未標記（按這裡展開）"
								: currentChains.join("、");
				const rows = [];
				rows.push(
					h(
						"div",
						{
							key: "header",
							// 2026-10-18 使用者要求：面板捲動時，最上面的「交接鏈」控制項要固定。
							style: {
								alignItems: "center",
								background: "var(--dsw-alias-bg-base, #ffffff)",
								borderBottom: "1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.25))",
								display: "flex",
								flexWrap: "wrap",
								gap: "8px",
								padding: "8px 10px",
								position: "sticky",
								top: 0,
								zIndex: 2,
							},
						},
						// 面板標題**不畫點**：鏈標頭與場次列已經在同一畫面，
						// 上面再亮一顆就是同一個任務的第三個燈（使用者回報）。
						h("strong", { style: { fontSize: "13px" } }, "交接鏈"),
						// 更新狀態：重抓有沒有作用要**看得出來**（第一次做成沒有回饋，使用者以為按鍵壞了）。
						h(
							"span",
							{ style: { color: "var(--dsw-alias-label-tertiary)", flex: "1", fontSize: "11px" } },
							failed
								? "讀不到（看 console）"
								: loading
									? "抓取中…"
									: renameError !== ""
										? renameError
										: flash
											? `✓ 已更新 ${formatClock(receivedAt)}`
											: `更新 ${formatClock(receivedAt)}・${allChains.length - (unmarkedCount > 0 ? 1 : 0)} 條鏈`,
						),
						// 「你在哪裡」：整行獨占（flexBasis 100%），不必在面板與左側欄之間來回核對。
						h(
							"span",
							{
								"data-current-hint": currentSessionId ?? "",
								onClick: currentIsUnmarked ? () => setShowUnmarked(true) : undefined,
								title: currentSessionId === null ? "" : `目前這一場：${currentSessionId}`,
								style: {
									color: currentIsUnmarked || currentChains.length > 0 ? CURRENT_TEXT : "var(--dsw-alias-label-tertiary)",
									cursor: currentIsUnmarked ? "pointer" : "default",
									flexBasis: "100%",
									fontSize: "11px",
									textDecoration: currentIsUnmarked ? "underline" : "none",
								},
							},
							"▶ 你在：",
							h("strong", {}, currentLabel),
						),
						// 自動編號的結果（改了幾場／失敗幾場／要不要確認）——不靜默改東西。
						numberingState.status === "needs-confirm" || numberingState.applied > 0 || numberingState.failed > 0
							? h(
									"span",
									{
										"data-numbering-status": numberingState.status,
										style: { color: "var(--dsw-alias-label-tertiary)", flexBasis: "100%", fontSize: "11px" },
									},
									numberingState.status === "needs-confirm"
										? `編號：要重編 ${numberingState.pending} 場（按上面的「套用」）`
										: `編號：本次重編 ${numberingState.applied} 場${numberingState.failed > 0 ? `・失敗 ${numberingState.failed} 場` : ""}`,
								)
							: null,
						// 交接→新對話（2026-10-18 使用者要求）：讀 AI 寫好的接續提示詞，開新對話並送出。
						h(
							"button",
							{
								"data-sc-new-handoff": starting ? "starting" : "idle",
								type: "button",
								disabled: starting,
								title: "用 .state/next-prompt.txt 的交接詞開一個新對話（AI 寫好後按一下同意）",
								onClick: async () => {
									if (starting) return;
									setStarting(true);
									try {
										setRenameError("");
										await startHandoffSession();
									} catch (error) {
										setRenameError(`新對話失敗：${error?.message ?? error}`);
									} finally {
										setStarting(false);
									}
								},
								style: { ...buttonStyle, opacity: starting ? 0.5 : 1, borderColor: "#1565C0", color: "#1565C0" },
							},
							starting ? "開對話中…" : "交接→新對話",
						),
						h(
							"button",
							{
								type: "button",
								onClick: reload,
								disabled: loading,
								style: { ...buttonStyle, opacity: loading ? 0.5 : 1 },
							},
							loading ? "抓取中…" : flash ? "✓ 已更新" : "重抓",
						),
						// 自動編號：暫停鈕。按下去任何來源都不再改標題（記在 localStorage）。
						h(
							"button",
							{
								"data-pause-toggle": numberingState.paused ? "paused" : "auto",
								type: "button",
								title: numberingState.paused
									? "自動編號已暫停：按一下恢復（會依目前分組重新推導編號）"
									: "暫停自動編號（暫停後不會再改任何對話標題）",
								onClick: () => numbering.togglePaused(),
								style: { ...buttonStyle },
							},
							numberingState.paused ? "▶ 恢復編號" : "⏸ 暫停編號",
						),
						// 一次要改太多場 → 先等使用者按確認（不靜默大量改名）。
						numberingState.status === "needs-confirm"
							? h(
									"button",
									{
										"data-confirm-numbering": String(numberingState.pending),
										type: "button",
										title: "按下才會把這些場次的標題改成編號",
										onClick: () => numbering.confirm(data),
										style: { ...buttonStyle, borderColor: "#d9a400", color: "#8a4b00" },
									},
									`套用 ${numberingState.pending} 場`,
								)
							: null,
						unmarkedCount > 0
							? h(
									"button",
									{ type: "button", onClick: () => setShowUnmarked((value) => !value), style: buttonStyle },
									showUnmarked ? "收起未標記" : `未標記 ${unmarkedCount}`,
								)
							: null,
						archivedCount > 0 || showArchive
							? h(
										"button",
										{
											"data-sc-archive-toggle": showArchive ? "open" : "closed",
											type: "button",
											title: showArchive ? "回到正常鏈清單" : "封存的鏈只在這裡看得到，也在這裡還原",
											onClick: () => setShowArchive((value) => !value),
											style: showArchive ? { ...buttonStyle, borderColor: "#8a4b00", color: "#8a4b00" } : buttonStyle,
										},
										showArchive ? "← 回鏈清單" : `封存庫 ${archivedCount}`,
									)
							: null,
						h(
							"button",
							{ "data-sc-settings-toggle": showSettings ? "open" : "closed", type: "button", onClick: () => setShowSettings((value) => !value), style: buttonStyle },
							showSettings ? "收起設定" : "⚙ 設定",
						),
						h("button", { type: "button", onClick: () => store.setOpen(false), style: buttonStyle }, "關閉"),
					),
				);

				// ── 搜尋（2026-10-18 使用者要求）──
				rows.push(
					h(
						"div",
						{ key: "search", "data-sc-search-row": "", style: { alignItems: "center", display: "flex", gap: "6px", padding: "6px 10px" } },
						h("span", { style: { color: "var(--dsw-alias-label-tertiary)", fontSize: "11px" } }, "🔍"),
						h("input", {
							"data-sc-search": "",
							type: "search",
							value: query,
							placeholder: "搜尋：鏈名／標題／第一句話／session id",
							onChange: (event) => setQuery(event.target.value),
							style: {
								background: "var(--dsw-alias-bg-base, #ffffff)",
								border: "1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.35))",
								borderRadius: "4px",
								color: "var(--dsw-alias-label-primary)",
								flex: "1",
								font: "inherit",
								fontSize: "11px",
								minWidth: "0",
								padding: "3px 6px",
							},
						}),
						normalizedQuery === ""
							? h("span", { "data-sc-search-count": "", style: { color: "var(--dsw-alias-label-tertiary)", fontSize: "10px" } }, `${chains.length} 條`)
							: h(
									"span",
									{ "data-sc-search-count": "", style: { color: "var(--dsw-alias-label-tertiary)", fontSize: "10px", whiteSpace: "nowrap" } },
									`${chains.length} 條・${chains.reduce((sum, chain) => sum + (Array.isArray(chain.sessions) ? chain.sessions.length : 0), 0)} 場`,
								),
						query !== ""
							? h("button", { "data-sc-search-clear": "", type: "button", onClick: () => setQuery(""), style: buttonStyle }, "✕")
							: null,
					),
				);

				// ── 多選歸鏈（2026-10-18 使用者要求）──
				if (selected.length > 0) {
					rows.push(
						h(
							"div",
							{
								key: "bulk",
								"data-sc-bulk": "",
								style: {
									alignItems: "center",
									background: "var(--dsw-alias-bg-module-platform, rgba(127,127,127,0.10))",
									borderTop: "1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.18))",
									borderBottom: "1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.18))",
									display: "flex",
									flexWrap: "wrap",
									gap: "6px",
									padding: "6px 10px",
								},
							},
							h("strong", { "data-sc-bulk-count": String(selected.length), style: { fontSize: "11px" } }, `已選 ${selected.length} 場`),
							h("input", {
								"data-sc-bulk-chain": "",
								list: "sc-chain-options",
								value: bulkChain,
								placeholder: "鏈名（留白＝取消歸鏈）",
								onChange: (event) => setBulkChain(event.target.value),
								onKeyDown: (event) => {
									if (event.key === "Enter") assignMany(selected, bulkChain);
									if (event.key === "Escape") setSelected([]);
								},
								style: {
									background: "var(--dsw-alias-bg-base, #ffffff)",
									border: "1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.35))",
									borderRadius: "4px",
									color: "var(--dsw-alias-label-primary)",
									flex: "1 1 140px",
									font: "inherit",
									fontSize: "11px",
									minWidth: "0",
									padding: "2px 6px",
								},
							}),
							h("datalist", { id: "sc-chain-options" }, ...allChains.filter((chain) => typeof chain.chain === "string").map((chain) => h("option", { value: chain.chain }))),
							h("button", { "data-sc-bulk-apply": "", type: "button", onClick: () => assignMany(selected, bulkChain), style: buttonStyle }, "歸鏈"),
							h("button", { "data-sc-bulk-clear": "", type: "button", onClick: () => setSelected([]), style: buttonStyle }, "取消選取"),
						),
					);
				}

				// ── ⚙ 設定（要能打包出去，門檻／字級／顏色就必須讓人自己調）──────
				if (showSettings) {
					const inputStyle = {
						background: "var(--dsw-alias-bg-base, #ffffff)",
						border: "1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.35))",
						borderRadius: "4px",
						color: "var(--dsw-alias-label-primary)",
						font: "inherit",
						fontSize: "11px",
						padding: "1px 4px",
					};
					const field = (label, node) =>
						h(
							"label",
							{ style: { alignItems: "center", display: "flex", fontSize: "11px", gap: "6px" } },
							h("span", { style: { opacity: 0.7, width: "78px" } }, label),
							node,
						);
					// 上下文用「k」顯示（160000 → 160），避免一排零看得眼花。
					/** 一個色票（label 給 aria／tooltip，讓同一行的兩個色票分得出來）。 */
					const colorField = (key, title) =>
						h("input", {
							"data-sc-setting": key,
							type: "color",
							title,
							"aria-label": title,
							value: settings[key],
							onChange: (event) => updateSetting({ [key]: event.target.value }),
							style: { background: "transparent", border: "none", height: "22px", padding: 0, width: "32px" },
						});
					const toggleField = (key, label) =>
						h(
							"label",
							{ style: { alignItems: "center", cursor: "pointer", display: "flex", fontSize: "11px", gap: "6px" } },
							h("input", {
								"data-sc-setting": key,
								type: "checkbox",
								checked: settings[key] !== false,
								onChange: (event) => updateSetting({ [key]: event.target.checked }),
								style: { margin: 0 },
							}),
							h("span", { style: { opacity: 0.85 } }, label),
						);
					const tokenField = (key) =>
						h("input", {
							"data-sc-setting": key,
							type: "number",
							min: 10,
							step: 10,
							value: Math.round((Number(settings[key]) || 0) / 1000),
							onChange: (event) => updateSetting({ [key]: Math.max(10, Number(event.target.value) || 0) * 1000 }),
							style: { ...inputStyle, width: "76px" },
						});
					const stepField = (key) =>
						h("input", {
							"data-sc-setting": key,
							type: "number",
							min: 1,
							step: 10,
							value: Number(settings[key]) || 0,
							onChange: (event) => updateSetting({ [key]: Math.max(1, Number(event.target.value) || 0) }),
							style: { ...inputStyle, width: "76px" },
						});
					rows.push(
						h(
							"div",
							{
								key: "settings",
								"data-sc-settings": "",
								onClick: (event) => event.stopPropagation(),
								style: {
									borderTop: "1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.18))",
									display: "flex",
									flexDirection: "column",
									gap: "6px",
									padding: "8px 10px",
								},
							},
							h("strong", { style: { fontSize: "11px" } }, "設定（存在這台電腦，換外掛版本也還在）"),
							field(
								"字體大小",
								h(
									"select",
									{
										"data-sc-setting": "font",
										value: String(settings.font),
										onChange: (event) => updateSetting({ font: Number(event.target.value) }),
										style: { ...inputStyle, width: "86px" },
									},
									...[10, 11, 12, 13, 14, 15, 16].map((size) => h("option", { key: size, value: String(size) }, `${size}px`)),
								),
							),
							field(
								"卡片圖示",
								h(
									"select",
									{
										"data-sc-setting": "stripIconSize",
										value: String(settings.stripIconSize),
										onChange: (event) => updateSetting({ stripIconSize: Number(event.target.value) }),
										style: { ...inputStyle, width: "86px" },
									},
									...[10, 12, 14, 15, 16, 18, 20, 22, 24].map((size) => h("option", { key: size, value: String(size) }, `${size}px`)),
								),
							),
							// 顏色（2026-10-18 使用者指示）：四處各自可調，都寫進同一份設定。
							field(
								"提醒顏色",
								h("input", {
									"data-sc-setting": "accent",
									type: "color",
									value: settings.accent,
									onChange: (event) => updateSetting({ accent: event.target.value }),
									style: { background: "transparent", border: "none", height: "22px", padding: 0, width: "36px" },
								}),
							),
							// 「HUD 顏色」＝文字＋背景兩個色票**放在同一行**（2026-10-18 使用者：分開放很難找）。
							field(
								"HUD 顏色",
								h(
									"span",
									{ style: { alignItems: "center", display: "flex", gap: "6px" } },
									h("span", { style: { fontSize: "10px", opacity: 0.6 } }, "文字"),
									colorField("sessionColor", "本場文字的顏色"),
									h("span", { style: { fontSize: "10px", opacity: 0.6 } }, "背景"),
									colorField("hudBg", "本場警示的底色（達門檻才出現）"),
								),
							),
							field(
								"你在這裡",
								h("input", {
									"data-sc-setting": "highlight",
									type: "color",
									value: settings.highlight,
									onChange: (event) => updateSetting({ highlight: event.target.value }),
									style: { background: "transparent", border: "none", height: "22px", padding: 0, width: "36px" },
								}),
							),
							field(
								"鏈標籤",
								h("input", {
									"data-sc-setting": "badge",
									type: "color",
									value: settings.badge,
									onChange: (event) => updateSetting({ badge: event.target.value }),
									style: { background: "transparent", border: "none", height: "22px", padding: 0, width: "36px" },
								}),
							),
							field(
								"請求門檻",
								h(
									"span",
									{ style: { alignItems: "center", display: "flex", gap: "4px" } },
									h("span", { style: { opacity: 0.6 } }, "提醒"),
									stepField("warnSteps"),
									h("span", { style: { opacity: 0.6 } }, "強制"),
									stepField("hardSteps"),
								),
							),
							field(
								"上下文門檻",
								h(
									"span",
									{ style: { alignItems: "center", display: "flex", gap: "4px" } },
									h("span", { style: { opacity: 0.6 } }, "提醒"),
									tokenField("warnTokens"),
									h("span", { style: { opacity: 0.6 } }, "k 強制"),
									tokenField("hardTokens"),
									h("span", { style: { opacity: 0.6 } }, "k"),
								),
							),
							// 勾選項（2026-10-18）：工作區能不能收合、HUD 要顯示哪幾段。
							h(
								"span",
								{ style: { fontSize: "10px", opacity: 0.6, marginTop: "2px" } },
								"勾選",
							),
							toggleField("autoHandoff", "到達門檻自動交接：生成交接詞 → 開新對話並切過去（對話結束後）"),
							toggleField("showCardSummary", "卡片標題顯示「N 條鏈・M 場」"),
							toggleField("foldWorkspace", "工作區可以收合（標題列那顆上下箭頭）"),
							toggleField("showBalance", "HUD：餘額"),
							toggleField("showToday", "HUD：今日"),
							toggleField("showWeek", "HUD：本週"),
							toggleField("showMonth", "HUD：本月"),
							toggleField("showSession", "HUD：本場（上下文／請求）"),
							h(
								"div",
								{ style: { display: "flex", gap: "6px" } },
								h("button", { "data-sc-settings-reset": "", type: "button", onClick: () => setSettings(writeSettings(DEFAULT_SETTINGS)), style: buttonStyle }, "恢復預設"),
							),
							h(
								"span",
								{ style: { fontSize: "10px", opacity: 0.6 } },
								"HUD 已併入這個外掛（原 dsh-token-hud）：勾選立刻生效，不必重開。",
							),
						),
					);
				}

				// ── 第一次接入：把之前的對話整理進交接鏈（只建議，按了才寫）──────
				const suggestions = Array.isArray(data?.suggestions)
					? data.suggestions.filter((group) => !dismissedLabels.includes(String(group?.label ?? "")))
					: [];
				if (suggestions.length > 0) {
					rows.push(
						h(
							"div",
							{
								key: "suggest",
								"data-sc-suggest": "",
								style: {
									borderTop: "1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.18))",
									display: "flex",
									flexDirection: "column",
									gap: "5px",
									padding: "8px 10px",
								},
							},
							h("strong", { style: { fontSize: "11px" } }, "建議整理：這些舊對話看起來是同一件事"),
							h(
								"span",
								{ style: { fontSize: "10px", opacity: 0.6 } },
								"按「併入」才會寫入；不想就按「略過」。之後仍可逐場用「歸鏈」，也可以再改。",
							),
							...suggestions.map((group) =>
								h(
									"div",
									{
										key: `suggest:${group.label}`,
										"data-sc-suggest-group": group.label,
										style: { alignItems: "center", display: "flex", flexWrap: "wrap", fontSize: "11px", gap: "6px" },
									},
									h(
										"span",
										{ style: { background: "#E3F2FD", borderRadius: "3px", color: "#1565C0", padding: "0 4px" } },
										group.label,
									),
									h("span", { style: { opacity: 0.7 } }, `${group.size} 場`),
									group.sample
										? h(
												"span",
												{ "data-sc-suggest-sample": group.label, style: { color: "var(--dsw-alias-label-tertiary)", flexBasis: "100%", fontSize: "10px", opacity: 0.75 } },
												`例：${group.sample}`,
											)
										: null,
									h(
										"button",
										{ "data-sc-suggest-apply": group.label, type: "button", onClick: () => applySuggestion(group), style: buttonStyle },
										"併入",
									),
									h(
										"button",
										{ "data-sc-suggest-skip": group.label, type: "button", onClick: () => dismissSuggestion(group.label), style: buttonStyle },
										"略過",
									),
								),
							),
						),
					);
				}

				if (chains.length === 0) {
					rows.push(
						h(
							"div",
							{ key: "empty", style: { color: "var(--dsw-alias-label-tertiary)", fontSize: "12px", padding: "10px" } },
							failed
								? "路由讀不到（看 console）"
								: unmarkedCount > 0
									? `目前沒有已標記的鏈；另有 ${unmarkedCount} 場未標記（按上面的按鈕看）`
									: "還沒有資料",
						),
					);
				}

				for (const chain of chains) {
					const unmarked = chain.chain === null;
					rows.push(
						h(
							"div",
							{
								key: `chain:${chain.chain ?? "unmarked"}`,
								// 給測試與除錯認：拖到哪一條鏈。
								"data-chain-drop": chain.chain ?? "unmarked",
								// 拖拉歸鏈（2026-10-18）：把場次列拖到鏈標頭就歸到這條鏈（未標記不接受）。
								onDragOver: unmarked
									? undefined
									: (event) => {
											event.preventDefault();
											try {
												event.dataTransfer.dropEffect = "move";
											} catch {
												/* 沒有 dataTransfer 就算了 */
											}
											setDragOver(chain.chain);
										},
								onDragLeave: unmarked ? undefined : () => setDragOver((current) => (current === chain.chain ? null : current)),
								onDrop: unmarked
									? undefined
									: (event) => {
											event.preventDefault();
											event.stopPropagation?.();
											setDragOver(null);
											let ids = [];
											try {
												ids = JSON.parse(event?.dataTransfer?.getData?.("text/plain") ?? "[]");
											} catch {
												ids = [];
											}
											if (!Array.isArray(ids) || ids.length === 0) return;
											assignMany(ids.map(String), chain.chain);
										},
								style: {
									background: dragOver === chain.chain ? "var(--dsw-alias-bg-module-platform, rgba(127,127,127,0.16))" : "transparent",
									borderRadius: dragOver === chain.chain ? "4px" : undefined,
									borderTop: "1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.18))",
									outline: dragOver === chain.chain ? "1px dashed #1565C0" : undefined,
									padding: "6px 10px 2px",
								},
							},
							h(
								"div",
								{ style: { alignItems: "center", display: "flex", gap: "6px" } },
								StatusDot({
									level: aggregateStatus(statuses, (Array.isArray(chain.sessions) ? chain.sessions : []).map((session) => session.id))?.level,
									label: aggregateStatus(statuses, (Array.isArray(chain.sessions) ? chain.sessions : []).map((session) => session.id))?.label,
								}),
								unmarked || editing !== chain.chain
									? h(
											"span",
											{
												"data-chain-label": chain.chain ?? "unmarked",
												// 點一下改名（未標記那一組不能改 —— 它不是一條鏈）。
												onClick: unmarked
													? undefined
													: (event) => {
															event.stopPropagation();
															setEditing(chain.chain);
															setDraft(chain.chain);
															setRenameError("");
														},
												title: unmarked
													? undefined
													: `點一下改名${oldNamesOf(chain).length > 0 ? `（舊代號：${oldNamesOf(chain).join("、")}，仍然抓得到）` : ""}`,
												style: {
													alignItems: "center",
													cursor: unmarked ? "default" : "text",
													display: "inline-flex",
													gap: "3px",
												},
											},
											h(
												"span",
												{
													style: {
														background: unmarked ? "transparent" : settings.badge,
														borderRadius: "3px",
														color: unmarked ? "var(--dsw-alias-label-tertiary)" : "#8a4b00",
														fontSize: "var(--sc-font, 11px)",
														fontWeight: "bold",
														padding: unmarked ? "0" : "0 5px",
													},
												},
												unmarked ? "未標記" : chain.chain,
											),
											unmarked ? null : h("span", { style: { color: "#8a4b00", fontSize: "10px" } }, "✎"),
										unmarked
											? null
											: h(
													"button",
													{
														"data-chain-pin": chain.chain,
														type: "button",
														title: pinnedSet.has(chain.chain) ? "取消置頂" : "置頂（永遠排在清單最前面）",
														onClick: (event) => {
															event.stopPropagation();
															saveFlag(chain.chain, !pinnedSet.has(chain.chain), "pin");
														},
														style: { ...buttonStyle, fontSize: "10px", padding: "0 3px" },
													},
													pinnedSet.has(chain.chain) ? "📌" : "📍",
												),
										unmarked
											? null
											: h(
													"button",
													{
														"data-chain-archive": chain.chain,
														type: "button",
														title: showArchive ? "從封存庫還原" : "封存（從卡片收起，面板封存庫還原得回來）",
														onClick: (event) => {
															event.stopPropagation();
															saveFlag(chain.chain, !showArchive, "archive");
														},
														style: { ...buttonStyle, fontSize: "10px", padding: "0 3px" },
													},
													showArchive ? "還原" : "🗄",
												),
										)
									: h("input", {
											"data-chain-input": "",
											autoFocus: true,
											defaultValue: chain.chain,
											onChange: (event) => setDraft(event.target.value),
											onClick: (event) => event.stopPropagation(),
											onKeyDown: (event) => {
												if (event.key === "Enter") saveRename(chain.chain, draft);
												if (event.key === "Escape") setEditing(null);
											},
											onBlur: () => setEditing(null),
											style: {
												background: "var(--dsw-alias-bg-base, #ffffff)",
												border: "1px solid #d9a400",
												borderRadius: "3px",
												color: "var(--dsw-alias-label-primary)",
												font: "inherit",
												fontSize: "11px",
												padding: "0 4px",
												width: "150px",
											},
										}),
								h(
									"span",
									{ style: { color: "var(--dsw-alias-label-tertiary)", fontSize: "11px" } },
									`${chain.count} 場・${formatTime(chain.firstAt)} → ${formatTime(chain.lastAt)}`,
								),
								// 目前這一場就在這一組 ⇒ 組頭直接說出來（清單長的時候，不用自己找）。
								currentEntry !== null &&
								(unmarked ? currentIsUnmarked : currentChains.includes(chain.chain))
									? h(
											"span",
											{
												"data-current-group": chain.chain ?? "unmarked",
												title: "目前這一場就在這一組",
												style: {
													background: settings.highlight,
													borderRadius: "3px",
													color: CURRENT_TEXT,
													fontSize: "10px",
													fontWeight: "bold",
													padding: "0 4px",
												},
											},
											unmarked ? "你在這一組" : "你在這條鏈",
										)
									: null,
							),
							...chain.sessions.map((session) => {
								// 目前這一場 ⇒ 亮色底色 ＋ 左側色條 ＋「你在這裡」。
								// 底色要在 hover 之後**還原回亮色**（不然滑過去一次提示就沒了）。
								const isCurrent = session.id === currentSessionId;
								const restingBg = isCurrent ? settings.highlight : "transparent";
								// 這一場自動判定屬於哪幾條鏈。中繼場（接手 A、又開出 B）會有兩條 ——
								// 面板會**兩組都列出同一場**，所以要說清楚「它也在哪裡」，並給一鍵收斂。
								const memberships =
									Array.isArray(session.chains) && session.chains.length > 0
										? session.chains
										: session.chain === null || session.chain === undefined
											? []
											: [session.chain];
								const alsoIn = memberships.filter((name) => name !== chain.chain);
								const multiChain = memberships.length > 1;
								return h(
									"div",
									{
										key: session.id,
										"data-session-row": session.id,
										draggable: true,
										onDragStart: (event) => {
											// 拖的那一列有被勾選 → 整批一起拖；沒有 → 只拖這一列。
											const ids = selected.includes(session.id) ? selected : [session.id];
											try {
												event.dataTransfer.setData("text/plain", JSON.stringify(ids));
												event.dataTransfer.effectAllowed = "move";
											} catch {
												/* 沒有 dataTransfer 就算了（拖不動不影響點擊） */
											}
										},
										onDragEnd: () => setDragOver(null),
										...(isCurrent ? { "data-current-row": session.id } : {}),
										// 只有目前那一列掛 ref（開面板／換場時要把它帶進視野）。
										...(isCurrent ? { ref: currentRowRef } : {}),
										onClick: () => openSession(session.id),
										title: `${isCurrent ? "（你在這裡）\n" : ""}${session.id}\n${session.cwd ?? ""}\n${session.firstLine}`,
										style: {
											background: restingBg,
											borderLeft: `3px solid ${isCurrent ? settings.highlight : "transparent"}`,
											borderRadius: "4px",
											cursor: "pointer",
											display: "flex",
											gap: "6px",
											padding: "3px 4px",
										},
										onMouseEnter: (event) => {
											event.currentTarget.style.background = "var(--dsw-alias-bg-module-platform, rgba(127,127,127,0.16))";
										},
										onMouseLeave: (event) => {
											event.currentTarget.style.background = restingBg;
										},
									},
									// 多選（2026-10-18）：勾起來後可一次歸鏈；點勾選框不要順便打開這一場。
									h("input", {
										"data-sc-select": session.id,
										type: "checkbox",
										checked: selected.includes(session.id),
										title: "選取這一場（可多選後一次歸鏈，或拖到鏈標頭）",
										onClick: (event) => event.stopPropagation(),
										onChange: () => toggleSelect(session.id),
										style: { flex: "0 0 auto", margin: 0 },
									}),
									StatusDot({ level: statusOf(statuses, session.id)?.level, label: statusOf(statuses, session.id)?.label }),
									h(
										"span",
										{ style: { color: "var(--dsw-alias-label-tertiary)", flex: "0 0 74px", fontSize: "11px" } },
										formatTime(session.startedAt),
									),
									// 目前這一場：整列亮底之外再加一個字標，色弱或列很短時也看得出來。
									isCurrent
										? h(
												"span",
												{
													style: {
														background: settings.highlight,
														borderRadius: "3px",
														color: "#ffffff",
														flex: "0 0 auto",
														fontSize: "10px",
														fontWeight: "bold",
														padding: "0 4px",
													},
												},
												"你在這裡",
											)
										: null,
									// 子代理（subagent）不是使用者會打開的對話 → 不編號，標一下避免誤會。
									session.subagent === true
										? h(
												"span",
												{
													title: "子代理對話（不是你的對話）→ 不編號、不改名",
													style: { background: "#ECEFF1", borderRadius: "3px", color: "#546E7A", flex: "0 0 auto", fontSize: "10px", padding: "0 4px" },
												},
												"子代理",
											)
										: null,
									// 這一場自己產出了本鏈的接續提示詞 ⇒ 它是這條鏈的起點。
									// 沒有這個標記，中繼場（同時屬於兩條鏈）在畫面上會被當成重複的一列。
									session.handoffTo === chain.chain
										? h(
												"span",
												{
													title: "這一場產出了本鏈的接續提示詞（鏈的起點）",
													style: {
														background: settings.badge,
														borderRadius: "3px",
														color: "#8a4b00",
														flex: "0 0 auto",
														fontSize: "10px",
														padding: "0 4px",
													},
												},
												"起點",
											)
										: null,
									h(
										"span",
										{
											"data-session-title": session.title ?? "",
											style: {
												flex: "1",
												fontSize: "var(--sc-font, 12px)",
												overflow: "hidden",
												textOverflow: "ellipsis",
												whiteSpace: "nowrap",
											},
										},
										session.title || session.firstLine || "（沒有第一句話）",
									),
									// 改名之後，第一句話是唯一還認得出內容的線索 → 灰字留在右邊。
									session.title
										? h(
												"span",
												{ style: { color: "var(--dsw-alias-label-tertiary)", flex: "0 1 auto", fontSize: "10px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
												previewOf(session.firstLine),
											)
										: null,
									// 手動歸鏈（未標記那批舊對話的入口）：點「歸鏈」→ 就地打鏈名 → Enter。
									session.assignedChain !== undefined
										? h(
												"span",
												{
													title: `手動歸鏈（自動判定：${session.chainRaw ?? "未標記"}）`,
													style: {
														background: "#E3F2FD",
														borderRadius: "3px",
														color: "#1565C0",
														flex: "0 0 auto",
														fontSize: "10px",
														padding: "0 4px",
													},
												},
												"手動",
											)
										: null,
									// 同時屬於多條鏈（中繼場）：說出「也在哪裡」＋ 一鍵只留在本條。
									multiChain
										? h(
												"span",
												{
													"data-multi-chain": session.id,
													title: `自動判定這一場同時屬於 ${memberships.length} 條鏈：${memberships.join("、")}\n（中繼場：接手一條、又開出另一條，所以兩組都會列出它）`,
													style: {
														background: "#FFE0B2",
														borderRadius: "3px",
														color: "#8a4b00",
														flex: "0 0 auto",
														fontSize: "10px",
														padding: "0 4px",
													},
												},
												alsoIn.length === 1 ? `也在 ${alsoIn[0]}` : `同時在 ${memberships.length} 條鏈`,
											)
										: null,
									// 「只留在這條」：把這一場**限定到本組這一條鏈**（＝退出其他鏈）。
									// 這就是「它同時在兩條鏈、我想決定放哪裡」的一鍵答案。
									multiChain && !unmarked
										? h(
												"span",
												{
													"data-pin-button": session.id,
													"data-pin-chain": chain.chain,
													title: `只留在「${chain.chain}」：取消其他 ${alsoIn.length} 條鏈的歸屬（不改 session log；再用「歸鏈」留白可還原成自動判定）`,
													onClick: (event) => {
														event.stopPropagation();
														saveAssign(session.id, chain.chain);
													},
													style: {
														color: "#8a4b00",
														cursor: "pointer",
														flex: "0 0 auto",
														fontSize: "10px",
														padding: "0 2px",
														textDecoration: "underline",
													},
												},
												"只留在這條",
											)
										: null,
									assigning === session.id
										? h("input", {
												"data-assign-input": "",
												autoFocus: true,
												// 預填**本組這一條鏈**：直接 Enter＝「只留在這條」；
												// 留白＝取消指定（回到自動判定）。
												defaultValue: chain.chain ?? session.chain ?? "",
												placeholder: "鏈名（留白＝取消）",
												onChange: (event) => setAssignDraft(event.target.value),
												onClick: (event) => event.stopPropagation(),
												onKeyDown: (event) => {
													if (event.key === "Enter") saveAssign(session.id, assignDraft);
													if (event.key === "Escape") setAssigning(null);
												},
												onBlur: () => setAssigning(null),
												style: {
													background: "var(--dsw-alias-bg-base, #ffffff)",
													border: "1px solid #1565C0",
													borderRadius: "3px",
													color: "var(--dsw-alias-label-primary)",
													flex: "0 0 auto",
													font: "inherit",
													fontSize: "11px",
													padding: "0 4px",
													width: "130px",
												},
											})
										: h(
												"span",
												{
													"data-assign-button": session.id,
													"data-assign-group": chain.chain ?? "unmarked",
													title: "把這一場指定到某條鏈（打既有名字＝併進去；打新名字＝新開一條；留白＝取消）",
													onClick: (event) => {
														event.stopPropagation();
														setAssigning(session.id);
														setAssignDraft(session.chain ?? "");
														setRenameError("");
													},
													style: {
														color: "var(--dsw-alias-label-tertiary)",
														cursor: "text",
														flex: "0 0 auto",
														fontSize: "10px",
														padding: "0 2px",
													},
												},
												"歸鏈",
											),
									);
							}),
						),
					);
				}

				return h(
					"div",
					{
						"data-session-chains-panel": "",
						// 浮層是全框的：點擊不要冒泡出去（避免被 shell 的「點外面」處理吃掉）。
						onClick: (event) => event.stopPropagation(),
						style: {
							"--sc-font": `${readSettings().font}px`,
							background: "var(--dsw-alias-bg-base, #ffffff)",
							border: "1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.35))",
							borderRadius: "10px",
							bottom: "56px",
							boxShadow: "0 8px 28px rgba(0,0,0,0.28)",
							color: "var(--dsw-alias-label-primary)",
							display: "flex",
							flexDirection: "column",
							left: "12px",
							maxHeight: "68vh",
							overflowY: "auto",
							pointerEvents: "auto",
							position: "fixed",
							width: "400px",
							zIndex: 60,
						},
					},
					...rows,
				);
			}

			const buttonStyle = {
				background: "transparent",
				border: "1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.35))",
				borderRadius: "4px",
				color: "var(--dsw-alias-label-secondary)",
				cursor: "pointer",
				font: "inherit",
				fontSize: "11px",
				padding: "1px 6px",
			};

			// 側邊欄卡片：放在「今日消費」卡之前；找不到掛載點就安全退回（只有原本的按鈕）。
			try {
				if (createRoot !== null) {
					mountCard({
						createRoot,
						onPlaced: (placed) => store.setCardPlaced(placed === true),
						component: createCard({
							numbering,
							openSession,
							workspaceService,
							openPanel: () => store.setOpen(true),
							statusSource,
						}),
					});
				}
			} catch (error) {
				console.warn("[session-chains] 卡片掛載失敗（其餘功能照常）：", error?.message ?? error);
			}

			// 上方「工作區／會話」區塊也可收合（2026-10-18 使用者指示：加了卡片之後它太佔空間）。
			try {
				mountWorkspaceFold({});
			} catch (error) {
				console.warn("[session-chains] 工作區折疊器掛載失敗（其餘功能照常）：", error?.message ?? error);
			}

			ctx.slots.inject("sidebar.footer.action", () =>
				ctx.slots.register(
					{ name: "sidebar.footer.action", id: "session-chains", order: 100, label: () => "交接鏈" },
					FooterButton,
				),
			);
			ctx.slots.inject("shell.overlay", () =>
				ctx.slots.register({ name: "shell.overlay", id: "session-chains.panel", order: 90 }, Panel),
			);
			// 交接強制提醒：掛在輸入框上方的 dock（那裡才有 `useProjection`），
			// 但畫面位置壓在頂部 —— 位置與資料來源是兩件事。
			ctx.slots.inject("conversation.composer.dock", () =>
				ctx.slots.register({ name: "conversation.composer.dock", id: "session-chains.hud", order: 5 }, TokenHud),
			);
			ctx.slots.inject("conversation.composer.dock", () =>
				ctx.slots.register({ name: "conversation.composer.dock", id: "session-chains.handoff-guard", order: 90 }, HandoffGuard),
			);
		}

		const module = { exports: {} };
		const exports = module.exports;
		const inject = ["slots"];
		exports.apply = apply;
		exports.inject = inject;
		exports.resolveEndpoint = resolveEndpoint;
		exports.formatTime = formatTime;
		exports.readCurrentSessionId = readCurrentSessionId;
		exports.resolveTitlesEndpoint = resolveTitlesEndpoint;
		exports.applyNumberingPlan = applyNumberingPlan;
		exports.sessionRenamer = sessionRenamer;
		exports.createCard = createCard;
		exports.statusOf = statusOf;
		exports.aggregateStatus = aggregateStatus;
		exports.sortChains = sortChains;
		exports.subscribeSettings = subscribeSettings;
		exports.mountCard = mountCard;
		exports.readCardState = readCardState;
		exports.readSettings = readSettings;
		exports.writeSettings = writeSettings;
		exports.DEFAULT_SETTINGS = DEFAULT_SETTINGS;
		exports.mountWorkspaceFold = mountWorkspaceFold;
		exports.readWorkspaceFold = readWorkspaceFold;
		exports.HandoffGuard = HandoffGuard;
		exports.HandoffGuardBody = HandoffGuardBody;
		exports.TokenHud = TokenHud;
		exports.HudSession = HudSession;
		exports.formatTokens = formatTokens;
		exports.formatBalance = formatBalance;
		exports.resolveUsageEndpoint = resolveUsageEndpoint;
		exports.handoffLevel = handoffLevel;
		exports.handoffPrompt = handoffPrompt;
		exports.handoffAnchor = handoffAnchor;
		exports.readHandoffDefer = readHandoffDefer;
		return module.exports;
	},
});
