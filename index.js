/**
 * dsh-bili-base —— B站 能力的「底座」插件（纯 JS、零运行时依赖）
 *
 * 设计（2026-10-25，与 c1overzz/dsh-bili-scroll 并存、互不抢地盘）：
 *   base 只管四件事：① 登录与凭证 ② 身份（昵称 ↔ UID）③ 一条带 Cookie/CSRF/WBI 签名的通用 API 通道
 *   ④ 记账。能力面（搜索筛选 / 看画面理解 / 评论 / 读私信 / 写私信 / 记账）是**六份 SKILL.md**，
 *   按需加载 —— 常驻的工具声明只有 4 只，这正合本地模型「少声明、按需取说明书」的取向。
 *   没有值班轮、没有定时器、没有日报、没有专用 profile，也不碰 bili-scroll 的家目录。
 *
 * 家目录（全在这一个目录里，删掉即彻底回滚）：
 *   $DSH_HOME/bili-base/
 *     config.json              运行时配置（设置页/工具改，优先于 patch config）
 *     bili_credential.json     sessdata / bili_jct / buvid3 / dedeuserid（字段名与 bili-scroll 一致，可直接互抄）
 *     uid-cache.json           昵称 → UID（带时间戳，TTL 7 天）
 *     ledger/<表名>.jsonl      记账（append-only，可按 key 去重）
 *     frames/<bvid>-…          取到的画面帧（PNG/JPG，给 read_image 或视觉插件吃）
 *     base.log                 本插件自己的日志（含"这次调用签了 wbi / 用了哪份凭证"）
 *
 * 拓展点（按便宜程度排序）：
 *   1) 改 `skills/<name>.md` —— 判入口径、端点清单、红线，全是 markdown
 *   2) 在 `bili-base/skills/<name>.md` 放同名文件 —— 覆盖包内那份，升级不被冲（provider 每次现读磁盘）
 *   3) 在 `SKILL_NAMES` 里加一个名字 + 一个 md 文件 —— 多一个能力，不加工具
 *   4) 在 `TOOLS` 之下加一只 `ctx.tools.register(...)` —— 需要新原子操作时才动
 *
 * 只 import node: 内置（fs/path/os/crypto/url）+ 全局 fetch。不引 @deepseek-ai/*、不引 undici。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

export const name = 'bili-base'
/** 硬注入：这两样在本 profile 里必然存在（tools 注册 / skills 注册表） */
export const inject = ['tools', 'skills']

const here = path.dirname(fileURLToPath(import.meta.url))
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
/**
 * 把响应整理成 {ok,code,message,data}。B站 的接口分两种形状：带 `{code,message,data}` 信封的接口，和
 * **不带信封的裸对象**（字幕正文就是 `{body:[…]}`、用户卡片是 `{card:{…}}`）—— 后者要是照信封去解，
 * 正文会被整份丢掉、只剩 `data:null`（本机 2026-10-26 实测撞过）。所以：没有 `code` 键就把整份原样回在 data 里。
 * 导出是为了让离线自检能直接测到这条。
 */
export function __unwrapResponse(j, status = 0) {
  if (j == null || typeof j !== 'object' || Array.isArray(j)) return { ok: false, code: status, message: `响应不是对象（http=${status}）`, data: null }
  if (!('code' in j)) return { ok: true, code: 0, message: '（这条响应没有 code/message 信封，整份原样回在 data 里）', data: j }
  const ok = j.code === 0
  return { ok, code: j.code, message: j.message || (ok ? '' : `code=${j.code}`), data: j.data ?? null, ttl: typeof j.ttl === 'number' ? j.ttl : undefined }
}

/** POST 表单要带 csrf=bili_jct 才不被 B站 判 -111。导出是为了让离线自检能盯住"补 csrf 必须在序列化之前"。 */
export function __withCsrf(body, cred) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? { ...body } : {}
  if (cred?.bili_jct) {
    if (!('csrf' in b)) b.csrf = cred.bili_jct
    // 参考实现（bilibili-api-python）两个都发；只发 csrf 时接口也收，但风控看的是「像个正常客户端」
    if (!('csrf_token' in b)) b.csrf_token = cred.bili_jct
  }
  return b
}

/** 工具结果里的图片是"附件引用"（{type:'image', attachment: ref}），不是 base64 字段：字节先进宿主的 attachments 服务。 */
export function __renderWithImages(value) {
  const src = value && typeof value === 'object' && !Array.isArray(value) ? value : { value }
  const { image, images, ...rest } = src
  const parts = [{ type: 'text', text: JSON.stringify(rest, null, 2) }]
  const refs = [...(image ? [image] : []), ...(Array.isArray(images) ? images : [])]
  for (const ref of refs) parts.push({ type: 'image', attachment: ref })
  return parts
}
/** 把帧存成宿主的图片附件；宿主没给服务或模型不接图片时退化成文字（这条契约照 dsh-bili-scroll 抄，MIT 同源）。 */
export async function __attachImages(get, exec, images) {
  const grab = (k) => { try { return get?.(k) } catch { return null } }
  const attachments = grab('attachments')
  if (!attachments?.saveImages) return { ok: false, reason: 'no_attachments', hint: '宿主的图片附件服务不可用（ctx.get("attachments") 拿不到）=> 这次只回文件路径' }
  const llm = grab('llm')
  const routed = exec?.agent?.session?.requestHeader?.()?.config
  const provider = routed?.provider ?? exec?.agent?.options?.provider
  const model = routed?.model ?? exec?.agent?.options?.model
  if (llm?.resolveModelInfo) {
    try {
      const m = (await llm.resolveModelInfo(provider, model, exec?.signal))?.inputModalities
      if (Array.isArray(m) && !m.includes('image')) return { ok: false, reason: 'model_no_image', hint: '模型 ' + provider + '/' + model + ' 不接图片输入（' + (m.join(', ') || '没声明') + '）=> 这次只回文件路径，要看得靠视觉类插件（modlens_read_image）' }
    } catch { /* 探针失败就当能发，让宿主自己决定 */ }
  }
  try {
    return { ok: true, refs: await attachments.saveImages(images.map((i) => ({ data: i.buffer, mediaType: i.mediaType }))) }
  } catch (e) { return { ok: false, reason: 'save_failed', hint: '存图片附件失败：' + String(e?.message || e) } }
}

// ⚠️ Referer 不能带尾斜杠：本机逐变量隔离实测 —— 带 '/' 时评论被判 attr 0x620000（=6422528）降级、
// 只自己可见甚至过一会儿被删；换成 'https://www.bilibili.com' 后同样的 cookie/UA/表单立刻变回 state 0 attr 0。
// 参考实现（bilibili_api HEADERS, network.py:1577）用的正是没有尾斜杠的这一份。
const REFERER = 'https://www.bilibili.com'
// Gaia 上报与 Python 参考实现同一份浏览器指纹口径（本机实测：Python 这么发是 state 0，我那么发是 state 17）
const GAIA_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0'
const GAIA_REFERER = 'https://www.bilibili.com'
/**
 * 把 4 个凭证字段拼成 Cookie 头。
 * ⚠️ B站 真正认的是**首字母大写**的名字（SESSDATA / DedeUserID）；小写那两份是各家库自己存的别名。
 * bilibili-api-python 的做法是**两种拼写一起发**（Credential.get_cookies() 实测就是这样）—— 只发小写时
 * nav 会一路回 code=-101「账号未登录」，连带让 wbi 端点把我判成匿名会话、只回 v_voucher
 * （本机 2026-10-26 撞实过，对照实验：同一份凭证，隔壁 dsh-bili-scroll 说已登录）。
 */
