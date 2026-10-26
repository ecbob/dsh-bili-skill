// dsh-bili-skill 的**客户端半个插件**（跑在 DSH 的 Web / 桌面界面里）。
//
// 它在「设置」里加一个分页「B站 能力底座」，管两件事：
//   ① 扫码登录：出二维码（图由宿主侧 GET /api/dsh-bili-skill/login/qr 发，同源带 cookie 所以浏览器拿得到）、
//      自动轮询扫码结果、从别处抄一份凭证、删掉本机凭证；
//   ② 主人的搜索偏好：写进家目录 config.json 的 `searchPrefs`，那段值会被拼成一块文字**注入到
//      bili-search 说明书的最末尾**（agent 只有调用那份说明书之后才读得到它，放最后是想让它成为
//      最后一次进入视野的信息）。改完立即生效（用的时候现读），不必重启。
//
// 排版：这半个插件自带一份 <style>（下面的 `CSS`），挂在 page 节点里、随 page 一起装卸 ——
// 宿主的设置外壳是 React 且没有 `.bili-*` 这些类，不自己带样式就是一堆裸控件叠在一起（本机见过）。
// 颜色一律取宿主主题变量 `--theme-*` 并带兜底值，深浅色都成立；选择器全收在 `.bili-settings` 里，
// 不碰宿主别的分区；这里也不写死任何人的路径或账号名。
//
// 与宿主侧的通道：宿主在 index.js 里注册了 `/api/dsh-bili-skill` 前缀（GET /status、/account、
// /search-prefs、/login/qr；POST /login/start|poll|import|clear、/search-prefs），这里 fetch 相对路径 ——
// 与 dsh-window-size-keeper 的「窗口大小」分区、@dsh-pet/bridge 的「桌宠」分区同一套做法，不引新机制。
//
// 客户端槽位契约（照 dsh-window-size-keeper 实机踩过的结论，形状错了不报错、只是分区空白）：
//   1. 组件是 ctx.slots.register(options, component) 的**第二个参数**，不是 options 里的字段；
//   2. 工厂必须返回 **React 元素**（设置外壳是 React，返回裸 DOM 节点渲染不出来）—— 所以只用 React
//      搭一个空 div，界面本体在 useEffect 里用 document.createElement 挂进那个 div；
//   3. ctx.effect(...) 管"注册"的清理，渲染的清理归 useEffect 返回的函数。
//
// 语言：界面文案目前只有中文（都在下面那张 `T` 表里）。要加英文：补一份词典 + 可选取用 ctx.locale
// （拿不到就退回中文）。别把它写进 inject —— 声明了客户端运行时没有的服务会让这半个插件整块起不来。

