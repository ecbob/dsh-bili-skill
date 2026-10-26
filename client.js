// dsh-bili-skill 的**客户端半个插件**（跑在 DSH 的 Web / 桌面界面里）。
//
// 它在「设置」里加一个分页「B站 能力底座」，管两件事：
//   ① 扫码登录：出二维码（图由宿主侧的 /api/dsh-bili-skill/login/qr 发，同源带 cookie 所以浏览器拿得到）、
//      自动轮询扫码结果、从别处抄一份凭证、删掉本机凭证；
//   ② 主人的搜索偏好：写进家目录 config.json 的 `searchPrefs`，那段值会被拼成一块文字**注入到
//      bili-search 说明书的最末尾**（agent 只有调用 skill 之后才读得到它，放在最后是为了让它成为
//      最后一次进入视野的信息）。改完立即生效（用的时候现读），不必重启。
//
// 与宿主侧的通道：宿主在 index.js 里注册了 `/api/dsh-bili-skill` 前缀（GET /status、/account、
// /search-prefs、/login/qr，POST /login/start|poll|import|clear、/search-prefs），这里直接 fetch 相对路径 ——
// 与 dsh-window-size-keeper 的「窗口大小」分区、@dsh-pet/bridge 的「桌宠」分区同一套做法，不引新机制。
// 鉴权：同源请求自动带那份 dsh-auth-* cookie，所以浏览器里这条通道是通的（命令行不带才 401）。
//
// 客户端槽位契约（照 dsh-window-size-keeper 实机踩过的结论，形状错了不报错、只是分区空白）：
//   1. 组件是 ctx.slots.register(options, component) 的**第二个参数**，不是 options 里的字段；
//   2. 工厂必须返回 **React 元素**（设置外壳是 React，返回裸 DOM 节点渲染不出来）—— 所以这里只
//      用 React 搭一个空 div，界面本体在 useEffect 里用 document.createElement 挂进那个 div；
//   3. ctx.effect(...) 管"注册"的清理，渲染的清理归 useEffect 返回的函数。
//
// 语言：界面文案目前只有中文（都在下面那张 `T` 表里）。要加英文：照 keeper 的办法补一份词典 +
// 可选取用 ctx.locale（拿不到就退回中文），别把它写进 inject —— 声明了运行时没有的服务会让这半个插件整块起不来。