export function __cookieHeader(c) {
  const parts = []
  if (c?.sessdata) parts.push(`SESSDATA=${c.sessdata}`, `sessdata=${c.sessdata}`)
  if (c?.dedeuserid) parts.push(`DedeUserID=${c.dedeuserid}`, `dedeuserid=${c.dedeuserid}`)
  if (c?.bili_jct) parts.push(`bili_jct=${c.bili_jct}`)
  if (c?.buvid3) parts.push(`buvid3=${c.buvid3}`)
  if (c?.buvid4) parts.push(`buvid4=${c.buvid4}`)
  return parts.join('; ')
}

/** 把返回值改成"无损可 JSON 化"的形状（宿主对工具输出的硬要求）。导出是为了让它能被离线自检直接测到。 */
export function __lossless(v) {
  if (v === undefined) return undefined
  if (v === null) return null
  const t = typeof v
  if (t === 'number') return !Number.isFinite(v) ? null : (Number.isInteger(v) && !Number.isSafeInteger(v) ? String(v) : v)   // 只有超过 2^53 的大整数才转字符串（msg_key 那种）；普通小数照旧是数字   // 超过 2^53 的 id（msg_key 就是）转成字符串，免得精度被吃掉
  if (t === 'bigint') return String(v)
  if (t === 'string' || t === 'boolean') return v
  if (t === 'function' || t === 'symbol') return undefined
  if (v instanceof Date) return v.toISOString()
  if (Array.isArray(v)) return v.map((x) => { const o = __lossless(x); return o === undefined ? null : o })
  if (t === 'object') { const out = {}; for (const [k, x] of Object.entries(v)) { const o = __lossless(x); if (o !== undefined) out[k] = o } return out }
  return String(v)
}

/** bili_api 只准打 B站 自己家的域：接口在 bilibili.com，字幕与图片在 hdslb.com，视频流在 bilivideo.com */
const ALLOWED_HOSTS = /(?:^|\.)(?:bilibili|hdslb|bilivideo)\.com$/i
/** 路径准入判定（导出是为了让离线自检能直接测到这条边界） */
export function __allowedUrl(raw) {
  const s = String(raw || '').trim()
  if (s.startsWith('//')) { try { return ALLOWED_HOSTS.test(new URL('https:' + s).hostname) } catch { return false } }
  if (/^https?:\/\//i.test(s)) { try { return ALLOWED_HOSTS.test(new URL(s).hostname) } catch { return false } }
  return s.startsWith('/')
}

/**
 * murmur3_x64_128 → B站 的 buvid_fp（算法与 seed=31 都照抄 bilibili-api-python network.py:1621-1700）。
 * 结果 = hex(h1) + hex(h2)，Python 的 hex() 不补零，所以这里也不补（BigInt.toString(16) 行为一致）。
 * 自检里拿参考实现 dump 出来的向量逐位比对（gaia/_fp-vector.txt）。
 */
export function __murmur3x64128Hex(str, seed = 31) {
  const MASK = (1n << 64n) - 1n
  const mod = (x) => ((x % (MASK + 1n)) + (MASK + 1n)) % (MASK + 1n)
  const rotl = (x, r) => mod((x << r) | (x >> (64n - r)))
  const C1 = 0x87c37b91114253d5n, C2 = 0x4cf5ad432745937fn, C3 = 0x52dce729n, C4 = 0x38495ab5n
  const D1 = 0xff51afd7ed558ccdn, D2 = 0xc4ceb9fe1a85ec53n
  const le64 = (b, o) => { let v = 0n; for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(b[o + i] ?? 0); return v }
  const fmix64 = (k0) => { let k = k0; k = mod(k ^ (k >> 33n)); k = mod(k * D1); k = mod(k ^ (k >> 33n)); k = mod(k * D2); k = mod(k ^ (k >> 33n)); return k }
  const bytes = Buffer.from(String(str), 'ascii')
  let h1 = BigInt(seed), h2 = BigInt(seed)
  let processed = 0, off = 0
  while (true) {
    const len = Math.min(16, bytes.length - off)
    processed += len
    if (len === 16) {
      const k1 = le64(bytes, off), k2 = le64(bytes, off + 8)
      h1 = mod(h1 ^ mod(mod(rotl(mod(k1 * C1), 31n)) * C2))
      h1 = mod(mod(rotl(h1, 27n) + h2) * 5n + C3)   // 参考实现是「先轮转 h1 再加 h2」，不是先加
      h2 = mod(h2 ^ mod(mod(rotl(mod(k2 * C2), 33n)) * C1))
      h2 = mod(mod(rotl(h2, 31n) + h1) * 5n + C4)   // 同上
      off += 16
    } else if (len === 0) {
      h1 = mod(h1 ^ BigInt(processed)); h2 = mod(h2 ^ BigInt(processed))
      h1 = mod(h1 + h2); h2 = mod(h2 + h1)
      h1 = fmix64(h1); h2 = fmix64(h2)
      h1 = mod(h1 + h2); h2 = mod(h2 + h1)
      return h1.toString(16) + h2.toString(16)
    } else {
      let k1 = 0n, k2 = 0n
      if (len >= 15) k2 ^= BigInt(bytes[off + 14]) << 48n
      if (len >= 14) k2 ^= BigInt(bytes[off + 13]) << 40n
      if (len >= 13) k2 ^= BigInt(bytes[off + 12]) << 32n
      if (len >= 12) k2 ^= BigInt(bytes[off + 11]) << 24n
      if (len >= 11) k2 ^= BigInt(bytes[off + 10]) << 16n
      if (len >= 10) k2 ^= BigInt(bytes[off + 9]) << 8n
      if (len >= 9) { k2 ^= BigInt(bytes[off + 8]); h2 = mod(h2 ^ mod(mod(rotl(mod(k2 * C2), 33n)) * C1)) }
      if (len >= 8) k1 ^= BigInt(bytes[off + 7]) << 56n
      if (len >= 7) k1 ^= BigInt(bytes[off + 6]) << 48n
      if (len >= 6) k1 ^= BigInt(bytes[off + 5]) << 40n
      if (len >= 5) k1 ^= BigInt(bytes[off + 4]) << 32n
      if (len >= 4) k1 ^= BigInt(bytes[off + 3]) << 24n
      if (len >= 3) k1 ^= BigInt(bytes[off + 2]) << 16n
      if (len >= 2) k1 ^= BigInt(bytes[off + 1]) << 8n
      if (len >= 1) { k1 ^= BigInt(bytes[off]); h1 = mod(h1 ^ mod(mod(rotl(mod(k1 * C1), 31n)) * C2)) }
      off += len   // 尾块算完要继续走一遍 len===0 那轮收尾（参考实现的循环是这样）
    }
  }
  return h1.toString(16) + h2.toString(16)
}
/** B站 的 _uuid 形状（照抄 network.py:1607 gen_uuid_infoc：可选 token 里含 "10" 这个双字符项，所以段长会浮动） */
export function __genUuidInfoc(nowMs = Date.now()) {
  const t = String(nowMs % 100000).padStart(5, '0')
  const pool = ['1','2','3','4','5','6','7','8','9','A','B','C','D','E','F','10']
  const part = (n) => Array.from({ length: n }, () => pool[Math.floor(Math.random() * pool.length)]).join('')
  return [8, 4, 4, 4, 12].map(part).join('-') + t + 'infoc'
}
/** 把模板里的两个动态位换掉（其余字节一律不动，保住指纹结构） */
export function __gaiaBody(tpl, uuid, tsMs) {
  return String(tpl).replace(/__UUID__/g, uuid).replace(/__TS__/g, String(Number(tsMs) || Date.now()))
}

/** WBI 签名用的重排表（照抄 bilibili-api-python 的 OE，utils/network.py:1509） */
const MIXIN_TAB = [46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52]
/** 会话顶部那六份能力说明书（kebab-case，注册表要求） */
const SKILL_NAMES = ['bili-search', 'bili-watch-frames', 'bili-comment', 'bili-comment-reply', 'bili-dm-read', 'bili-dm-send', 'bili-ledger']
/** 凭证自动导入的来源（并存使用时省一次扫码） */
const CRED_IMPORT_SOURCES = ['../bili-duty', '../../bili-duty']

const DEFAULTS = {
  home: '', requestTimeoutMs: 12000, maxBytes: 262144, framesDefault: 3,
  autoImportCredential: true, uidTtlDays: 7, logLevel: 'info', watchSkills: false, gaia: false,
}

/** patch config + 家里 config.json 的合并（家里优先；空值不覆盖 —— 与 bili-scroll 同一口径） */
function loadCfg(raw) {
  const out = { ...DEFAULTS }
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  for (const k of Object.keys(DEFAULTS)) if (k in src) out[k] = coerce(k, src[k])
  try {
    const f = path.join(dirOf(out.home), 'config.json')
    const j = JSON.parse(fs.readFileSync(f, 'utf8'))
    for (const k of Object.keys(DEFAULTS)) if (j && typeof j === 'object' && k in j && j[k] !== '' && j[k] != null) out[k] = coerce(k, j[k])
  } catch { /* 没有就用 patch/默认 */ }
  return out
}
function coerce(k, v) {
  if (k === 'home') return typeof v === 'string' ? v.trim() : DEFAULTS.home
  if (k === 'logLevel') return ['silent', 'info', 'debug'].includes(String(v)) ? String(v) : 'info'
  // 布尔开关必须排在数值处理之前：Number(false)=0 会被下面那句当成非法值、退回默认 true（本机实测栽过）
  if (k === 'autoImportCredential' || k === 'watchSkills' || k === 'gaia') return !!v
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return DEFAULTS[k]
  if (k === 'requestTimeoutMs') return Math.max(1000, Math.min(120000, Math.round(n)))
  if (k === 'maxBytes') return Math.max(4096, Math.min(4194304, Math.round(n)))
  if (k === 'framesDefault') return Math.max(1, Math.min(12, Math.round(n)))
  if (k === 'uidTtlDays') return Math.max(1, Math.min(90, Math.round(n)))
  return n
}
function dirOf(p) { return p && String(p).trim() ? String(p).trim() : path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'bili-base') }