window.__ModuleLoader__.load({
	id: "dsh-bili-skill",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

		const React = require("react");
		const inject = ["slots"];
		const API = "/api/dsh-bili-skill";
		const REFRESH_MS = 10000;   // 状态快照（读本地文件，不打 B站）
		const POLL_MS = 4000;       // 扫码结果
		const EXPIRES_MS = 180000;  // 一张码 180 秒

		const T = {
			"nav.title": "B站 能力底座",
			"page.hint": "扫码登录，以及设定主人自己的搜索偏好。偏好会被注入到 bili-search 说明书的最末尾（只有 agent 调用那份说明书之后才读得到），改完立即生效，不必重启。",
			"card.login": "扫码登录",
			"acct.online": "已登录：{name}（UID {uid}，等级 {level}，凭证来源 {source}）",
			"acct.offline": "未登录 —— 本机没有凭证文件，出码扫一次即可。",
			"acct.failed": "读登录状态失败：{error}",
			"acct.source.scan": "自己扫的码",
			"acct.source.import": "从别处抄的",
			"acct.source.unknown": "未知",
			"acct.refresh": "刷新登录状态",
			"qr.start": "出二维码",
			"qr.waiting": "已出码，等你手机扫码：手机 B站 → 我的 → 扫一扫。",
			"qr.scanned": "已扫码 —— 请在手机上点确认登录。",
			"qr.expired": "这张码过期了，重新点「出二维码」。",
			"qr.ok": "登录成功：{name}（UID {uid}）。",
			"qr.countdown": "剩余约 {sec} 秒（过期就再点一次出码）",
			"qr.link": "不方便扫码就在手机上打开：{url}",
			"qr.imgfail": "二维码图没出来：{why}",
			"qr.matrixfallback": "这台环境用不了 canvas，改走图片那条路（图要是不出来，就用下面那条链接在手机上打开）",
			"qr.imgfail2": "图片这条路没通（多半是这张码的请求没带上页面那份登录 cookie）—— 直接在手机上打开这条链接：{url}",
			"qr.pollfail": "轮询失败：{error}",
			"qr.import": "从别处抄一份凭证",
			"qr.clear": "删掉本机凭证",
			"prefs.card": "主人的搜索偏好",
			"prefs.sub": "注入到 bili-search 说明书末尾",
			"prefs.order": "排序",
			"prefs.pageSize": "每页条数（1–50）",
			"prefs.recentDays": "只要最近 N 天（0 = 不限）",
			"prefs.minViews": "播放下限（0 = 不设）",
			"prefs.maxDuration": "时长上限（秒，0 = 不设）",
			"prefs.exclude": "黑名单词（逗号分隔，标题或简介命中就跳过）",
			"prefs.notes": "另写一句（比上面全部优先）",
			"prefs.hint.order": "接口参数 order 的取值；写完下一次读说明书就是新的",
			"prefs.hint.pageSize": "参数名必须是 page_size，写成 ps 会被接口静默忽略",
			"prefs.hint.recent": "时间戳是秒：按 pubdate >= 现在秒数 - N*86400 自己筛",
			"prefs.hint.minViews": "低于这个播放数直接判跳过（覆盖说明书里的默认口径）",
			"prefs.hint.maxDuration": "超过这个时长直接判跳过",
			"prefs.hint.exclude": "标题或简介出现任一词就跳过",
			"prefs.hint.notes": "这一句会被写在整段最前面，比其它全部优先",
			"prefs.save": "保存偏好",
			"prefs.preview": "看注入成什么样",
			"prefs.saved": "已写入 config.json 的 searchPrefs，立即生效（用的时候现读，不必重启）。",
			"prefs.savefail": "保存失败：{error}",
			"prefs.previewfail": "读预览失败：{error}",
			"prefs.note": "下面这块就是将来贴在 bili-search 说明书最后的那段文字 —— 它排在最末尾，让 agent 在读完整份说明书、动手之前最后一次看到它。",
			"prefs.cap": "当前注入的正文（宿主现读 config.json 拼出来的）",
			"order.totalrank": "综合", "order.pubdate": "最新", "order.click": "播放量", "order.dm": "弹幕", "order.stow": "收藏", "order.scores": "评分",
			"view.card": "现场",
			"view.plugin": "插件 / 登录",
			"view.value": "{version}｜{state}",
			"view.home": "家目录",
			"view.snapshot": "状态快照",
			"view.snapValue": "{file}（挂载即写、每问即刷；判现场不碰 HTTP）{at}",
			"view.ledger": "账本 / 说明书",
			"view.ledgerValue": "{ledger}｜{n} 份",
			"view.http": "通道",
			"view.httpValue": "GET /status、/account、/search-prefs、/login/qr；POST /login/start|poll|import|clear、/search-prefs（同源自动带 cookie）",
			"view.busy": "读取中…",
			"err.net": "请求没通（{error}）"
		};
		const tr = (key, params) => {
			let s = T[key] ?? key;
			return String(s).replace(/\{(\w+)\}/g, (m, name) => (params && name in params ? String(params[name]) : m));
		};

		// 自带样式：颜色全走宿主主题变量（带兜底值），深浅色都成立；全部收在 .bili-settings 里。
		const CSS = `
.bili-settings{font-size:12px;line-height:1.75;max-width:840px;padding:2px 0;color:var(--theme-text,#dcdfe4)}
.bili-settings *{box-sizing:border-box}
.bili-hint{margin:0 0 14px;color:var(--theme-text-secondary,#8a9099);font-size:11px}
.bili-card{border:1px solid var(--theme-border,#33363c);border-radius:10px;padding:12px 14px;margin:0 0 12px;background:rgba(127,127,127,.05)}
.bili-card-head{display:flex;align-items:baseline;flex-wrap:wrap;gap:8px;margin:0 0 10px}
.bili-card-head h3{margin:0;font-size:13px;font-weight:600}
.bili-sub{color:var(--theme-text-secondary,#8a9099);font-size:11px;font-weight:400}
.bili-line{margin:0 0 2px}
.bili-btns{display:flex;flex-wrap:wrap;gap:8px;margin:10px 0 2px}
.bili-btn{background:var(--theme-accent,#4a9eff);color:#fff;border:0;border-radius:7px;padding:6px 12px;font:inherit;font-size:12px;cursor:pointer;white-space:nowrap}
.bili-btn.ghost{background:transparent;border:1px solid var(--theme-border,#3d424a);color:var(--theme-text,#d3d7dd)}
.bili-btn:disabled{opacity:.45;cursor:not-allowed}
.bili-qr{display:flex;flex-wrap:wrap;gap:14px;align-items:flex-start;margin:12px 0 4px;padding:12px;border:1px dashed var(--theme-border,#3d424a);border-radius:10px;background:rgba(127,127,127,.06)}
.bili-qr.off{display:none}
.bili-qr-canvas,.bili-qr-img{padding:6px;background:#fff;border:1px solid var(--theme-border,#33363c);border-radius:8px;image-rendering:pixelated}
.bili-qr-canvas{width:184px;height:184px}
.bili-qr-img{width:184px;height:184px}
.bili-hidden{display:none !important}
.bili-qr-side{flex:1 1 240px;min-width:0}
.bili-qr-state{margin:0 0 4px;font-weight:600}
.bili-count,.bili-link{margin:0 0 4px;color:var(--theme-text-secondary,#8a9099);font-size:11px;word-break:break-all}
.bili-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(232px,1fr));gap:10px 16px;margin:2px 0 12px}
.bili-row{display:flex;flex-direction:column;gap:4px;min-width:0;margin:0}
.bili-row.span2{grid-column:1/-1}
.bili-label{color:var(--theme-text-secondary,#9aa1aa);font-size:11px}
.bili-input{width:100%;background:var(--theme-input-bg,rgba(0,0,0,.22));color:var(--theme-text,#dcdfe4);border:1px solid var(--theme-border,#3d424a);border-radius:7px;padding:6px 8px;font:inherit;font-size:12px}
.bili-input:focus{outline:none;border-color:var(--theme-accent,#4a9eff)}
.bili-input:disabled{opacity:.5}
.bili-textarea{min-height:62px;resize:vertical}
.bili-msg{margin:10px 0 0;font-size:11px;white-space:pre-wrap;word-break:break-word;color:var(--theme-text-secondary,#8a9099)}
.bili-msg.err{color:#e0645c}
.bili-msg.ok{color:#2ecc71}
.bili-note{margin:12px 0 6px;font-size:11px;color:var(--theme-text-secondary,#8a9099)}
.bili-preview{margin:0;padding:10px 12px;border:1px solid var(--theme-border,#33363c);border-radius:8px;background:var(--theme-input-bg,rgba(0,0,0,.2));color:var(--theme-text,#c9ced6);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;line-height:1.7;white-space:pre-wrap;word-break:break-word;max-height:280px;overflow:auto}
.bili-kv{display:grid;grid-template-columns:minmax(96px,max-content) 1fr;gap:4px 14px;margin:0}
.bili-kv .k{color:var(--theme-text-secondary,#8a9099);font-size:11px}
.bili-kv .v{font-size:12px;word-break:break-all}
.bili-kv .v.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px}
`;

		const ORDERS = ["totalrank", "pubdate", "click", "dm", "stow", "scores"];
		const PREF_DEFAULTS = { order: "pubdate", pageSize: 20, recentDays: 0, minViews: 30, maxDurationSec: 0, excludeKeywords: [], notes: "" };

		/** 只跟自家宿主路由说话；同源自动带那份 dsh-auth cookie。 */
		function api(path, init) {
			const opts = { credentials: "same-origin", ...(init || {}) };
			if (opts.body != null) opts.headers = { "content-type": "application/json", ...(opts.headers || {}) };
			return fetch(API + path, opts).then(async (r) => {
				const ct = String((r.headers && r.headers.get ? r.headers.get("content-type") : "") || "");
				if (!r.ok && !ct.includes("json")) throw new Error("http " + r.status);
				return await r.json();
			});
		}
		/** 把表单原始值夹成要 POST 的偏好（宿主侧还会再夹一遍；这里先夹是为了"看到的"与"发出去的"一致）。 */
		function prefsFromBody(raw) {
			const n = (v, lo, hi, dflt) => { const x = Number(v); return Number.isFinite(x) ? Math.max(lo, Math.min(hi, Math.round(x))) : dflt };
			const words = []; const seen = new Set();
			for (const w of String(raw.excludeKeywords ?? "").split(/[,，、;；\s]+/)) { const k = w.trim(); if (!k || seen.has(k)) continue; seen.add(k); words.push(k) }
			return {
				order: ORDERS.includes(String(raw.order)) ? String(raw.order) : PREF_DEFAULTS.order,
				pageSize: n(raw.pageSize, 1, 50, PREF_DEFAULTS.pageSize),
				recentDays: n(raw.recentDays, 0, 3650, PREF_DEFAULTS.recentDays),
				minViews: n(raw.minViews, 0, 100000000, PREF_DEFAULTS.minViews),
				maxDurationSec: n(raw.maxDurationSec, 0, 86400, PREF_DEFAULTS.maxDurationSec),
				excludeKeywords: words.slice(0, 20),
				notes: String(raw.notes ?? "").replace(/\s+/g, " ").trim().slice(0, 600)
			};
		}
		/** 扫码中态 → 人话（86101 / 86090 / 86038 / 0 四态不许混成"成功"）。 */
		function qrStateText(state, info) {
			if (state === "scanned") return tr("qr.scanned");
			if (state === "expired") return tr("qr.expired");
			if (state === "ok") return tr("qr.ok", { name: (info && info.whoami && info.whoami.uname) || "?", uid: (info && info.whoami && info.whoami.uid) || "?" });
			return tr("qr.waiting");
		}
		/** 把宿主食读到的当前偏好灌进控件（表单值以磁盘为准，不硬编码缺省）。 */
		function fillForm(f, p) {
			f.order.value = p.order;
			f.pageSize.value = String(p.pageSize);
			f.recentDays.value = String(p.recentDays);
			f.minViews.value = String(p.minViews);
			f.maxDurationSec.value = String(p.maxDurationSec);
			f.excludeKeywords.value = (p.excludeKeywords || []).join(", ");
			f.notes.value = p.notes || "";
		}

		function apply(ctx) {
			ctx.effect(() => ctx.slots.inject("settings.section", () => ctx.slots.register(
				{ name: "settings.section", id: "dsh-bili-skill", order: 72, label: () => tr("nav.title") },
				() => React.createElement(Section)
			)), "dsh-bili-skill: settings section");
		}

		function Section() {
			const hostRef = React.useRef(null);
			React.useEffect(() => {
				const host = hostRef.current || (typeof document !== "undefined" ? document.body : null);
				if (!host) return;

				const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = String(text); return n; };
				const head = (title, sub) => { const h = el("div", "bili-card-head"); h.append(el("h3", null, title)); if (sub) h.append(el("span", "bili-sub", sub)); return h; };
				const btnRow = () => el("div", "bili-btns");

				const page = el("div", "bili-settings");
				const style = el("style"); style.textContent = CSS;   // 自带样式，随 page 装卸（宿主没有 .bili-* 这些类）

				/* ── ① 扫码登录 ── */
				const cardLogin = el("section", "bili-card");
				const acctLine = el("p", "bili-acct bili-line", tr("view.busy"));
				const btnStart = el("button", "bili-btn bili-btn-start", tr("qr.start"));
				const btnImport = el("button", "bili-btn ghost bili-btn-import", tr("qr.import"));
				const btnClear = el("button", "bili-btn ghost bili-btn-clear", tr("qr.clear"));
				const btnRefresh = el("button", "bili-btn ghost bili-btn-refresh", tr("acct.refresh"));
				const qrBox = el("div", "bili-qr off");
				const qrCanvas = el("canvas", "bili-qr-canvas bili-hidden");   // 主路：拿宿主随 start 给的位矩阵自己画，不发图片子资源请求（那条路能不能带上鉴权 cookie 各家浏览器不一样，没带就是一张裂图）
				const qrImg = el("img", "bili-qr-img bili-hidden"); qrImg.alt = "B站 登录二维码";   // 备用路：只有画不了 canvas 才用
				let lastQrUrl = "";
				qrImg.addEventListener("error", () => setMsg(loginMsg, tr("qr.imgfail2", { url: lastQrUrl || "这条登录链接" }), "err"));
				const qrSide = el("div", "bili-qr-side");
				const qrState = el("p", "bili-qr-state", "");
				const qrCountdown = el("p", "bili-count", "");
				const qrLink = el("p", "bili-link", "");
				qrSide.append(qrState, qrCountdown, qrLink);
				qrBox.append(qrCanvas, qrImg, qrSide);
				const loginMsg = el("p", "bili-msg", "");

				/* ── ② 主人的搜索偏好 ── */
				const cardPrefs = el("section", "bili-card");
				const grid = el("div", "bili-grid");
				const fields = {};
				const mkRow = (key, labelText, kind, extra, span2) => {
					const r = el("label", "bili-row" + (span2 ? " span2" : ""));
					r.append(el("span", "bili-label", labelText));
					let input;
					if (kind === "select") {
						input = el("select", "bili-input");
						for (const o of extra.options) { const opt = el("option", null, o.label); opt.value = o.value; input.append(opt); }
						if (extra.title) input.title = extra.title;
					} else if (kind === "textarea") {
						input = el("textarea", "bili-input bili-textarea"); input.rows = 3; input.placeholder = extra.placeholder || ""; input.title = extra.title || "";
					} else {
						input = el("input", "bili-input"); input.type = kind; input.placeholder = extra.placeholder || ""; input.title = extra.title || "";
						if (extra.min != null) { input.min = String(extra.min); input.max = String(extra.max); input.step = "1"; }
					}
					fields[key] = input; r.append(input); grid.append(r);
					return input;
				};
				// 七个字段：extra 一律给对象（options / placeholder / min-max / title），别让参数形状两头不一致
				mkRow("order", tr("prefs.order"), "select", { options: ORDERS.map((v) => ({ value: v, label: tr("order." + v) })), title: tr("prefs.hint.order") });
				mkRow("pageSize", tr("prefs.pageSize"), "number", { placeholder: "20", min: 1, max: 50, title: tr("prefs.hint.pageSize") });
				mkRow("recentDays", tr("prefs.recentDays"), "number", { placeholder: "0", min: 0, max: 3650, title: tr("prefs.hint.recent") });
				mkRow("minViews", tr("prefs.minViews"), "number", { placeholder: "30", min: 0, max: 100000000, title: tr("prefs.hint.minViews") });
				mkRow("maxDurationSec", tr("prefs.maxDuration"), "number", { placeholder: "0", min: 0, max: 86400, title: tr("prefs.hint.maxDuration") });
				mkRow("excludeKeywords", tr("prefs.exclude"), "text", { placeholder: "广告, 搬运", title: tr("prefs.hint.exclude") }, true);
				mkRow("notes", tr("prefs.notes"), "textarea", { placeholder: "只要 DSH 相关、别混教程", title: tr("prefs.hint.notes") }, true);
				const btnPrefSave = el("button", "bili-btn bili-btn-save-prefs", tr("prefs.save"));
				const btnPrefPeek = el("button", "bili-btn ghost bili-btn-preview", tr("prefs.preview"));
				const prefMsg = el("p", "bili-msg", "");
				const prefNote = el("p", "bili-note", tr("prefs.note"));
				const prefCap = el("p", "bili-note", tr("prefs.cap"));
				const prefPre = el("pre", "bili-preview", "");

				/* ── ③ 现场 ── */
				const cardView = el("section", "bili-card");
				const kv = el("div", "bili-kv");
				const kvRow = (k, v, mono) => { kv.append(el("span", "k", k), el("span", "v" + (mono ? " mono" : ""), v || "—")); return kv.children[kv.children.length - 1]; };
				const viewValue = kvRow(tr("view.plugin"), tr("view.busy"));
				const viewHome = kvRow(tr("view.home"), "—", true);
				const viewSnap = kvRow(tr("view.snapshot"), "—", true);
				const viewLedger = kvRow(tr("view.ledger"), "—");
				kvRow(tr("view.http"), tr("view.httpValue"));

				// 组装：顺序就是看到的样子（标题 → 状态/说明 → 控件 → 结果 → 回话）
				const btnsLogin = btnRow(); btnsLogin.append(btnStart, btnImport, btnClear, btnRefresh);
				const btnsPrefs = btnRow(); btnsPrefs.append(btnPrefSave, btnPrefPeek);
				page.append(style, el("p", "bili-hint", tr("page.hint")));
				cardLogin.append(head(tr("card.login")), acctLine, btnsLogin, qrBox, loginMsg);
				cardPrefs.append(head(tr("prefs.card"), tr("prefs.sub")), grid, btnsPrefs, prefMsg, prefNote, prefCap, prefPre);
				cardView.append(head(tr("view.card")), kv);
				page.append(cardLogin, cardPrefs, cardView);

				/* ── 行为 ── */
				let pollKey = null, pollTimer = null, expireTimer = null, deadline = 0;
				const setMsg = (node, text, kind) => { node.textContent = String(text || ""); node.classList.delete("err"); node.classList.delete("ok"); if (kind) node.classList.add(kind); };
				const withBusy = (btn, fn) => { btn.disabled = true; Promise.resolve(fn()).finally(() => { btn.disabled = false }); };
				const stopPoll = () => { if (pollTimer) { window.clearInterval(pollTimer); pollTimer = null; } };
				const stopExpire = () => { if (expireTimer) { window.clearTimeout(expireTimer); expireTimer = null; } };
				const showQr = (on) => { if (on) qrBox.classList.delete("off"); else qrBox.classList.add("off"); };
				/** 用宿主给的位矩阵在 canvas 上画码：整数倍缩放 + 静区，不依赖图片请求与 cookie。画不出来回 false。 */
				const drawQr = (modules) => {
					const rows = String(modules || "").split("\n").map((r) => r.trim()).filter(Boolean);
					if (!rows.length || rows.some((r) => r.length !== rows[0].length)) return false;
					const n = rows.length;
					const ctx = qrCanvas.getContext ? qrCanvas.getContext("2d") : null;
					if (!ctx || typeof ctx.fillRect !== "function") return false;
					const quiet = 4, scale = Math.max(2, Math.floor(184 / (n + quiet * 2))), px = (n + quiet * 2) * scale;
					qrCanvas.width = px; qrCanvas.height = px;
					qrCanvas.style.width = px + "px"; qrCanvas.style.height = px + "px";
					ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, px, px);
					ctx.fillStyle = "#000";
					for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (rows[r][c] === "1") ctx.fillRect((c + quiet) * scale, (r + quiet) * scale, scale, scale);
					return { px: px, n: n, scale: scale, dark: rows.reduce((a, r) => a + (r.split("1").length - 1), 0) };
				};
				const tickCountdown = () => {
					if (!deadline) return;
					const left = Math.max(0, Math.round((deadline - Date.now()) / 1000));
					qrCountdown.textContent = tr("qr.countdown", { sec: left });
				};

				const loadAccount = () => api("/account").then((d) => {
					acctLine.textContent = d && d.loggedIn
						? tr("acct.online", { name: d.uname || "?", uid: d.uid || "?", level: d.level == null ? "?" : d.level, source: tr("acct.source." + (d.credentialSource || "unknown")) })
						: tr("acct.offline");
					return d;
				}).catch((e) => { acctLine.textContent = tr("acct.failed", { error: String((e && e.message) || e) }); });

				const poll = () => {
					if (!pollKey) return Promise.resolve();
					tickCountdown();
					return api("/login/poll", { method: "POST", body: JSON.stringify({ k: pollKey }) }).then((d) => {
						const st = (d && d.state) || "waiting";
						qrState.textContent = qrStateText(st, d);
						if (st === "ok") {
							stopPoll(); stopExpire(); showQr(false); pollKey = null; deadline = 0; qrCountdown.textContent = "";
							setMsg(loginMsg, tr("qr.ok", { name: (d.whoami && d.whoami.uname) || "?", uid: (d.whoami && d.whoami.uid) || "?" }), "ok");
							loadAccount(); refreshView();
						} else if (st === "expired") { stopPoll(); stopExpire(); deadline = 0; qrCountdown.textContent = ""; }
					}).catch((e) => { setMsg(loginMsg, tr("qr.pollfail", { error: String((e && e.message) || e) }), "err"); });
				};
				const startQr = () => withBusy(btnStart, () => {
					setMsg(loginMsg, ""); stopPoll(); stopExpire(); qrState.textContent = ""; qrCountdown.textContent = ""; qrLink.textContent = "";
					return api("/login/start", { method: "POST", body: JSON.stringify({}) }).then((d) => {
						if (!d || d.ok === false) { setMsg(loginMsg, tr("qr.imgfail", { why: (d && d.qr_png && d.qr_png.failed) || (d && d.error) || "未知" }), "err"); return d; }
						pollKey = d.key; lastQrUrl = d.url || "";
						const drew = d.qr_png && d.qr_png.modules ? drawQr(d.qr_png.modules) : false;
						if (drew) { qrCanvas.classList.delete("bili-hidden"); qrImg.classList.add("bili-hidden"); showQr(true); }
						else if (d.qr_png && d.qr_png.imageUrl) { qrImg.src = d.qr_png.imageUrl; qrImg.classList.delete("bili-hidden"); qrCanvas.classList.add("bili-hidden"); showQr(true); setMsg(loginMsg, tr("qr.matrixfallback"), ""); }
						else { showQr(false); setMsg(loginMsg, tr("qr.imgfail", { why: (d.qr_png && d.qr_png.failed) || "没出图" }), "err"); }
						qrState.textContent = tr("qr.waiting");
						if (d.url) qrLink.textContent = tr("qr.link", { url: d.url });
						deadline = Date.now() + (d.expiresInMs || EXPIRES_MS);
						tickCountdown();
						pollTimer = window.setInterval(poll, POLL_MS);
						expireTimer = window.setTimeout(() => { stopPoll(); deadline = 0; qrState.textContent = tr("qr.expired"); qrCountdown.textContent = ""; }, EXPIRES_MS);
						return d;
					}).catch((e) => { setMsg(loginMsg, tr("err.net", { error: String((e && e.message) || e) }), "err"); });
				});
				btnStart.addEventListener("click", startQr);
				btnRefresh.addEventListener("click", () => withBusy(btnRefresh, loadAccount));
				btnImport.addEventListener("click", () => withBusy(btnImport, () =>
					api("/login/import", { method: "POST", body: JSON.stringify({}) }).then((d) => {
						setMsg(loginMsg, d && d.ok ? tr("qr.ok", { name: (d.account && d.account.uname) || "?", uid: (d.account && d.account.uid) || "?" }) : String((d && d.message) || "没抄到"), d && d.ok ? "ok" : "err");
						loadAccount(); refreshView();
					}).catch((e) => setMsg(loginMsg, tr("err.net", { error: String((e && e.message) || e) }), "err"))
				));
				btnClear.addEventListener("click", () => {
					if (!window.confirm(tr("qr.clear") + "？")) return;
					withBusy(btnClear, () => {
						stopPoll(); stopExpire(); pollKey = null; deadline = 0; showQr(false); qrState.textContent = ""; qrCountdown.textContent = "";
						return api("/login/clear", { method: "POST", body: JSON.stringify({}) }).then(() => { setMsg(loginMsg, ""); loadAccount(); refreshView(); })
							.catch((e) => setMsg(loginMsg, tr("err.net", { error: String((e && e.message) || e) }), "err"));
					});
				});

				const loadPrefs = () => api("/search-prefs").then((d) => {
					if (!d || !d.prefs) return;
					fillForm(fields, d.prefs);
					prefPre.textContent = String(d.injected || "").trim();
				}).catch((e) => setMsg(prefMsg, tr("prefs.previewfail", { error: String((e && e.message) || e) }), "err"));
				btnPrefSave.addEventListener("click", () => withBusy(btnPrefSave, () => {
					const body = { searchPrefs: prefsFromBody({ order: fields.order.value, pageSize: fields.pageSize.value, recentDays: fields.recentDays.value, minViews: fields.minViews.value, maxDurationSec: fields.maxDurationSec.value, excludeKeywords: fields.excludeKeywords.value, notes: fields.notes.value }) };
					return api("/search-prefs", { method: "POST", body: JSON.stringify(body) }).then((d) => {
						if (d && d.ok) {
							setMsg(prefMsg, tr("prefs.saved"), "ok");
							fillForm(fields, d.prefs); prefPre.textContent = String(d.injected || "").trim();
							if (d.snapshot) applyView(d.snapshot);
						} else setMsg(prefMsg, tr("prefs.savefail", { error: String((d && d.error) || "未知") }), "err");
					}).catch((e) => setMsg(prefMsg, tr("prefs.savefail", { error: String((e && e.message) || e) }), "err"));
				}));
				btnPrefPeek.addEventListener("click", () => withBusy(btnPrefPeek, loadPrefs));

				const applyView = (s) => {
					if (!s) return;
					viewValue.textContent = tr("view.value", { version: s.version || "?", state: s.loggedIn ? "已登录" : "未登录" });
					viewHome.textContent = s.home || "—";
					viewSnap.textContent = tr("view.snapValue", { file: s.statusFile || "?", at: s.at ? "（" + s.at + "）" : "" });
					viewLedger.textContent = tr("view.ledgerValue", { ledger: s.ledger || "?", n: (s.skills || []).length });
				};
				const refreshView = () => api("/status").then(applyView).catch(() => { viewValue.textContent = tr("acct.failed", { error: "status" }); });

				host.appendChild(page);
				loadAccount(); loadPrefs(); refreshView();
				const timer = window.setInterval(refreshView, REFRESH_MS);
				return () => {
					window.clearInterval(timer); stopPoll(); stopExpire();
					if (page.parentNode) page.parentNode.removeChild(page);
				};
			}, []);
			return React.createElement("div", { className: "bili-settings-host", ref: hostRef });
		}

		exports.apply = apply;
		exports.inject = inject;
		exports.__test__ = { T, tr, api, prefsFromBody, qrStateText, fillForm, ORDERS, PREF_DEFAULTS, CSS, SECTION: Section, API, REFRESH_MS, POLL_MS, EXPIRES_MS };
		return module.exports;
	}
});