window.__ModuleLoader__.load({
	id: "dsh-bili-skill",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

		const React = require("react");
		const inject = ["slots"];
		const API = "/api/dsh-bili-skill";
		const REFRESH_MS = 10000;   // 状态快照（本地文件，不打网络）
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
			"qr.waiting": "已出码，等你手机扫码（约 180 秒过期）。手机 B站 → 我的 → 扫一扫。",
			"qr.scanned": "已扫码 —— 请在手机上点确认登录。",
			"qr.expired": "这张码过期了，重新点「出二维码」。",
			"qr.ok": "登录成功：{name}（UID {uid}）。",
			"qr.imgfail": "二维码图没出来：{why}（可以自己在手机里打开这条链接：{url}）",
			"qr.pollfail": "轮询失败：{error}",
			"qr.import": "从别处抄一份凭证",
			"qr.clear": "删掉本机凭证",
			"prefs.card": "主人的搜索偏好（注入到 bili-search 说明书末尾）",
			"prefs.order": "排序",
			"prefs.pageSize": "每页条数（1–50）",
			"prefs.recentDays": "只要最近 N 天（0 = 不限）",
			"prefs.minViews": "播放下限（0 = 不设）",
			"prefs.maxDuration": "时长上限（秒，0 = 不设）",
			"prefs.exclude": "黑名单词（逗号分隔，标题或简介命中就跳过）",
			"prefs.notes": "另写一句（比上面全部优先）",
			"prefs.save": "保存偏好",
			"prefs.preview": "看注入成什么样",
			"prefs.saved": "已写入 config.json 的 searchPrefs，立即生效（用的时候现读，不必重启）。",
			"prefs.savefail": "保存失败：{error}",
			"prefs.previewfail": "读预览失败：{error}",
			"prefs.note": "这一块的正文就是将来贴在 bili-search 说明书最后的那段文字 —— 它排在最末尾，是让 agent 在读完整份说明书之后、动手之前最后一次看到它。",
			"order.totalrank": "综合", "order.pubdate": "最新", "order.click": "播放量", "order.dm": "弹幕", "order.stow": "收藏", "order.scores": "评分",
			"view.card": "现场",
			"view.line": "插件 {version}｜{state}｜家目录 {home}",
			"view.snapshot": "状态快照：{file}（挂载即写、每问即刷；判现场不必碰 HTTP）",
			"view.ledger": "账本：{ledger}｜说明书：{n} 份",
			"view.http": "这些接口挂在宿主的浏览器会话鉴权后面（同源自动带 cookie）：{paths}",
			"view.busy": "读取中…",
			"err.net": "请求没通（{error}）"
		};
		const tr = (key, params) => {
			let s = T[key] ?? key;
			return String(s).replace(/\{(\w+)\}/g, (m, name) => (params && name in params ? String(params[name]) : m));
		};
		const ORDERS = ["totalrank", "pubdate", "click", "dm", "stow", "scores"];
		const PREF_DEFAULTS = { order: "pubdate", pageSize: 20, recentDays: 0, minViews: 30, maxDurationSec: 0, excludeKeywords: [], notes: "" };

		/** 只跟自家宿主路由说话；同源自动带那份 dsh-auth cookie。 */
		function api(path, init) {
			const opts = { credentials: "same-origin", ...(init || {}) };
			if (opts.body != null) opts.headers = { "content-type": "application/json", ...(opts.headers || {}) };
			return fetch(API + path, opts).then(async (r) => {
				const ct = String(r.headers && r.headers.get ? r.headers.get("content-type") : "") || "";
				if (!r.ok && !ct.includes("json")) throw new Error("http " + r.status);
				return await r.json();
			});
		}
		/** 把表单里的原始值夹成要 POST 的偏好对象（宿主侧还会再夹一遍；这里先夹是为了"你看到的"与"你发出去的"一致）。 */
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
				notes: String(raw.notes ?? "").trim().slice(0, 600)
			};
		}
		/** 登录中态 → 给人看的一句话。 */
		function qrStateText(state, info) {
			if (state === "scanned") return tr("qr.scanned");
			if (state === "expired") return tr("qr.expired");
			if (state === "ok") return tr("qr.ok", { name: (info && info.whoami && info.whoami.uname) || "?", uid: (info && info.whoami && info.whoami.uid) || "?" });
			return tr("qr.waiting");
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
				const page = el("div", "bili-settings");
				const hint = el("p", "bili-hint", tr("page.hint"));
				const cardLogin = el("section", "bili-card");
				const cardPrefs = el("section", "bili-card");
				const cardView = el("section", "bili-card");
				page.append(hint, cardLogin, cardPrefs, cardView);

				// ── ① 登录 ──
				const acctLine = el("p", "bili-acct", tr("view.busy"));
				const qrBox = el("div", "bili-qr");
				const qrLine = el("p", "bili-qr-state", "");
				const qrImg = el("img", "bili-qr-img");
				qrImg.alt = "B站 登录二维码"; qrImg.style.display = "none";
				const btnStart = el("button", "bili-btn bili-btn-start", tr("qr.start"));
				const btnImport = el("button", "bili-btn bili-btn-import", tr("qr.import"));
				const btnClear = el("button", "bili-btn bili-btn-clear", tr("qr.clear"));
				const btnRefresh = el("button", "bili-btn bili-btn-refresh", tr("acct.refresh"));
				const loginMsg = el("p", "bili-msg", "");
				cardLogin.append(el("h3", null, tr("card.login")), acctLine, qrImg, qrLine, qrBox, btnStart, btnImport, btnClear, btnRefresh, loginMsg);
				qrBox.append();

				let pollKey = null, pollTimer = null, expireTimer = null;
				const say = (text) => { loginMsg.textContent = String(text || ""); };
				const stopPoll = () => { if (pollTimer) { window.clearInterval(pollTimer); pollTimer = null; } };
				const stopExpire = () => { if (expireTimer) { window.clearTimeout(expireTimer); expireTimer = null; } };
				const loadAccount = () => api("/account").then((d) => {
					acctLine.textContent = d && d.loggedIn
						? tr("acct.online", { name: d.uname || "?", uid: d.uid || "?", level: d.level == null ? "?" : d.level, source: tr("acct.source." + (d.credentialSource || "unknown")) })
						: tr("acct.offline");
					if (d && d.level_info) { /* 等级来自 level_info.current_level，别再看 vipStatus */ }
					if (d && d.ok === false && !d.loggedIn) acctLine.textContent = tr("acct.offline");
					return d;
				}).catch((e) => { acctLine.textContent = tr("acct.failed", { error: String(e && e.message || e) }); });
				const poll = () => api("/login/poll", { method: "POST", body: JSON.stringify({ k: pollKey }) }).then((d) => {
					const st = (d && d.state) || "waiting";
					qrLine.textContent = qrStateText(st, d);
					if (st === "ok") { stopPoll(); stopExpire(); qrImg.style.display = "none"; pollKey = null; loadAccount(); refreshView(); say(tr("qr.ok", { name: (d.whoami && d.whoami.uname) || "?", uid: (d.whoami && d.whoami.uid) || "?" })); }
					else if (st === "expired") { stopPoll(); stopExpire(); }
				}).catch((e) => { say(tr("qr.pollfail", { error: String(e && e.message || e) })); });
				const startQr = () => {
					say(""); stopPoll(); stopExpire(); qrLine.textContent = ""; qrBox.textContent = "";
					return api("/login/start", { method: "POST", body: JSON.stringify({}) }).then((d) => {
						if (!d || d.ok === false) { say(tr("qr.imgfail", { why: (d && d.qr_png && d.qr_png.failed) || (d && d.error) || "未知", url: (d && d.url) || "" })); return d; }
						pollKey = d.key;
						if (d.qr_png && d.qr_png.imageUrl) { qrImg.src = d.qr_png.imageUrl; qrImg.style.display = ""; }
						else say(tr("qr.imgfail", { why: (d.qr_png && d.qr_png.failed) || "没出图", url: d.url || "" }));
						qrLine.textContent = tr("qr.waiting");
						pollTimer = window.setInterval(poll, POLL_MS);
						expireTimer = window.setTimeout(() => { stopPoll(); qrLine.textContent = tr("qr.expired"); }, EXPIRES_MS);
						return d;
					}).catch((e) => { say(tr("err.net", { error: String(e && e.message || e) })); });
				};
				btnStart.addEventListener("click", () => { startQr(); });
				btnRefresh.addEventListener("click", () => { loadAccount(); });
				btnImport.addEventListener("click", () => {
					api("/login/import", { method: "POST", body: JSON.stringify({}) }).then((d) => {
						say(d && d.ok ? tr("qr.ok", { name: (d.account && d.account.uname) || "?", uid: (d.account && d.account.uid) || "?" }) : String(d && d.message || "没抄到"));
						loadAccount(); refreshView();
					}).catch((e) => say(tr("err.net", { error: String(e && e.message || e) })));
				});
				btnClear.addEventListener("click", () => {
					if (!window.confirm(tr("qr.clear") + "？")) return;
					stopPoll(); stopExpire(); pollKey = null; qrImg.style.display = "none"; qrLine.textContent = "";
					api("/login/clear", { method: "POST", body: JSON.stringify({}) }).then(() => { loadAccount(); refreshView(); say(""); })
						.catch((e) => say(tr("err.net", { error: String(e && e.message || e) })));
				});

				// ── ② 搜索偏好 ──
				const fields = {};
				const mkRow = (key, labelText, kind, extra) => {
					const row = el("label", "bili-row");
					row.append(el("span", "bili-label", labelText));
					let input;
					if (kind === "select") {
						input = el("select", "bili-input");
						for (const o of extra) { const opt = el("option", null, o.label); opt.value = o.value; input.append(opt); }
					} else if (kind === "textarea") {
						input = el("textarea", "bili-input"); input.rows = 3; input.placeholder = extra || "";
					} else {
						input = el("input", "bili-input"); input.type = kind; input.placeholder = extra || "";
					}
					fields[key] = input; row.append(input); cardPrefs.append(row);
					return input;
				};
				const btnPrefSave = el("button", "bili-btn bili-btn-save-prefs", tr("prefs.save"));
				const btnPrefPeek = el("button", "bili-btn bili-btn-preview", tr("prefs.preview"));
				const prefMsg = el("p", "bili-msg", "");
				const prefNote = el("p", "bili-note", tr("prefs.note"));
				const prefPre = el("pre", "bili-preview", "");
				const h3 = el("h3", null, tr("prefs.card"));
				cardPrefs.append(h3);
				mkRow("order", tr("prefs.order"), "select", ORDERS.map((v) => ({ value: v, label: tr("order." + v) })));
				mkRow("pageSize", tr("prefs.pageSize"), "number", "1–50");
				mkRow("recentDays", tr("prefs.recentDays"), "number", "0–3650");
				mkRow("minViews", tr("prefs.minViews"), "number", "0");
				mkRow("maxDurationSec", tr("prefs.maxDuration"), "number", "0");
				mkRow("excludeKeywords", tr("prefs.exclude"), "text", "广告, 搬运");
				mkRow("notes", tr("prefs.notes"), "textarea", "只要 DSH 相关、别混教程");
				cardPrefs.append(btnPrefSave, btnPrefPeek, prefMsg, prefNote, prefPre);
				const setPrefsForm = (p) => {
					fields.order.value = p.order; fields.pageSize.value = String(p.pageSize); fields.recentDays.value = String(p.recentDays);
					fields.minViews.value = String(p.minViews); fields.maxDurationSec.value = String(p.maxDurationSec);
					fields.excludeKeywords.value = (p.excludeKeywords || []).join(", "); fields.notes.value = p.notes || "";
				};
				const loadPrefs = () => api("/search-prefs").then((d) => {
					if (!d || !d.prefs) return;
					setPrefsForm(d.prefs);
					prefPre.textContent = String(d.injected || "").trim();
				}).catch((e) => { prefMsg.textContent = tr("prefs.previewfail", { error: String(e && e.message || e) }); });
				btnPrefSave.addEventListener("click", () => {
					const body = { searchPrefs: prefsFromBody({ order: fields.order.value, pageSize: fields.pageSize.value, recentDays: fields.recentDays.value, minViews: fields.minViews.value, maxDurationSec: fields.maxDurationSec.value, excludeKeywords: fields.excludeKeywords.value, notes: fields.notes.value }) };
					api("/search-prefs", { method: "POST", body: JSON.stringify(body) }).then((d) => {
						if (d && d.ok) { prefMsg.textContent = tr("prefs.saved"); setPrefsForm(d.prefs); prefPre.textContent = String(d.injected || "").trim(); if (d.snapshot) applyView(d.snapshot); }
						else prefMsg.textContent = tr("prefs.savefail", { error: String((d && d.error) || "未知") });
					}).catch((e) => { prefMsg.textContent = tr("prefs.savefail", { error: String(e && e.message || e) }); });
				});
				btnPrefPeek.addEventListener("click", () => { loadPrefs(); });

				// ── ③ 现场 ──
				const viewTitle = el("h3", null, tr("view.card"));
				const viewLine = el("p", "bili-view-line", tr("view.busy"));
				const viewSnap = el("p", "bili-view-snap", "");
				const viewLedger = el("p", "bili-view-ledger", "");
				const viewHttp = el("p", "bili-view-http", tr("view.http", { paths: "GET /status、/account、/search-prefs、/login/qr；POST /login/start|poll|import|clear、/search-prefs" }));
				cardView.append(viewTitle, viewLine, viewSnap, viewLedger, viewHttp);
				const applyView = (s) => {
					if (!s) return;
					viewLine.textContent = tr("view.line", { version: s.version || "?", state: s.loggedIn ? "已登录" : "未登录", home: s.home || "?" });
					viewSnap.textContent = tr("view.snapshot", { file: s.statusFile || "?" });
					viewLedger.textContent = tr("view.ledger", { ledger: s.ledger || "?", n: (s.skills || []).length });
				};
				const refreshView = () => api("/status").then(applyView).catch(() => { viewLine.textContent = tr("acct.failed", { error: "status" }); });

				host.appendChild(page);
				loadAccount(); loadPrefs(); refreshView();
				const timer = window.setInterval(() => { refreshView(); }, REFRESH_MS);
				return () => {
					window.clearInterval(timer); stopPoll(); stopExpire();
					if (page.parentNode) page.parentNode.removeChild(page);
				};
			}, []);
			return React.createElement("div", { className: "bili-settings-host", ref: hostRef });
		}

		exports.apply = apply;
		exports.inject = inject;
		exports.__test__ = { T, tr, api, prefsFromBody, qrStateText, ORDERS, PREF_DEFAULTS, SECTION: Section, API, REFRESH_MS, POLL_MS, EXPIRES_MS };
		return module.exports;
	}
});