export function apply(ctx, config = {}) {
  const cfg = loadCfg(config)
  const home = dirOf(cfg.home)
  const credFile = path.join(home, 'bili_credential.json')
  const uidFile = path.join(home, 'uid-cache.json')
  const ledgerDir = path.join(home, 'ledger')
  const framesDir = path.join(home, 'frames')
  const logFile = path.join(home, 'base.log')
  for (const d of [home, ledgerDir, framesDir]) { try { fs.mkdirSync(d, { recursive: true }) } catch { /* 有了 */ } }

  const log = (m) => {
    try { fs.appendFileSync(logFile, `${new Date().toISOString()}  ${m}\n`, 'utf8') } catch { /* 日志写不进也别炸 */ }
    if (cfg.logLevel !== 'silent') { try { ctx.logger?.[cfg.logLevel === 'debug' ? 'debug' : 'info']?.(`[bili-base] ${m}`) } catch { /* 没 logger 就算了 */ } }
  }
  const note = (m) => { if (cfg.logLevel === 'debug') log(m) }

  // ───────────────────────── 凭证与身份 ─────────────────────────
  const readCred = () => { try { const j = JSON.parse(fs.readFileSync(credFile, 'utf8')); return j && typeof j === 'object' ? j : null } catch { return null } }
  const writeCred = (c) => {
    const tmp = `${credFile}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(c, null, 2), 'utf8')
    fs.renameSync(tmp, credFile)
    try { fs.chmodSync(credFile, 0o600) } catch { /* Windows 上是摆设，不报错就够 */ }
  }
  const cookieHeader = __cookieHeader   // 见文件底部（挪到模块级是为了让它能被离线自检直接测到）
  const importCred = () => {
    for (const rel of CRED_IMPORT_SOURCES) {
      const f = path.resolve(home, rel, 'bili_credential.json')
      if (!fs.existsSync(f)) continue
      try {
        const j = JSON.parse(fs.readFileSync(f, 'utf8'))
        if (!j?.sessdata) continue
        writeCred({ sessdata: j.sessdata, bili_jct: j.bili_jct, buvid3: j.buvid3, dedeuserid: j.dedeuserid })
        log(`凭证从别处抄来一份：${f}（省一次扫码；之后两边各自独立）`)
        return true
      } catch { /* 坏文件跳过 */ }
    }
    return false
  }
  let cred = readCred()
  if (!cred?.sessdata && cfg.autoImportCredential) { importCred(); cred = readCred() }

  // Gaia（B站 的风控/AI 审核网关）：参考实现每次请求前会 spi 取新指纹 → POST ExClimbWuzhi 上报 →
  // 之后请求都用**这对现取的 buvid**。逐变量隔离 + 2×2 实测：评论被判 state 17 / attr 0x620000 的**决定因素是
  // Referer 的尾斜杠**（'https://www.bilibili.com/' 会被标记，去掉 '/' 就 attr 0），上报本身对这件事不是必需的；
  // ⇒ 默认关掉它（gaia: false，省两次网络往返）；config 里写 gaia: true 可打开（参考实现每次都做，本机没测出收益）。
  const gaiaFile = path.join(home, 'gaia-state.json')
  const gaiaTplFile = path.join(here, 'gaia', 'payload-template.txt')
  let gaia = null
  try { const j = JSON.parse(fs.readFileSync(gaiaFile, 'utf8')); if (j?.buvid3) gaia = j } catch { /* 没上报过 */ }
  const withGaiaBuvid = (c) => (gaia?.buvid3 ? { ...c, buvid3: gaia.buvid3, buvid4: gaia.buvid4 || c?.buvid4 } : c)
  let gaiaInflight = null
  async function ensureGaia(force = false) {
    if (!cfg.gaia) return { ok: false, why: '配置里 gaia 是关的' }
    let tpl = ''
    try { tpl = fs.readFileSync(gaiaTplFile, 'utf8') } catch { log('⚠️ 缺 gaia/payload-template.txt，跳过指纹上报（评论容易被 AI 审核降级）'); return { ok: false, why: '没有指纹模板' } }
    if (!force && gaia?.ok && Date.now() - Number(gaia.at || 0) < 12 * 3600_000) return { ok: true, cached: true }
    if (gaiaInflight) return gaiaInflight
    gaiaInflight = (async () => {
      try {
        const spi = await rawCall('https://api.bilibili.com/x/frontend/finger/spi', { headers: { 'user-agent': GAIA_UA, referer: GAIA_REFERER }, cookies: '' })
        const b3 = spi.json?.data?.b_3
        const b4 = spi.json?.data?.b_4 || ''
        if (!b3) throw new Error(`spi 没回 b_3（http=${spi.status}）`)
        const uuid = __genUuidInfoc()
        const body = __gaiaBody(tpl, uuid, Date.now())
        const fp = __murmur3x64128Hex(body, 31)
        const r = await rawCall('https://api.bilibili.com/x/internal/gaia-gateway/ExClimbWuzhi', {
          method: 'POST', body, rawBody: true, contentType: 'application/json',
          headers: { 'user-agent': GAIA_UA, referer: GAIA_REFERER, 'content-type': 'application/json' },
          cookies: `buvid3=${b3}; buvid4=${b4}; buvid_fp=${fp}; _uuid=${uuid}`,
        })
        const code = r.json?.code
        if (code !== 0) throw new Error(`ExClimbWuzhi 回 code=${code} ${String(r.json?.message || r.json?.msg || r.text || '').slice(0, 80)}`)
        gaia = { ok: true, at: Date.now(), buvid3: b3, buvid4: b4, uuid, fp }
        try { fs.writeFileSync(gaiaFile, JSON.stringify(gaia, null, 2), 'utf8') } catch { /* 存不下就算了 */ }
        log('Gaia 指纹上报完成（spi → ExClimbWuzhi；之后的请求改用现取的 buvid3）')
        return { ok: true }
      } catch (e) {
        log(`⚠️ Gaia 指纹上报没成功（写接口容易被 AI 审核降级）：${String(e?.message || e).slice(0, 160)}`)
        return { ok: false, why: String(e?.message || e).slice(0, 140) }
      } finally { gaiaInflight = null }
    })()
    return gaiaInflight
  }

  // ───────────────────────── 通用 API 通道 ─────────────────────────
  const qs = (o) => Object.entries(o).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&')
  const md5 = (s) => crypto.createHash('md5').update(s, 'utf8').digest('hex')

  async function rawCall(url, { method = 'GET', body, headers = {}, cookies = null, rawBody = false, contentType = '' } = {}) {
    const c = readCred()
    const h = { 'user-agent': UA, referer: REFERER, accept: 'application/json, text/plain, */*', ...headers }
    const ck = cookies != null ? cookies : cookieHeader(withGaiaBuvid(c))
    if (ck) h.cookie = ck
    const init = { method, headers: h, redirect: 'manual' }
    if (body != null) {
      // 顺序很关键：先补 csrf 再序列化（以前是先 new URLSearchParams(body) 才往 body 上加 csrf，
      // 加的对象已经没人用了 ⇒ POST 一律 -111「CSRF 校验失败」，本机 2026-10-26 实测撞过）
      init.body = rawBody ? String(body) : new URLSearchParams(__withCsrf(body, c)).toString()
      init.headers['content-type'] = contentType || 'application/x-www-form-urlencoded'
    }
    const ctl = new AbortController()
    const t = setTimeout(() => ctl.abort(), cfg.requestTimeoutMs)
    init.signal = ctl.signal
    try {
      const res = await fetch(url, init)
      const text = await res.text()
      const cap = text.length > cfg.maxBytes ? `${text.slice(0, cfg.maxBytes)}…[截断 ${(text.length - cfg.maxBytes).toLocaleString('en')} 字符]` : text
      let json = null
      try { json = JSON.parse(cap) } catch { /* 不是 JSON（HTML 风控页 / 二进制） */ }
      return { status: res.status, ct: res.headers.get('content-type') || '', json, textLen: text.length, raw: json ? undefined : cap }
    } finally { clearTimeout(t) }
  }

  let mixinCache = { key: '', at: 0 }
  async function wbiMixinKey() {
    const now = Date.now()
    if (mixinCache.key && now - mixinCache.at < 10 * 60_000) return mixinCache.key
    const r = await rawCall('https://api.bilibili.com/x/web-interface/nav')
    const img = r.json?.data?.wbi_img
    if (!img?.img_url || !img?.sub_url) throw new Error(`拿不到 wbi_img（nav 回 code=${r.json?.code}）—— 需要先有 buvid3 或换 UA`)
    const base = (u) => String(u).split('/').pop().split('.')[0]
    const ae = base(img.img_url) + base(img.sub_url)
    let le = ''
    for (const i of MIXIN_TAB) if (i < ae.length) le += ae[i]
    mixinCache = { key: le.slice(0, 32), at: now }
    note(`wbi mixin key 已刷新（${mixinCache.key.slice(0, 6)}…）`)
    return mixinCache.key
  }
  async function signWbi(params) {
    const key = await wbiMixinKey()
    const p = { ...params }
    delete p.w_rid
    p.wts = Math.floor(Date.now() / 1000)
    if (p.web_location == null) p.web_location = 1550101
    const query = qs(Object.fromEntries(Object.entries(p).sort((a, b) => a[0] < b[0] ? -1 : 1)))
    p.w_rid = md5(query + key)
    note('这次调用签了 wbi')
    return p
  }

  async function call({ path: p, method = 'GET', params = {}, body = null, sign = false, headers = null, cookies = null } = {}) {
    if (method === 'POST' && cfg.gaia) { try { await ensureGaia() } catch { /* 上报失败也别拦业务请求 */ } }
    let q = { ...params }
    if (sign) { try { q = await signWbi(q) } catch (e) { log(`wbi 签名失败，改成不签继续：${String(e?.message || e).slice(0, 160)}`) } }
    // 相对路径 = api.bilibili.com 下；也允许直接给 https://<某子域>.bilibili.com/... 的整条 URL
    const rel0 = String(p || '').trim()
    const rel = rel0.startsWith('//') ? 'https:' + rel0 : rel0   // B站 返回的资源地址常常是 //host/path 这种协议相对址
    const abs = /^https?:\/\//i.test(rel)
    const url = abs ? rel : `https://api.bilibili.com${rel.startsWith('/') ? rel : `/${rel}`}${Object.keys(q).length ? `?${qs(q)}` : ''}`
    const r = await rawCall(abs && Object.keys(q).length ? `${url}${url.includes('?') ? '&' : '?'}${qs(q)}` : url, { method, body, headers, cookies })
    if (r.json == null) return { ok: false, code: r.status, message: `不是 JSON 响应（content-type=${r.ct || '未知'}）${r.raw ? `：${String(r.raw).slice(0, 200)}` : ''}`, data: null }
    const u = __unwrapResponse(r.json, r.status)
    if (!u.ok && u.code === -403) { mixinCache = { key: '', at: 0 }; note('回 -403 ⇒ mixin key 作废，下次重签') }
    return u
  }

  async function whoami() {
    const r = await call({ path: '/x/web-interface/nav' })
    const d = r.data ?? {}
    return { ok: !!r.ok, loggedIn: !!d.isLogin, uid: d.mid ? String(d.mid) : null, uname: d.uname || null, face: d.face_url || null, level: d.vipStatus != null ? d.vipStatus : null, hasCredential: !!readCred()?.sessdata, message: r.ok ? (d.isLogin ? '凭证有效' : '接口通了但没登录（凭证缺失或已过期）') : r.message }
  }

  // ───────────────────────── 登录（passport 那两步） ─────────────────────────
  const loginStore = new Map()
  const pickCookies = (res) => {
    const out = {}
    for (const line of res.headers.getSetCookie ? res.headers.getSetCookie() : []) {
      const m = /^([^=]+)=([^;]*)/.exec(line)
      if (m) out[m[1].trim()] = decodeURIComponent(m[2])
    }
    return out
  }
  async function loginStart() {
    const r = await rawCall('https://passport.bilibili.com/x/passport-login/web/qrcode/generate?source=main-fe-header')
    const d = r.json?.data
    if (!d?.qrcode_key || !d?.url) throw new Error(`生成二维码失败：${r.json?.message || '返回里没有 qrcode_key'}`)
    loginStore.set(d.qrcode_key, { url: d.url, at: Date.now() })
    const png = path.join(home, 'tmp-qr.png')
    try { fs.mkdirSync(path.dirname(png), { recursive: true }) } catch { /* 有了 */ }
    return { key: d.qrcode_key, url: d.url, note: '手机 B站 → 我的 → 扫一扫；确认时选"记住我"那种长期登录。约 180 秒过期。' }
  }
  async function loginPoll(key) {
    if (!key) throw new Error('要传 bili_auth 之前给的 key')
    const res = await fetch(`https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=${encodeURIComponent(key)}`, { headers: { 'user-agent': UA, referer: REFERER }, redirect: 'manual', signal: AbortSignal.timeout(cfg.requestTimeoutMs) })
    let body = null
    try { body = await res.json() } catch { /* poll 有时回空体 */ }
    const d = body?.data
    const code = Number(d?.code ?? body?.code ?? 0)
    if (code === 0) {
      const ck = pickCookies(res)
      const c = { sessdata: ck.sessdata || '', bili_jct: ck.bili_jct || '', buvid3: ck.buvid3 || '', dedeuserid: ck.DedeUserID || '' }
      if (!c.sessdata) return { state: 'scanned', code, message: '扫码了但响应里没有 sessdata —— 重试一次或改用别处凭证' }
      writeCred(c)
      cred = c
      loginStore.delete(key)
      const w = await whoami()
      log(`登录成功：${w.uname}（uid ${w.uid}）`)
      return { state: 'ok', code, credential: { sessdata: 'set', bili_jct: 'set', buvid3: 'set', dedeuserid: c.dedeuserid }, whoami: w }
    }
    if (code === 86038) return { state: 'expired', code, message: '二维码已过期，重新 start 一张' }
    if (code === 86090) return { state: 'scanned', code, message: '已扫码、等手机上点确认' }
    return { state: 'waiting', code, message: d?.message || body?.message || '还没扫' }
  }

  async function resolveUid(nameWanted) {
    const cache = (() => { try { return JSON.parse(fs.readFileSync(uidFile, 'utf8')) } catch { return {} } })()
    const hit = cache[nameWanted]
    const ttlMs = cfg.uidTtlDays * 86400_000
    if (hit && Date.now() - (hit.at || 0) < ttlMs) return { uid: hit.uid, uname: hit.uname, from: 'cache' }
    const r = await call({ path: '/x/web-interface/wbi/search/type', sign: true, params: { search_type: 'bili_user', keyword: nameWanted, page: 1 } })
    const list = Array.isArray(r.data?.result) ? r.data.result : []
    const strip = (s) => String(s || '').replace(/<[^>]+>/g, '')
    const exact = list.find((u) => strip(u.uname) === nameWanted) || list[0]
    if (!exact) return { uid: null, uname: nameWanted, from: 'search', message: `搜不到叫「${nameWanted}」的账号（code=${r.code} ${r.message}）` }
    const rec = { uid: String(exact.mid), uname: strip(exact.uname), at: Date.now() }
    cache[nameWanted] = rec
    try { fs.writeFileSync(uidFile, JSON.stringify(cache, null, 2), 'utf8') } catch { /* 缓存写不进无所谓 */ }
    return { ...rec, from: 'search' }
  }

  // ───────────────────────── 画面帧（B站自带故事板，不解码视频） ─────────────────────────
  async function frames({ bvid, num, at }) {
    if (!bvid) throw new Error('要传 bvid')
    const v = await call({ path: '/x/web-interface/view', params: { bvid } })
    if (!v.ok) throw new Error(`视频信息读不到：code=${v.code} ${v.message}`)
    const cid = Number(v.data.cid)
    const duration = Number(v.data.duration) || 0
    const want = Math.max(1, Math.min(12, Number(num) || cfg.framesDefault))
    const snap = await call({ path: '/x/player/videoshot', params: { bvid, cid, p: 1 } })
    const imgs = Array.isArray(snap.data?.image) ? snap.data.image : []
    const ts = Array.isArray(snap.data?.ts) ? snap.data.ts : []
    if (!imgs.length) {
      return { ok: false, message: `这条视频没有故事板帧（videoshot 回 code=${snap.code} ${snap.message}）—— 只有封面可用`, cover: v.data.pic, aid: v.data.aid, cid, duration }
    }
    const picks = []
    if (Array.isArray(at) && at.length) {
      for (const sec of at.slice(0, 12)) {
        let bi = -1, bd = Infinity
        ts.forEach((t, i) => { const d = Math.abs(Number(t) - Number(sec)); if (d < bd) { bd = d; bi = i } })
        if (bi >= 0 && imgs[bi]) picks.push({ sec: Number(sec), url: imgs[bi], ts: Number(ts[bi]) })
      }
    } else {
      const step = Math.max(1, Math.floor(imgs.length / want))
      for (let i = 0; i < imgs.length && picks.length < want; i += step) picks.push({ sec: Number(ts[i]), url: imgs[i], ts: Number(ts[i]) })
    }
    const files = []
    for (const [i, pk] of picks.entries()) {
      const url = String(pk.url).startsWith('http') ? pk.url : `https:${pk.url}`
      const r = await fetch(`${url.replace(/^https:/, 'https:')}${url.includes('?') ? '&' : '?'}referer=${encodeURIComponent(REFERER)}`, { headers: { 'user-agent': UA, referer: REFERER }, signal: AbortSignal.timeout(cfg.requestTimeoutMs) }).catch((e) => { log(`取帧失败 ${i}: ${String(e?.message || e).slice(0, 120)}`); return null })
      if (!r || !r.ok) continue
      const buf = Buffer.from(await r.arrayBuffer())
      const ext = /\.webp/i.test(url) ? 'webp' : /\.png/i.test(url) ? 'png' : 'jpg'
      const tsNum = Number(pk.ts ?? pk.sec)
      const tag = Number.isFinite(tsNum) ? String(Math.round(tsNum)).padStart(5, '0') : String(i).padStart(5, '0')
      const file = path.join(framesDir, `${bvid}-${tag}-${i}.${ext}`)
      fs.writeFileSync(file, buf)
      files.push({ at: pk.sec ?? pk.ts, path: file, bytes: buf.length })
    }
    log(`取帧 ${files.length}/${picks.length} 张（${bvid}，cid ${cid}，故事板共 ${imgs.length} 帧）`)
    return { ok: files.length > 0, title: v.data.title, up: v.data.owner?.name, cover: v.data.pic, aid: v.data.aid, cid, duration, storyboardFrames: imgs.length, frames: files, note: '帧已作为图片附件直接回给会话（模型接图片时当场可见，不必再叫别的工具分析）；frames/ 里同时留了一份文件，可给别人或别的插件看。' }
  }

  // ───────────────────────── 记账 ─────────────────────────
  const tableName = (t) => { const s = String(t || 'notes').trim().toLowerCase().replace(/[^a-z0-9_\u4e00-\u9fff-]/g, '-'); return s || 'notes' }
  const tableFile = (t) => path.join(ledgerDir, `${tableName(t)}.jsonl`)
  const readRows = (t) => { try { return fs.readFileSync(tableFile(t), 'utf8').split('\n').filter((l) => l.trim()).map((l) => { try { return JSON.parse(l) } catch { return { bad: l } } }) } catch { return [] } }
  const ledger = ({ action, table, rows, key, limit, removeKey }) => {
    const a = String(action || 'read')
    if (a === 'tables') { const out = []; try { for (const f of fs.readdirSync(ledgerDir)) if (f.endsWith('.jsonl')) out.push({ table: f.slice(0, -6), rows: readRows(f.slice(0, -6)).length }) } catch { /* 空目录 */ } return { ok: true, tables: out, dir: ledgerDir } }
    const t = tableName(table)
    if (a === 'append') {
      const list = Array.isArray(rows) ? rows : rows ? [rows] : []
      if (!list.length) throw new Error('append 要给 rows（对象或对象数组）')
      const existing = readRows(t)
      const keyField = key ? String(key) : null
      const have = new Set(keyField ? existing.map((r) => r?.[keyField]).filter(Boolean) : [])
      const added = []
      for (const r of list) {
        if (!r || typeof r !== 'object' || Array.isArray(r)) continue
        const rec = { ...r, at: r.at ?? new Date().toISOString() }
        if (keyField) { const kv = rec[keyField]; if (kv == null || kv === '' || have.has(kv)) continue; have.add(kv) }
        added.push(rec)
      }
      if (added.length) fs.appendFileSync(tableFile(t), added.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')
      log(`记账 ${t}：新增 ${added.length} 行（去重键 ${keyField || '无'}，跳过重复 ${list.length - added.length} 行）`)
      return { ok: true, table: t, added: added.length, skipped: list.length - added.length, file: tableFile(t) }
    }
    if (a === 'delete') {
      const all = readRows(t)
      const keep = all.filter((r) => r?.[key] !== removeKey)
      fs.writeFileSync(tableFile(t), (keep.length ? keep.map((r) => JSON.stringify(r)).join('\n') + '\n' : ''), 'utf8')
      return { ok: true, table: t, removed: all.length - keep.length, file: tableFile(t) }
    }
    const all = readRows(t)
    const n = Math.max(1, Math.min(500, Number(limit) || 50))
    return { ok: true, table: t, total: all.length, rows: all.slice(-n), file: tableFile(t) }
  }

  // ───────────────────────── 工具（只有这 4 只常驻声明） ─────────────────────────
  const render = (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }]
  // 输出 schema 只钉 ok / message 这两个必有字段、且不写 required：宿主会拿这份 schema **严格校验** execute 的返回值，
  // 而 uid / uname / data / rows / frames 这些都可能回 null 或自由形状 —— 给它们钉死 type 就会被判 "returned invalid output"。
  const outObj = () => ({ type: 'object', additionalProperties: true, properties: { ok: { type: 'boolean' }, message: { type: 'string' } } })
  const str = (description, required = false) => ({ type: 'string', ...(required ? { required: true } : {}), description })
  const defineTool = (options) => { // 宿主 defineTool 拿不到时的等价实现（本机今天实测就是走这条路）
    const chk = (s, w) => { if (!s || typeof s !== 'object') return; if (s.type === 'object' && s.additionalProperties === undefined) throw new Error(`defineTool(${options.name}): ${w} 是 object 却没写 additionalProperties`); for (const [k, v] of Object.entries(s.properties || {})) chk(v, `${w}.properties.${k}`) }
    chk(options.parameters, 'parameters'); chk(options.output?.schema, 'output.schema')
    return options
  }
  // 宿主的 schema 校验只认挂在 type:'object' 节点上的 properties / required / additionalProperties
  // （dsh-tools/lib/types/json-schema.js 的 allowedFor）—— 所以把 spec 里图省事的 per-property
  // required: true 统一提上来：参数表里的挪进 object 的 required 数组，非 object 节点上的直接摘掉。
  const sanitize = (node) => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return node
    const out = { ...node }
    if (out.type !== 'object') { delete out.required; delete out.properties; delete out.additionalProperties; if (out.items) out.items = sanitize(out.items); return out }
    const props = {}
    const req = Array.isArray(out.required) ? [...out.required] : []
    for (const [k, v] of Object.entries(out.properties || {})) {
      const child = v && typeof v === 'object' && !Array.isArray(v) ? { ...v } : { type: 'string', description: String(v ?? '') }
      if (child.required === true) { req.push(k); delete child.required } else if ('required' in child) delete child.required
      props[k] = sanitize(child)
    }
    out.properties = props
    if (req.length) out.required = req; else delete out.required
    if (out.additionalProperties === undefined) out.additionalProperties = true
    return out
  }
  const normSpec = (spec) => {
    const raw = spec.parameters && typeof spec.parameters === 'object' && !Array.isArray(spec.parameters) ? spec.parameters : {}
    const parameters = raw.type === 'object' ? sanitize(raw) : sanitize({ type: 'object', properties: raw, required: raw.required, additionalProperties: false })
    const output = spec.output && spec.output.schema ? { ...spec.output, schema: sanitize(spec.output.schema) } : { schema: { type: 'object', properties: {}, additionalProperties: true }, render }
    return { ...spec, parameters, output }
  }
  let registered = 0
  const tool = (spec) => {
    const s = normSpec(spec)
    // 宿主要求工具返回值是"无损 JSON"：NaN / Infinity 会被 JSON 改掉含义、BigInt 直接抛、undefined 会变 null
    // ⇒ 统一先过一遍 __lossless（本机 2026-10-26 实测：故事板没有 ts 时算出 NaN ⇒ "value is not lossless JSON"）
    try { ctx.tools.register(defineTool({ ...s, execute: async (args, exec) => __lossless(await s.execute(args, exec)) })); registered++ }
    catch (e) { log(`⚠️ 工具 ${spec.name} 注册失败：${e?.name || ''} ${String(e?.message || e).slice(0, 400)}`) }
  }
  log(`· 开始注册工具（home=${home} 凭证=${readCred()?.sessdata ? '有' : '无'}）`)

  tool({
    name: 'bili_auth',
    description: 'B站 登录与身份底座：action=status（登录状态/whoami）| start（出新二维码）| poll（查扫码结果，要 key）| import（从别处抄一份凭证，省一次扫码）| clear（删掉本机凭证）| uid（昵称 → UID，带缓存）。凭证是 4 个 cookie 字段，写在 bili-base 自己的家目录。',
    parameters: {
      action: str('status | start | poll | import | clear | uid', true),
      key: str('poll 用的 key（action=poll 时必填）'),
      name: str('要查 UID 的昵称（action=uid 时必填）'),
    },
    output: { schema: outObj() , render },
    execute: async (args) => {
      const a = String(args?.action || 'status')
      if (a === 'start') return { ok: true, ...await loginStart() }
      if (a === 'poll') return { ok: true, ...await loginPoll(args.key) }
      if (a === 'import') return { ok: importCred(), message: importCred() ? '已从别处抄来一份凭证' : '没找到可抄的凭证文件（试了 bili-duty 那两处）；那就 start + poll 扫一次码' }
      if (a === 'clear') { try { fs.rmSync(credFile) } catch { /* 本来就没有 */ } cred = null; return { ok: true, message: '已删掉本机凭证' } }
      if (a === 'uid') { const n = String(args?.name || '').trim(); if (!n) throw new Error('action=uid 要传 name'); return { ok: true, ...await resolveUid(n) } }
      const w = await whoami()
      return { ok: true, ...w, home, credentialFile: credFile, imported: !!readCred() }
    },
    presentCall: (args) => ({ card: 'generic', title: `bili_auth ${args?.action || 'status'}`, kind: 'execute', rawInput: args?.action || 'status' }),
  })

  tool({
    name: 'bili_api',
    description: '通用 B站 API 通道（底座的核心）：自动带 Cookie（Gaia 指纹上报后改用现取的 buvid）、POST 自动补 csrf+csrf_token、需要时做 WBI 签名（w_rid/wts）。path 是 api.bilibili.com 下的路径；返回原始 {code,message,data}（过大按 maxBytes 截断）。哪条能力该打哪个端点写在对应的 SKILL.md 里 —— 想加能力不必改本插件。',
    parameters: {
      path: str('要打的接口：以 / 开头 = api.bilibili.com 下的路径（例 /x/web-interface/view）；也可以给整条 URL（只认 bilibili.com / hdslb.com / bilivideo.com，字幕与图在 hdslb 上），// 开头的会自动补 https:', true),
      method: str('GET 或 POST，默认 GET'),
      params: { type: 'object', additionalProperties: true, description: 'query 参数（值会 urlencode）' },
      body: { type: 'object', additionalProperties: true, description: 'POST 的表单字段（csrf 自动补）' },
      sign: { type: 'boolean', description: '是否做 WBI 签名（搜索 / 部分 wbi 端点要）' },
      headers: { type: 'object', additionalProperties: true, description: '额外请求头（一般不用；排查风控/AI 审核时才拿来试 UA、referer、accept）' },
      cookies: { type: 'string', description: '整个覆盖 Cookie 头（只在照抄别的客户端形状时用来做对照实验）' }
    },
    output: { schema: outObj() , render },
    execute: async (args) => {
      const p = String(args?.path || '').trim()
      if (!__allowedUrl(p)) throw new Error('path 要么以 / 开头（打 api.bilibili.com），要么给整条 URL 且主机必须是 bilibili.com / hdslb.com / bilivideo.com（字幕和图都在 hdslb 上）—— 本工具不出 B站 域名')
      const r = await call({ path: p, method: args.method === 'POST' ? 'POST' : 'GET', params: args.params || {}, body: args.body || null, sign: !!args.sign, headers: args.headers || null, cookies: args.cookies == null ? null : String(args.cookies) })
      return { ok: r.ok, code: r.code, message: r.message, data: r.data }
    },
    presentCall: (args) => ({ card: 'generic', title: `bili_api ${args?.path || ''}`, kind: 'execute', rawInput: args?.path || '' }),
  })

  tool({
    name: 'bili_shot',
      description: '取这条视频的画面帧（用 B站 自带故事板 x/player/videoshot，不解码、不用 ffmpeg）：默认均匀取 framesDefault 张，传 at 就按秒贴最近帧。**帧直接当图片附件回给会话**（当前模型接图片就能当场看见，不必再叫别的工具分析）；同时也在 bili-base/frames/ 落一份文件并回路径。宿主没给附件服务、或模型不接图片时，退化成只回路径 + hint。⚠️ B站 常把整条视频拼成**一张缩略矩阵**一次给回：storyboardFrames 数的是返回的图数、不是画面格数，frames[].at 可能是 null。顺带回标题/UP/封面/cid/duration。',
    parameters: {
      bvid: str('BV号', true),
      num: { type: 'integer', description: '取几帧（1-12，默认取插件配置 framesDefault）' },
      at: { type: 'array', items: { type: 'number' }, description: '指定秒列表；不传就按时长均匀取' },
    },
      output: { schema: { type: 'object', properties: {}, additionalProperties: true }, render: (_a, v) => __renderWithImages(v) },
      execute: async (args, exec) => {
        try {
          const r = await frames(args)
          const imgs = (r.frames || []).map((f) => ({ buffer: fs.readFileSync(f.path), mediaType: /\.png$/i.test(f.path) ? 'image/png' : 'image/jpeg' }))
          const a = imgs.length ? await __attachImages((k) => ctx.get?.(k), exec, imgs) : { ok: false, reason: 'no_frames', hint: '这一条没有可附的帧' }
          return { ok: true, ...r, image_attached: a.ok, ...(a.ok ? { images: a.refs } : { image_skip_reason: a.reason, hint: a.hint }) }
      } catch (e) { return { ok: false, message: String(e?.message || e) } }
      },
    presentCall: (args) => ({ card: 'generic', title: `bili_shot ${args?.bvid || ''}`, kind: 'execute', rawInput: args?.bvid || '' }),
  })

  tool({
    name: 'bili_ledger',
    description: '记账底座：action=tables（列有哪些账本）| read（读，默认最后 50 行）| append（追加行，可按 key 字段去重）| delete（按 key 删一行）。每表一个 <表名>.jsonl，全在 bili-base/ledger/ 下。表名建议：seen（刷过）、comment（发过的评论）、dm（私信往来）、note（值得记的事）。',
    parameters: {
      action: str('tables | read | append | delete', true),
      table: str('表名（默认 notes；只留字母数字_和中文）'),
      rows: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'append 时要写的行（对象或对象数组）' },
      key: str('去重/定位用的字段名，例 bvid 或 rpid'),
      removeKey: { type: 'string', description: 'delete 时要删的那条 key 值' },
      limit: { type: 'integer', description: 'read 回多少行（默认 50）' },
    },
    output: { schema: outObj() , render },
    execute: async (args) => { try { return ledger(args) } catch (e) { return { ok: false, message: String(e?.message || e) } } },
    presentCall: (args) => ({ card: 'generic', title: `bili_ledger ${args?.action || 'read'} ${args?.table || ''}`, kind: 'execute', rawInput: args?.table || 'notes' }),
  })

  // ───────────────────────── 六份能力说明书（skills） ─────────────────────────
  const parseFront = (raw, where) => {
    const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(raw)
    if (!m) throw new Error(`bili-base: ${where} 没有 YAML frontmatter`)
    const meta = {}
    let key = null
    for (const line of m[1].split(/\r?\n/)) {
      const kv = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/.exec(line)
      if (kv) { key = kv[1]; meta[key] = kv[2].trim().replace(/^['"]|['"]$/g, '') }
      else if (key && /^\s+\S/.test(line)) meta[key] += ' ' + line.trim()
    }
    if (typeof meta.description !== 'string' || !meta.description) throw new Error(`bili-base: ${where} 缺 description`)
    return { name: meta.name, description: meta.description, whenToUse: meta.whenToUse || undefined, content: raw.slice(m[0].length).trim() }
  }
  const skillPath = (n) => { const over = path.join(home, 'skills', `${n}.md`); return fs.existsSync(over) ? { file: over, from: 'home' } : { file: path.join(here, 'skills', `${n}.md`), from: 'package' } }
  const candidates = []
  for (const n of SKILL_NAMES) {
    try {
      const { file, from } = skillPath(n)
      const s = parseFront(fs.readFileSync(file, 'utf8'), n)
      candidates.push({ name: s.name || n, description: s.description, ...(s.whenToUse ? { whenToUse: s.whenToUse } : {}), invocation: { modelInvocable: true, userInvocable: true }, provider: 'dsh-bili-base', source: from === 'home' ? 'override' : 'bundled', rank: 600, resourceBase: { kind: 'directory', path: path.dirname(file).split(path.sep).join('/') }, locator: file, from })
    } catch (e) { log(`⚠️ skill ${n} 没注册上：${String(e?.message || e).slice(0, 140)}`) }
  }
  // 目录 = 包内 skills/*.md 与家目录 skills/*.md 的并集（家目录那份赢）。
  // 每次 list() 现扫目录：新增/改名/改 frontmatter 都不必重启；但宿主注册表会缓存它收集到的目录、
  // 而且**没有 TTL**（dsh-skill：只有提供方调用 control.invalidate() 或运行时注册变化才清）
  // ⇒ 我监视这两个目录，一变就喊 invalidate，让"改 md"这件事真的当场生效。
  const collectNames = () => {
    const names = new Set(SKILL_NAMES)
    // 默认不监视任何东西（本地模型下"零后台"优先）；要热更目录把 config 里 watchSkills 开成 true
    for (const dir of [path.join(here, 'skills'), path.join(home, 'skills')]) {  // 目录永远现扫：家目录同名文件赢、新文件也算进来
      try { for (const f of fs.readdirSync(dir)) if (f.endsWith('.md')) names.add(path.basename(f, '.md')) } catch { /* 目录还没有 */ }
    }
    return [...names].sort()
  }
  const buildCandidates = () => {
    const out = []
    for (const n of collectNames()) {
      try {
        const { file, from } = skillPath(n)
        const s = parseFront(fs.readFileSync(file, 'utf8'), n)
        out.push({
          name: s.name || n,
          description: s.description,
          ...(s.whenToUse ? { whenToUse: s.whenToUse } : {}),
          invocation: { modelInvocable: true, userInvocable: true },
          provider: 'dsh-bili-base',
          source: from === 'home' ? 'override' : 'bundled',
          rank: 600,
          resourceBase: { kind: 'directory', path: path.dirname(file).split(path.sep).join('/') },
          locator: file,
          from,
        })
      } catch (e) { log('⚠️ skill ' + n + ' 没进目录：' + String(e?.message || e).slice(0, 140)) }
    }
    return out
  }
  const ledgerIndex = () => {
    try {
      const rows = fs.readdirSync(ledgerDir).filter((f) => f.endsWith('.jsonl')).map((f) => {
        const n = fs.readFileSync(path.join(ledgerDir, f), 'utf8').split('\n').filter((l) => l.trim()).length
        return f.slice(0, -6) + '=' + n
      })
      return rows.length ? rows.join(', ') : '（还没有账本）'
    } catch { return '（读不到账本目录）' }
  }
  const liveVersion = () => { try { return JSON.parse(fs.readFileSync(path.join(here, 'package.json'), 'utf8')).version } catch { return PKG.version } }
  const footerFor = (candidateName) => {
    const cred = readCred()
    return '\n\n## 本插件的底座（dsh-bili-base v' + liveVersion() + '）\n\n'
      + '**说明书只是指令，本身不带记忆。** 常驻工具 4 只：`bili_auth`（登录/身份/凭证）、`bili_api`（通用端点，自动 Cookie/CSRF/WBI）、`bili_shot`（取画面帧，落地给人或视觉插件看）、`bili_ledger`（记账：tables/read/append/delete，按 key 去重）。\n\n'
      + '**记忆在这儿**：家目录 ' + home + '\n'
      + '- 账本 ledger/：' + ledgerIndex() + ' —— 要看内容用 `bili_ledger {action:"read", table:"…", limit:N}`\n'
      + '- 凭证文件：' + (cred?.sessdata ? '在。但“登录与否”要用 `bili_auth {action:"status"}` 现查，这行只说明文件存在' : '不在 —— 先 `bili_auth {action:"start"}` 再 poll，或 `import` 从别处抄一份') + '\n'
      + '- 配置 ' + path.join(home, 'config.json') + '；日志 ' + logFile + '\n\n'
      + '**缓存边界**（改东西前该知道）：正文每次现读磁盘 ⇒ 改 md 的正文立刻生效；目录虽然也每次 list() 现扫，但宿主那份目录缓存没有 TTL、只有提供方喊 invalidate 才清，而默认我**不监视**文件（config 里 watchSkills 开 true 才监视）⇒ 新增/改名/换描述的说明书要等宿主重组才进目录，改正文不用。\n\n'
      + '**要改这份说明书**：编辑 ' + skillPath(candidateName).file + '（家目录放同名文件就顶掉包内那份，升级不冲）。\n'
  }
  const mkProvider = (control) => {
    let queued = false
    const bump = () => {
      if (queued || typeof control?.invalidate !== 'function') return
      queued = true
      setTimeout(() => {
        queued = false
        try { control.invalidate() } catch (e) { log('⚠️ 让 skill 目录失效失败：' + String(e?.message || e).slice(0, 120)) }
      }, 250)
    }
    const watchers = []
    // 默认不监视任何东西（本地模型下"零后台"优先）；要热更目录把 config 里 watchSkills 开成 true
    try { fs.mkdirSync(path.join(home, 'skills'), { recursive: true }) } catch { /* 建不了就算了：覆盖目录是给使用者放同名 md 用的，不该依赖监视开关 */ }
    for (const dir of (cfg.watchSkills ? [path.join(here, 'skills'), path.join(home, 'skills')] : [])) {
      try { fs.mkdirSync(dir, { recursive: true }) } catch { /* 已经有了 */ }
      try {
        watchers.push(fs.watch(dir, { persistent: false }, (ev, fname) => {
          if (!fname || !/\.md$/i.test(String(fname))) return
          log('检测到 skill 文件变化（' + ev + ' ' + fname + '）⇒ 让宿主的 skill 目录失效')
          bump()
        }))
      } catch (e) { log('⚠️ 监视 ' + dir + ' 失败（' + (e?.code || e?.message || '') + '）⇒ 新增/改名的 skill 要重组才进目录') }
    }
    return {
      name: 'dsh-bili-base',
      list: () => Promise.resolve(buildCandidates().map(({ locator, from, ...rest }) => ({ ...rest }))),
      async get(candidate) {
        const { file } = skillPath(candidate.name)
        const s = parseFront(fs.readFileSync(file, 'utf8'), candidate.name)
        return { ...candidate, invocation: { modelInvocable: true, userInvocable: true }, provider: 'dsh-bili-base', content: s.content + footerFor(candidate.name) }
      },
      close: () => { for (const w of watchers) { try { w.close() } catch { /* 已经关了 */ } } },
    }
  }
  let provider = null
  const offSkills = ctx.skills.registerProvider((control) => { provider = mkProvider(control); return provider })
  ctx.effect(() => () => {
    try { provider?.close?.() } catch { /* 已经关了 */ }
    if (typeof offSkills === 'function') offSkills()
  }, 'bili-base: skills provider')

  // ───────────────────────── 状态口（给排错/以后做 UI 用） ─────────────────────────
  const statusBody = () => ({ ok: true, plugin: 'bili-base', version: liveVersion(), home, loggedIn: !!readCred()?.sessdata, credentialFile: credFile, ledgerDir, framesDir: framesDir, logFile, skills: buildCandidates().map((c) => ({ name: c.name, from: c.from, source: c.source })), ledger: ledgerIndex(), config: cfg })
  ctx.inject(['webServer'], (w) => {
    const server = w.get('webServer')
    if (!server?.register) { log('⚠️ 没有 webServer，状态口没挂上（工具与 skill 不受影响）'); return }
    const off = server.register({
      kind: 'prefix', path: '/api/bili-base',
      handler: (req, res) => {
        const p = String(req.url || '').split('?')[0]
        if (req.method === 'GET' && (p === '/api/bili-base/status' || p === '/api/bili-base/')) { res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }).end(JSON.stringify(statusBody())); return }
        res.writeHead(404, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }).end('{"ok":false,"error":"no-route"}')
      },
    })
    w.effect(() => (typeof off === 'function' ? off : () => {}), 'bili-base: status route')
  })

  log(`已挂载（家=${home}，工具 ${registered}/4 只，skill ${buildCandidates().length} 份，凭证=${readCred()?.sessdata ? '有' : '无'}）`)
}
const PKG = JSON.parse(fs.readFileSync(path.join(here, 'package.json'), 'utf8'))