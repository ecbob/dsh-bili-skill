/**
 * dsh-bili-skill —— B站 能力的「底座」插件（纯 JS、零运行时依赖）
 *
 * 设计（2026-10-25）：base 只管四件事 —— ① 登录与凭证 ② 身份（昵称 ↔ UID）③ 一条带 Cookie/CSRF/WBI
 *   签名的通用 API 通道 ④ 取画面帧 + JSONL 记账。能力面（搜索筛选 / 看画面理解 / 评论 / 回评论 /
 *   读私信 / 写私信 / 记账）是**七份 SKILL.md**，按需加载 —— 常驻的工具声明只有 5 只，
 *   这正合本地模型「少声明、按需取说明书」的取向。没有值班轮、没有定时器、没有日报、没有专用 profile，
 *   也不碰别人的家目录；评论与私信都是拿使用者的号说话，本插件不自己决定发不发。
 *
 * 家目录（全在这一个目录里，删掉即彻底回滚）：
 *   $DSH_HOME/dsh-bili-skill/
 *     config.json              运行时配置（用的时候现读，优先于 patch config）
 *     bili_credential.json     sessdata / bili_jct / buvid3 / dedeuserid（四个 cookie 字段，与 bilibili-api-python 的 Credential 同形，可互抄）
 *     credential-source.json   凭证是哪来的（scan 自己扫的 / import 从别处抄的）
 *     uid-cache.json           昵称 → UID（带时间戳，TTL 7 天）
 *     gaia-state.json          现取指纹上报后的 buvid3/buvid4（撞风控自愈时才会写）
 *     ledger/<表名>.jsonl      记账（append-only，可按 key 去重）
 *     frames/<bvid>-…          取到的画面帧（临时物，bili_frames clear 默认删这些）
 *     frames/keep/<bvid>-…     值得长期留下的**单独一帧**（clear 默认不碰；配合 ledger/frame 记住为什么留）
 *     skills/<name>.md         使用者写的覆盖版说明书（同名即顶掉包内那份）
 *     tmp-qr/                  扫码登录的二维码图（每次 start 只留最新一张）
 *     status.json              状态快照（挂载即写一份、状态口每问即刷一份）
 *     base.log                 本插件自己的日志（含"这次调用签了 wbi / 用了哪份凭证 / 搬了家"）
 *
 * 拓展点（按便宜程度排序）：
 *   1) 改 `skills/<name>.md` —— 判入口径、端点清单、红线，全是 markdown
 *   2) 在家目录放 `skills/<name>.md` 顶掉包内那份 —— 升级不被冲（provider 每次现读磁盘）
 *   3) 在 `SKILL_NAMES` 里加一个名字 + 一个 md 文件 —— 多一个能力，不加工具
 *   4) 在 `TOOLS` 之下加一只 `ctx.tools.register(...)` —— 需要新原子操作时才动
 *
 * 只 import node: 内置（fs/path/os/crypto/url）+ 全局 fetch。不引 @deepseek-ai/*、不引 undici。
 * 「哪些代码是照谁写的、对照裁判是谁」写在 README 的「参考来源」一节，不在这里重复。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { shoot, clearFrames, listFrames, frameFileName } from './frames.js'
import { qrPng } from './qrpng.js'
import { qrPngVendor } from './qrvendor.js'

export const name = 'dsh-bili-skill'
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
/** 把帧存成宿主的图片附件；宿主没给服务或模型不接图片时退化成文字（这条契约是宿主实测出来的形状）。 */
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
      if (Array.isArray(m) && !m.includes('image')) return { ok: false, reason: 'model_no_image', hint: '模型 ' + provider + '/' + model + ' 不接图片输入（' + (m.join(', ') || '没声明') + '）=> 这次只回文件路径，当前模型不接图 => 我这边用 read_image 看，或让它以卡片形式贴给你扫' }
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
 * （本机 2026-10-26 撞实过，对照实验：同一份凭证在另一路已装实现里被判「已登录」，在我这儿 nav 一路回 -101）。
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
  autoImportCredential: true, uidTtlDays: 7, logLevel: 'info', watchSkills: false, gaia: false, ffmpegPath: '',                       // 空 = 自动找（DSH_BILI_FFMPEG → PATH → 家目录旁 .dsh/.build-tools/ffmpeg/ffmpeg.exe）
}

/** patch config + 家里 config.json 的合并（家里优先；空值不覆盖） */
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
// 家目录搬家：默认段名跟着包名走 ⇒ 首次启动按「由近到远」把还活着的旧名目录补进新家（已有的不覆盖、
// 标记文件不进新家），再把旧目录改名成 <旧名>.migrated-<UTC> 留档，绝不静默丢数据。
const LEGACY_HOME_NAMES = ['bili-skill', 'bili-base']   // 由近到远；新家 = 当前插件名（dirOf 的默认段）
const MARK_PREFIX = '.migrated-to-'                     // 旧壳里的「已搬走」标记（名字带去向）；见着任何一条就永不重搬这个壳
const OLD_DIR_RENAMED = (oldName, stamp) => oldName + '.migrated-' + stamp
/** 搬单个旧名目录；不存在 / 已搬过（壳里有 .migrated-to-* 标记）回 null。oldName 默认取最近那个旧名。 */
export function migrateOldHome(nextHome, baseDir, log, oldName = LEGACY_HOME_NAMES[0]) {
  const oldDir = path.join(baseDir, oldName)
  if (oldDir === nextHome || !fs.existsSync(oldDir)) return null
  const MARK = MARK_PREFIX + path.basename(nextHome)
  let marked = false
  try { marked = fs.readdirSync(oldDir).some((f) => String(f).startsWith(MARK_PREFIX)) } catch { marked = false }
  if (marked) return null   // 已经搬过（哪怕旧壳还在）就不再搬，也不重复报
  if (!fs.existsSync(nextHome)) fs.mkdirSync(nextHome, { recursive: true })
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14)
  let copied = 0, failed = 0
  const walk = (from, to, move) => {
    fs.mkdirSync(to, { recursive: true })
    for (const e of fs.readdirSync(from, { withFileTypes: true })) {
      const a = path.join(from, e.name), b = path.join(to, e.name)
      if (e.isDirectory()) { walk(a, b, move); continue }
      if (String(e.name).startsWith(MARK_PREFIX)) { continue }   // 标记文件本身不算搬运内容（留在旧壳/归档里）
      if (fs.existsSync(b)) continue
      try { if (move) fs.renameSync(a, b); else fs.copyFileSync(a, b); copied++ } catch { failed++ }
    }
  }
  try { fs.writeFileSync(path.join(oldDir, MARK), JSON.stringify({ to: nextHome, at: new Date().toISOString(), note: `插件已从旧名改名为 ${path.basename(nextHome)}；这份是搬家后留下的存档，插件不再往这里写` }), "utf8") } catch (e) { log("迁移：标记文件写不上（" + String(e?.code || e) + "），仍继续搬") }
  try { walk(oldDir, nextHome, false) } catch (e) { failed++; log("迁移：预复制出错 " + String(e?.message || e)) }   // 先把老家内容补进新家（不覆盖已有）
  let how = null
  try { fs.renameSync(oldDir, path.join(baseDir, OLD_DIR_RENAMED(oldName, stamp))); how = "rename-dir" } catch (e) { how = null; log("迁移：整目录改名不成（" + String(e?.code || e?.code === undefined ? "" : e.code) + String(e?.message || "").slice(0, 60) + "）⇒ 走退路") }
  if (how !== "rename-dir") {
    const arch = path.join(baseDir, OLD_DIR_RENAMED(oldName, stamp))
    try { walk(oldDir, arch, true) } catch (e) { failed++; log("迁移退路：搬内容时出错 " + String(e?.message || e)) }
    try { fs.rmSync(oldDir, { recursive: true, force: true }); if (!fs.existsSync(oldDir)) how = "move-contents" } catch (e) { how = "contents-moved-shell-left"; log("迁移退路：内容已挪走但旧壳删不掉（被占用），里面只剩标记文件，不影响新家") }
    if (how === "move-contents" || how === "contents-moved-shell-left") log("迁移退路：内容已挪进 " + path.basename(arch) + "/")
  }
  log(`改名迁移完成（${oldName} → ${path.basename(nextHome)}）：复制/挪动 ${copied} 个文件` + (failed ? "、失败 " + failed + " 个" : "") + "；方式=" + (how || "failed") + "；新家=" + nextHome)
  return { copied, failed, how }
}
/** 由近到远逐个搬：近的先把新数据占住，远的只补空缺。一次都没搬成回 null。 */
export function migrateLegacyHomes(nextHome, baseDir, log) {
  const out = []
  for (const oldName of LEGACY_HOME_NAMES) {
    if (path.join(baseDir, oldName) === nextHome) continue
    const r = migrateOldHome(nextHome, baseDir, log, oldName)
    if (r) out.push({ from: oldName, ...r })
  }
  return out.length ? out : null
}
function dirOf(p) { return p && String(p).trim() ? String(p).trim() : path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'dsh-bili-skill') }

export function apply(ctx, config = {}) {
  const cfg = loadCfg(config)
  const home = dirOf(cfg.home)
  // 入口先搬一次，不只等挂载（本机实测：新实例迟迟不挂载，期间直接用工具写账就已经分家了）；手动把 config.home 指到旧名目录的不搬
  if (!LEGACY_HOME_NAMES.includes(path.basename(home))) migrateLegacyHomes(home, path.dirname(home), (m) => { try { ctx.logger?.info?.(`[dsh-bili-skill] ${m}`) } catch { /* 没 logger 就算了 */ } })
  const credFile = path.join(home, 'bili_credential.json')
  const uidFile = path.join(home, 'uid-cache.json')
  const ledgerDir = path.join(home, 'ledger')
  const framesDir = path.join(home, 'frames')
  const logFile = path.join(home, 'base.log')
  for (const d of [home, ledgerDir, framesDir]) { try { fs.mkdirSync(d, { recursive: true }) } catch { /* 有了 */ } }
  /* 旧版本把二维码图丢在 frames 顶层（不进 frame 账、无清理归口）：搬到家目录 tmp-qr/，搬不动就删 */
  try {
    for (const f of fs.readdirSync(framesDir)) {
      if (!/^qr-.*\.png$/i.test(f)) continue
      const from = path.join(framesDir, f)
      const to = path.join(home, 'tmp-qr', f)
      try { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.renameSync(from, to) } catch { try { fs.rmSync(from) } catch { /* 算了 */ } }
    }
  } catch { /* frames 还没建 */ }

  // 要用的时候现读 config.json（本机实测：改完 ffmpegPath 后不重启、宿主也没重组，挂着的实例还拿旧值 ⇒ 高清帧验不通）
  const isTrue = (v) => v === true || v === 1 || (typeof v === "string" && /^(true|yes|on|1)$/i.test(v.trim()))   // 宿主实测把布尔序列化成字符串 "True"（首字母大写）⇒ 大小写无关才算对；别用 === true 硬比
  const liveCfg = () => { try { return { ...cfg, ...JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8')) } } catch { return cfg } }
  const log = (m) => {
    try { fs.appendFileSync(logFile, `${new Date().toISOString()}  ${m}\n`, 'utf8') } catch { /* 日志写不进也别炸 */ }
    if (cfg.logLevel !== 'silent') { try { ctx.logger?.[cfg.logLevel === 'debug' ? 'debug' : 'info']?.(`[dsh-bili-skill] ${m}`) } catch { /* 没 logger 就算了 */ } }
  }
  const note = (m) => { if (cfg.logLevel === 'debug') log(m) }

  // ───────────────────────── 凭证与身份 ─────────────────────────
  const readCred = () => { try { const j = JSON.parse(fs.readFileSync(credFile, 'utf8')); return j && typeof j === 'object' ? j : null } catch { return null } }
  /** 凭证是哪来的：import（从 bili-duty 抄的）还是 scan（自己扫的码）。文件 credential-source.json，读不到就当 unknown */
  let credSource = (() => { try { return JSON.parse(fs.readFileSync(path.join(home, 'credential-source.json'), 'utf8'))?.source || 'unknown' } catch { return 'unknown' } })()
  const writeCred = (c, source = 'scan') => {
    const tmp = `${credFile}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(c, null, 2), 'utf8')
    fs.renameSync(tmp, credFile)
    try { fs.chmodSync(credFile, 0o600) } catch { /* Windows 上是摆设，不报错就够 */ }
    /* 凭证是哪来的（import = 从 bili-duty 抄的 / scan = 自己扫的码）：status 要如实报，别再说 imported=文件存在 */
    try { fs.writeFileSync(path.join(home, 'credential-source.json'), JSON.stringify({ source, at: new Date().toISOString() }, null, 2) + '\n', 'utf8') } catch { /* 来源记不上，不拦写凭证 */ }
  }
  const cookieHeader = __cookieHeader   // 见文件底部（挪到模块级是为了让它能被离线自检直接测到）
  const importCred = () => {
    for (const rel of CRED_IMPORT_SOURCES) {
      const f = path.resolve(home, rel, 'bili_credential.json')
      if (!fs.existsSync(f)) continue
      try {
        const j = JSON.parse(fs.readFileSync(f, 'utf8'))
        if (!j?.sessdata) continue
        writeCred({ sessdata: j.sessdata, bili_jct: j.bili_jct, buvid3: j.buvid3, dedeuserid: j.dedeuserid }, 'import')
        log(`凭证从别处抄来一份：${f}（省一次扫码；之后两边各自独立）`)
        return true
      } catch { /* 坏文件跳过 */ }
    }
    return false
  }
  let cred = readCred()
  if (!cred?.sessdata && cfg.autoImportCredential) { if (importCred()) credSource = 'import'; cred = readCred() }

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
    // force=true 是「撞风控后的自愈上报」：就算 cfg.gaia 关着也要做 —— 默认关是为了省两次往返，不是禁止上报。
    if (!liveCfg().gaia && !force) return { ok: false, why: '配置里 gaia 是关的' }
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

  async function rawCall(url, { method = 'GET', body, headers = {}, cookies = null, rawBody = false, contentType = '', overrides = {} } = {}) {
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
    const t = setTimeout(() => ctl.abort(), liveCfg().requestTimeoutMs)
    init.signal = ctl.signal
    try {
      const res = await fetch(url, init)
      const text = await res.text()
      const maxB = Number.isFinite(Number(overrides?.maxBytesOverride)) ? Number(overrides.maxBytesOverride) : liveCfg().maxBytes   // 现读；override 只给自检用
      const cap = text.length > maxB ? `${text.slice(0, maxB)}…[截断 ${(text.length - maxB).toLocaleString('en')} 字符]` : text
      let json = null
      try { json = JSON.parse(cap) } catch { /* 不是 JSON（HTML 风控页 / 二进制） */ }
      return { status: res.status, ct: res.headers.get('content-type') || '', json, textLen: text.length, capUsed: maxB, raw: json ? undefined : cap }
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

  // 风控自愈：B站 的硬风控长三种样子 —— code -412（前置校验不过）、code -352（滑块/风控拦截）、
  // 或 code:0 但 data 里只有一个 v_voucher（验证挑战；本机就被"签名搜索只回 voucher"坑过一次）。
  // 撞上就现取 spi → 上报一次指纹 → 原样重试一次；**只重试一次**：连着撞还猛发只会把号送进风控。
  const isRisk = (u) => {
    if (!u) return false
    if (u.code === -412 || u.code === -352) return true
    const d = u.data
    return !!d && typeof d === 'object' && !Array.isArray(d) && typeof d.v_voucher === 'string' && !!d.v_voucher
  }

  async function call(args = {}) {
    const { path: p, method = 'GET', params = {}, body = null, sign = false, headers = null, cookies = null, riskRetried = false } = args
    if (method === 'POST' && cfg.gaia) { try { await ensureGaia() } catch { /* 上报失败也别拦业务请求 */ } }
    let q = { ...params }
    if (sign) { try { q = await signWbi(q) } catch (err) { log(`wbi 签名失败，改成不签继续：${String(err?.message || err).slice(0, 160)}`) } }
    // 相对路径 = api.bilibili.com 下；也允许直接给 https://<某子域>.bilibili.com/... 的整条 URL
    const rel0 = String(p || '').trim()
    const rel = rel0.startsWith('//') ? 'https:' + rel0 : rel0   // B站 返回的资源地址常常是 //host/path 这种协议相对址
    const abs = /^https?:\/\//i.test(rel)
    const url = abs ? rel : `https://api.bilibili.com${rel.startsWith('/') ? rel : `/${rel}`}${Object.keys(q).length ? `?${qs(q)}` : ''}`
    const r = await rawCall(abs && Object.keys(q).length ? `${url}${url.includes('?') ? '&' : '?'}${qs(q)}` : url, { method, body, headers, cookies })
    if (r.json == null) return { ok: false, code: r.status, message: `不是 JSON 响应（content-type=${r.ct || '未知'}）${r.raw ? `：${String(r.raw).slice(0, 200)}` : ''}`, data: null }
    const u = __unwrapResponse(r.json, r.status)
    if (!u.ok && u.code === -403) { mixinCache = { key: '', at: 0 }; note('回 -403 ⇒ mixin key 作废，下次重签') }
    if (!riskRetried && isRisk(u)) {
      const why = u.code === -412 ? '-412 前置校验不过' : u.code === -352 ? '-352 风控拦截' : '只回了 v_voucher（验证挑战）'
      let done = null
      try { done = await ensureGaia(true) } catch (err) { done = { ok: false, why: String(err?.message || err).slice(0, 120) } }
      if (!done?.ok) { log(`撞风控（${why}）但指纹上报没成功（${done?.why || '未知'}），不重试，把原样结果回给你`); return u }
      log(`撞风控（${why}）⇒ 已现取 spi 上报一次，原样重试一次（只试这一次，不循环）`)
      return await call({ ...args, riskRetried: true })
    }
    return u
  }

  async function whoami() {
    const r = await call({ path: '/x/web-interface/nav' })
    const d = r.data ?? {}
    // level 必须是真账号等级（nav 的 level_info.current_level）：先前我拿 vipStatus 当 level 回，本机 0.8.0 撞实 —— status 报 level:0，而评论回执里 current_level=2
    return { ok: !!r.ok, loggedIn: !!d.isLogin, uid: d.mid ? String(d.mid) : null, uname: d.uname || null, face: d.face_url || null, level: d.isLogin ? (d.level_info?.current_level ?? null) : null, vip_status: d.isLogin ? (d.vipStatus ?? null) : null, hasCredential: !!readCred()?.sessdata, message: r.ok ? (d.isLogin ? '凭证有效' : '接口通了但没登录（凭证缺失或已过期）') : r.message }
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
    /* 出二维码图：先用自研 qrpng（已用外部解码器 jsQR 逐字验通 v2..v10 × L/M/Q/H 四档；登录链接约 116..145 字节 ⇒ 落 v6/v7），
       它不成就回落到 vendored 参考实现（那条覆盖 v1..v40，长链接或超出我范围时兜底）。 */
    let qr = qrPng(d.url)
    if (!qr.ok) { const fb = qrPngVendor(d.url); if (fb.ok) { log(`自研 QR 没出图（${qr.why}），回落 vendored：${qr.message || ''}`); qr = { ...fb, fellback_from: qr.why } } }
    if (!qr.ok) qr = { ok: false, message: `两条路都没出图：自研 ${qr.why}；vendored ${qr.message || ''}` }
    let pngPath = null
    if (qr.ok) {
      /* 落在家目录的 tmp-qr/，不放 frames/：frames 是画面帧的管家目录（keep/clear 那套管），二维码混进去既不进 frame 账也没清理归口 */
      const qrDir = path.join(home, 'tmp-qr')
      fs.mkdirSync(qrDir, { recursive: true })
      pngPath = path.join(qrDir, 'qr-' + d.qrcode_key.slice(0, 16) + '.png')
      try { fs.writeFileSync(pngPath, qr.png) } catch (e) { log('二维码图存盘失败：' + String(e?.message || e)); pngPath = null }
      for (const f of fs.readdirSync(qrDir)) { if (f === path.basename(pngPath)) continue; try { fs.rmSync(path.join(qrDir, f)) } catch { /* 别人正拿着就别删 */ } }
    } else log('二维码图没出成：' + qr.message + '（照样回 url，你可以自己打开）')
    loginStore.set(d.qrcode_key + ':png', pngPath)
    return { key: d.qrcode_key, url: d.url, qr_png: qr.ok ? { path: pngPath, bytes: qr.png.length, dim: qr.dim, engine: qr.engine || 'qrpng(self)', ...(qr.fellback_from ? { fellback_from: qr.fellback_from } : {}) } : { failed: qr.message }, note: '手机 B站 → 我的 → 扫一扫；确认时选"记住我"那种长期登录。约 180 秒过期。图在 qr_png 那份（家目录 tmp-qr/，每次 start 只留最新一张）。' }
  }
  async function loginPoll(key) {
    if (!key) throw new Error('要传 bili_auth 之前给的 key')
    const res = await fetch(`https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=${encodeURIComponent(key)}`, { headers: { 'user-agent': UA, referer: REFERER }, redirect: 'manual', signal: AbortSignal.timeout(liveCfg().requestTimeoutMs) })
    let body = null
    try { body = await res.json() } catch { /* poll 偶尔回空体 */ }
    /* 关键（本机扫码实测）：外层 code 只表示"这次请求成功"，二维码的真实状态在 data.code：
       0=已确认成功（同时 6 条 set-cookie 落下 SESSDATA/bili_jct/DedeUserID/DedeUserID__ckMd5/sid/default_sites，
         并且 data.url 给一个 crossDomain 地址，网页流程要靠它把 cookie 撒到 .bilibili.com 各子域）
       86090=已扫码未确认，86038=已失效/过期。我先前读的是外层 code，于是三种状态全被当成成功。 */
    const d = body?.data
    /* 只认 data.code：外层 code=0 意思是"这次请求成功"，拿它兜底会把"没给内层码"误判成登录成功那一路 */
    const inner = Number(d?.code ?? -1)
    const noteByCode = { 0: '已确认登录', 86038: '二维码已失效（过期），重新 start 一张', 86090: '已扫码、等手机上点确认' }
    if (inner === 86038) return { state: 'expired', code: inner, message: d?.message || noteByCode[86038], raw_code_outer: body?.code }
    if (inner === 86090) return { state: 'scanned', code: inner, message: d?.message || noteByCode[86090] }
    if (inner !== 0) return { state: 'waiting', code: inner, message: d?.message || body?.message || '还没扫' }
    const ck = pickCookies(res)
    const c = { sessdata: ck.SESSDATA || ck.sessdata || '', bili_jct: ck.bili_jct || ck.BILI_JCT || '', buvid3: ck.buvid3 || '', dedeuserid: ck.DedeUserID || ck.dedeuserid || '' }
    if (!c.sessdata) return { state: 'scanned', code: inner, message: 'data.code 已是 0 但响应里没有 SESSDATA —— 再 poll 一次或用 refresh_token 那条路', refresh_token: d?.refresh_token || null }
    /* 补 crossDomain 那一步：跟着 data.url 走一遍，让 B站 把 cookie 撒到各子域（网页流程本就这么走） */
    let cross = null
    if (d?.url) {
      try {
        const cr = await fetch(d.url, { headers: { 'user-agent': UA, referer: REFERER, cookie: `SESSDATA=${encodeURIComponent(c.sessdata)}; bili_jct=${c.bili_jct}; DedeUserID=${c.dedeuserid}` }, redirect: 'follow', signal: AbortSignal.timeout(liveCfg().requestTimeoutMs) })
        cross = { status: cr.status, final_url: String(cr.url || '').slice(0, 120), ok: cr.ok }
      } catch (e) { cross = { failed: String(e?.message || e).slice(0, 90) } }
    }
    writeCred(c, 'scan')
    cred = c
    loginStore.delete(key)
    const w = await whoami()
    log(`扫码登录成功：${w.uname}（uid ${w.uid}）${cross && cross.ok ? '，crossDomain 已补' : ''}`)
    return { state: 'ok', code: inner, credential: { sessdata: 'set', bili_jct: 'set', buvid3: c.buvid3 || '(poll 没回 buvid3)', dedeuserid: c.dedeuserid }, refresh_token: d?.refresh_token || null, timestamp: d?.timestamp ?? null, crossdomain: cross, whoami: w }
  }
  async function resolveUid(nameWanted) {
    const cache = (() => { try { return JSON.parse(fs.readFileSync(uidFile, 'utf8')) } catch { return {} } })()
    const hit = cache[nameWanted]
    const ttlMs = liveCfg().uidTtlDays * 86400_000
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

  // ───────────────────────── 记账 ─────────────────────────
  const tableName = (t) => { const s = String(t || 'notes').trim().toLowerCase().replace(/[^a-z0-9_\u4e00-\u9fff-]/g, '-'); return s || 'notes' }
  const tableFile = (t) => path.join(ledgerDir, `${tableName(t)}.jsonl`)
  const readRows = (t) => { try { return fs.readFileSync(tableFile(t), 'utf8').split('\n').filter((l) => l.trim()).map((l) => { try { return JSON.parse(l) } catch { return { bad: l } } }) } catch { return [] } }
  /** 写之前把 ledger/ 补出来：家目录被人从外面删过（清场/回滚）时，append/delete 不该直接 ENOENT —— 本机 0.8.0 撞实过 */
  const ensureLedgerDir = () => { try { fs.mkdirSync(ledgerDir, { recursive: true }) } catch { /* 建不动就让写自己报错，别在这儿吞 */ } }
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
      if (added.length) { ensureLedgerDir(); fs.appendFileSync(tableFile(t), added.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8') }
      log(`记账 ${t}：新增 ${added.length} 行（去重键 ${keyField || '无'}，跳过重复 ${list.length - added.length} 行）`)
      return { ok: true, table: t, added: added.length, skipped: list.length - added.length, file: tableFile(t) }
    }
    if (a === 'delete') {
      const all = readRows(t)
      const keep = all.filter((r) => r?.[key] !== removeKey)
      ensureLedgerDir()
      fs.writeFileSync(tableFile(t), (keep.length ? keep.map((r) => JSON.stringify(r)).join('\n') + '\n' : ''), 'utf8')
      return { ok: true, table: t, removed: all.length - keep.length, file: tableFile(t) }
    }
    const all = readRows(t)
    const n = Math.max(1, Math.min(500, Number(limit) || 50))
    return { ok: true, table: t, total: all.length, rows: all.slice(-n), file: tableFile(t) }
  }

  // ───────────────────────── 工具（只有这 5 只常驻声明） ─────────────────────────
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
    description: 'B站 登录与身份底座：action=status（登录状态/whoami）| start（出新二维码）| poll（查扫码结果，要 key）| import（从别处抄一份凭证，省一次扫码）| clear（删掉本机凭证）| uid（昵称 → UID，带缓存）。凭证是 4 个 cookie 字段，写在 dsh-bili-skill 自己的家目录。',
    parameters: {
      action: str('status | start | poll | import | clear | uid', true),
      key: str('poll 用的 key（action=poll 时必填）'),
      name: str('要查 UID 的昵称（action=uid 时必填）'),
    },
    output: { schema: outObj() , render },
    execute: async (args, exec) => {
      const a = String(args?.action || 'status')
      if (a === 'start') {
        const r = await loginStart()
        if (!r.qr_png || r.qr_png.failed) return { ok: true, ...r }
        const p = r.qr_png.path
        if (!p) return { ok: true, ...r }
        let buffer = null
        try { buffer = fs.readFileSync(p) } catch { /* 刚写的就没了，算它不走 */ }
        const imgs = buffer ? [{ buffer, mediaType: 'image/png' }] : []
        const at = imgs.length ? await __attachImages((k) => ctx.get?.(k), exec, imgs) : { ok: false, reason: 'no_png' }
        return { ok: true, ...r, image_attached: at.ok, ...(at.ok ? { images: at.refs } : { image_skip_reason: at.reason, hint: at.hint }) }
      }
      if (a === 'poll') return { ok: true, ...await loginPoll(args.key) }
      if (a === 'import') return { ok: importCred(), message: importCred() ? '已从别处抄来一份凭证' : '没找到可抄的凭证文件（试了 bili-duty 那两处）；那就 start + poll 扫一次码' }
      if (a === 'clear') { try { fs.rmSync(credFile) } catch { /* 本来就没有 */ } cred = null; return { ok: true, message: '已删掉本机凭证' } }
      if (a === 'cfgdiag') {
        const lc = liveCfg()
        const probeUrl = 'https://api.bilibili.com/x/web-interface/card?mid=2'   // 拿一个常年存在的公共账号当截断探针（别写死使用者自己的 UID）
        const raw = await rawCall(probeUrl)
        const saved = lc.maxBytes
        return { ok: true, message: `config 现读自检 ⟨config.json=${fs.readFileSync(path.join(home, 'config.json'), 'utf8').replace(/\s+/g, ' ')} → 现读 maxBytes=${saved}（挂载快照 ${cfg.maxBytes}）｜探针：文本 ${raw.textLen} 字、实际用的上限 ${raw.capUsed}、截了吗 ${raw.capUsed < raw.textLen}⟩`, home, cfgFile: path.join(home, 'config.json'), live_maxBytes: saved, live_uidTtlDays: lc.uidTtlDays, mounted_maxBytes: cfg.maxBytes, probe_textLen: raw.textLen, probe_capUsed: raw.capUsed, probe_truncated: raw.capUsed < raw.textLen, cfgFileText: fs.readFileSync(path.join(home, 'config.json'), 'utf8') }
      }
      if (a === 'uid') { const n = String(args?.name || '').trim(); if (!n) throw new Error('action=uid 要传 name'); return { ok: true, ...await resolveUid(n) } }
      const w = await whoami()
      const srcNow = (() => { try { return JSON.parse(fs.readFileSync(path.join(home, 'credential-source.json'), 'utf8'))?.source || 'unknown' } catch { return 'unknown' } })()   // 现读：挂载时的快照会在扫码写入后仍然报 unknown
      return { ok: true, ...w, home, credentialFile: credFile, imported: srcNow === 'import', credentialSource: srcNow }
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
      cookies: { type: 'string', description: '整个覆盖 Cookie 头（只在照抄别的客户端形状时用来做对照实验）' },
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
    description: '取这条视频的画面帧：用 B站 自带故事板 x/player/videoshot 定位格子，再把那一格从整页拼图里**裁成单独一帧**（纯 JS 解 JPEG，不用 ffmpeg）。默认均匀取 framesDefault 张，传 at 就按秒贴最近格。**帧直接当图片附件回给会话**，接得住图片的模型当场看得见，不必再叫别的工具分析；frames/ 里同时留一份文件。本机实测的格子语义：每个分 P 有自己的 cid 与故事板，格子按约 5 秒一格从该 P 的 0 秒起铺、尾部补纯黑（10x10=100 格 ≈ 上限 500 秒）—— 所以返回值给 intervalSec / intervalBasis / grid / partDuration / partStart，at 是**相对那个 P 的起点**。宿主接不住图片、或模型不收图片时退化成只回路径 + hint。',
    parameters: {
      bvid: str('BV号', true),
      num: { type: 'integer', description: '取几帧（1-12，默认取插件配置 framesDefault）' },
      at: { type: 'array', items: { type: 'number' }, description: '要哪几秒（相对所选 P 的起点，就近贴格）；不传就在有内容的格里均匀取' },
      tiles: { type: 'array', items: { type: 'integer' }, description: '直接按格号点格（0 起，相对所选 P 的故事板）；与 at 同时给时格号优先 —— 想要某一格就别去换算秒，本机实测换算会贴错' },
      p: { type: 'integer', description: '哪个分 P；不给且给了 at 就自动选装得下这些秒的那段，否则取 P1' },
      hd: { type: 'boolean', description: 'true = 再用外部 ffmpeg 解视频流抽同一秒的高清帧（默认逐帧精确：-ss 放在 -i 之后；解不动才退回关键帧法），真口径以每帧回报的 hd.method 为准；没 ffmpeg 或抽不动就在 hd_error 里说明，仍回故事板裁的格子帧' },
    },
    output: { schema: { type: 'object', properties: {}, additionalProperties: true }, render: (_a, v) => __renderWithImages(v) },
    execute: async (args, exec) => {
      try {
        const r = await shoot({ call, log, framesDir, UA, REFERER, home, ffmpegPath: liveCfg().ffmpegPath, hd: isTrue(args?.hd), timeoutMs: liveCfg().requestTimeoutMs }, args || {})
        const imgs = (r.frames || []).map((f) => { const src = (f.hd && f.hd.path) || f.path; return { buffer: fs.readFileSync(src), mediaType: /\.png$/i.test(src) ? 'image/png' : 'image/jpeg' } })
        const a = imgs.length ? await __attachImages((k) => ctx.get?.(k), exec, imgs) : { ok: false, reason: 'no_frames', hint: '这一条没有可附的帧' }
        return { ok: true, ...r, image_attached: a.ok, ...(a.ok ? { images: a.refs } : { image_skip_reason: a.reason, hint: a.hint }) }
      } catch (e) { return { ok: false, message: String(e?.message || e) } }
    },
    presentCall: (args) => ({ card: 'generic', title: `bili_shot ${args?.bvid || ''}`, kind: 'execute', rawInput: args?.bvid || '' }),
  })

  tool({
    name: 'bili_frames',
    description: '管家目录 frames/ 里的画面帧：action=keep（把某几秒**裁成单独一帧长期留下**，存进 frames/keep/，不会被 clear 的默认范围删）| clear（删帧，默认只删临时取帧、不动 keep/）| list（有哪些、多少字节、哪些是留下的）。看到值得留的画面就 keep，并顺手记一行 ledger 的 frame 表；用完的临时帧 clear 收掉。',
    parameters: {
      action: str('keep | clear | list', true),
      bvid: str('keep 时必填：哪条视频的画面'),
      at: { type: 'array', items: { type: 'number' }, description: 'keep 时要留的秒（相对该 P 的起点，就近贴格）' },
      tiles: { type: 'array', items: { type: 'integer' }, description: 'keep 时直接按格号留哪几格（0 起，相对该 P）；比换算秒准，格号与 bili_shot 报出来的 tile 一一对应' },
      p: { type: 'integer', description: '哪个分 P（不给就按秒自动选，没给秒就取 P1）' },
      reason: str('keep 时写一句为什么值得留（出现在返回值里，方便落账）'),
      scope: str('clear 删哪一类：temp（默认，不动留下的帧）| keep | all'),
      olderThanDays: { type: 'integer', description: 'clear 只删早于这么多天生成的文件（默认不限）' },
      keepLast: { type: 'integer', description: 'clear 时至少保住最近这么多个文件不动（默认 0 = 按条件清干净）' },
      hd: { type: 'boolean', description: 'keep 时 true = 留高清解码帧（外部 ffmpeg 解视频流抽的，默认逐帧精确）而不是故事板格子帧；账本里 method 会写明是哪一种' },
    },
    output: { schema: { type: 'object', properties: {}, additionalProperties: true }, render: (_a, v) => __renderWithImages(v) },
    execute: async (args, exec) => {
      try {
        const act = String(args?.action || '').trim().toLowerCase()
        if (act === 'list') return listFrames(framesDir)
        if (act === 'clear') return clearFrames(framesDir, { scope: args?.scope || 'temp', olderThanDays: args?.olderThanDays, keepLast: args?.keepLast })
        if (act !== 'keep') return { ok: false, message: `action 只认 keep / clear / list，收到的是「${args?.action}」` }
        if (!args?.bvid) return { ok: false, message: 'keep 要 bvid（哪条视频的画面）' }
        const r = await shoot({ call, log, framesDir, UA, REFERER, home, ffmpegPath: liveCfg().ffmpegPath, hd: isTrue(args?.hd), timeoutMs: liveCfg().requestTimeoutMs }, args)
        if (!r.ok || !(r.frames || []).length) return { ok: false, message: `留帧没成功：${r.message || '一格都没裁出来'}`, detail: r }
        fs.mkdirSync(path.join(framesDir, 'keep'), { recursive: true })
        const kept = []
        for (const f of r.frames) {
          const stamp = (() => { const d = new Date(), q = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}${q(d.getMonth() + 1)}${q(d.getDate())}-${q(d.getHours())}${q(d.getMinutes())}${q(d.getSeconds())}` })()
          const to = path.join(framesDir, frameFileName(String(args.bvid), f.p, f.tile, f.at, 'jpg', true, stamp))
          const srcFile = (args.hd === true && f.hd && f.hd.path) ? f.hd.path : f.path
          let srcBytes = null
          try { srcBytes = fs.statSync(srcFile).size } catch { /* 量不到就用 shoot 报的字节数 */ }
          fs.copyFileSync(srcFile, to)
          kept.push({ ...f, file: `keep/${path.basename(to)}`, path: to, kept: true, bytes: srcBytes ?? f.bytes, width: (f.hd && f.hd.width) || f.width, height: (f.hd && f.hd.height) || f.height, marked: `第 ${f.tile} 格（P${f.p} ${f.at}~${f.atTo}s，格内平均亮度 ${f.lum ?? '?'}，留的是 ${f.hd ? 'ffmpeg 解出来的 ' + f.hd.width + 'x' + f.hd.height + ' 高清帧（按关键帧定位）' : '故事板格子帧 ' + f.width + 'x' + f.height}）` })
        }

          const rows = kept.map((f2) => ({ file: f2.file, bvid: String(args.bvid), p: f2.p, tile: f2.tile, at: f2.at, atTo: f2.atTo, lum: f2.lum ?? null, width: f2.width, height: f2.height, bytes: f2.bytes, method: f2.hd ? f2.hd.method : 'videoshot-crop', hd_stream: f2.hd ? f2.hd.stream : null, hd_error: f2.hd_error || null, pixels: f2.hd ? `${f2.hd.width}x${f2.hd.height}` : `${f2.width}x${f2.height}`, marked: f2.marked, reason: String(args.reason || '') }))
          let booked = null
          try { booked = ledger({ action: 'append', table: 'frame', key: 'file', rows }) } catch (e) { booked = { ok: false, message: String(e?.message || e) } }
        const imgs = kept.map((f) => ({ buffer: fs.readFileSync(f.path), mediaType: 'image/jpeg' }))
        const a = await __attachImages((k) => ctx.get?.(k), exec, imgs)
        return {
          ok: true, bvid: String(args.bvid), p: r.partIndex, part: r.part, partDuration: r.partDuration, partStart: r.partStart,
          intervalSec: r.intervalSec, intervalBasis: r.intervalBasis, grid: r.grid, kept, ledger: booked,
          ...(a.ok ? { image_attached: true, images: a.refs } : { image_attached: false, image_skip_reason: a.reason, hint: a.hint }),
          note: `已裁成单独一帧存在 frames/keep/（${kept.length} 张，framesClear 默认不碰）。${args.reason ? `理由：${args.reason}。` : ''}` +
            '与记账联动：已自动往 ledger/frame 追加（去重键 file），每行带 file/bvid/p/tile/at/atTo/lum/width/height/bytes/method/marked/reason —— marked 写的就是这一格被判定了什么。',
        }
      } catch (e) { return { ok: false, message: String(e?.message || e) } }
    },
    presentCall: (args) => ({ card: 'generic', title: `bili_frames ${args?.action || ''} ${args?.bvid || ''}`, kind: 'execute', rawInput: `${args?.action || ''} ${args?.bvid || ''}` }),
  })

  tool({
    name: 'bili_ledger',
    description: '记账底座：action=tables（列有哪些账本）| read（读，默认最后 50 行）| append（追加行，可按 key 字段去重）| delete（按 key 删一行）。每表一个 <表名>.jsonl，全在 dsh-bili-skill/ledger/ 下。表名建议：seen（刷过）、comment（发过的评论）、dm（私信往来）、note（值得记的事）。',
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
    if (!m) throw new Error(`dsh-bili-skill: ${where} 没有 YAML frontmatter`)
    const meta = {}
    let key = null
    for (const line of m[1].split(/\r?\n/)) {
      const kv = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/.exec(line)
      if (kv) { key = kv[1]; meta[key] = kv[2].trim().replace(/^['"]|['"]$/g, '') }
      else if (key && /^\s+\S/.test(line)) meta[key] += ' ' + line.trim()
    }
    if (typeof meta.description !== 'string' || !meta.description) throw new Error(`dsh-bili-skill: ${where} 缺 description`)
    return { name: meta.name, description: meta.description, whenToUse: meta.whenToUse || undefined, content: raw.slice(m[0].length).trim() }
  }
  const skillPath = (n) => { const over = path.join(home, 'skills', `${n}.md`); return fs.existsSync(over) ? { file: over, from: 'home' } : { file: path.join(here, 'skills', `${n}.md`), from: 'package' } }
  const candidates = []
  for (const n of SKILL_NAMES) {
    try {
      const { file, from } = skillPath(n)
      const s = parseFront(fs.readFileSync(file, 'utf8'), n)
      candidates.push({ name: s.name || n, description: s.description, ...(s.whenToUse ? { whenToUse: s.whenToUse } : {}), invocation: { modelInvocable: true, userInvocable: true }, provider: 'dsh-bili-skill', source: from === 'home' ? 'override' : 'bundled', rank: 600, resourceBase: { kind: 'directory', path: path.dirname(file).split(path.sep).join('/') }, locator: file, from })
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
          provider: 'dsh-bili-skill',
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
    return '\n\n## 本插件的底座（dsh-bili-skill v' + liveVersion() + '）\n\n'
      + '**说明书只是指令，本身不带记忆。** 常驻工具 5 只：`bili_auth`（登录/身份/凭证）、`bili_api`（通用端点，自动 Cookie/CSRF/WBI）、`bili_shot`（故事板定位 + 从拼图里裁成单独一帧，帧作为图片附件直接回会话）、`bili_frames`（keep/clear/list 管 `frames/`）、`bili_ledger`（记账：tables/read/append/delete，按 key 去重）。'
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
      name: 'dsh-bili-skill',
      list: () => Promise.resolve(buildCandidates().map(({ locator, from, ...rest }) => ({ ...rest }))),
      async get(candidate) {
        const { file } = skillPath(candidate.name)
        const s = parseFront(fs.readFileSync(file, 'utf8'), candidate.name)
        return { ...candidate, invocation: { modelInvocable: true, userInvocable: true }, provider: 'dsh-bili-skill', content: s.content + footerFor(candidate.name) }
      },
      close: () => { for (const w of watchers) { try { w.close() } catch { /* 已经关了 */ } } },
    }
  }
  let provider = null
  const offSkills = ctx.skills.registerProvider((control) => { provider = mkProvider(control); return provider })
  ctx.effect(() => () => {
    try { provider?.close?.() } catch { /* 已经关了 */ }
    if (typeof offSkills === 'function') offSkills()
  }, 'dsh-bili-skill: skills provider')

  // ───────────────────────── 状态口 + 状态快照 ─────────────────────────
  // 两条看现场的路，别混：宿主的 webServer 外面套了一层浏览器会话鉴权（dsh-client-connection），
  // query token 只在 GET / 与 GET /connect 两处认，其余路径（包括这条 /api/...）只认那份 dsh-auth-* cookie
  // ⇒ 命令行不带 cookie 打它是 401，那**不是**"路由没挂上"（本机 2026-10-26 实测：签一份 cookie 就回 200）。
  // 所以状态同时落一份家目录快照：判据不依赖 HTTP、不依赖鉴权，重启没挂载也有 base.log 之外的抓手。
  const statusFile = path.join(home, 'status.json')
  const statusBody = () => ({ ok: true, plugin: 'dsh-bili-skill', version: liveVersion(), home, loggedIn: !!readCred()?.sessdata, credentialFile: credFile, ledgerDir, framesDir: framesDir, logFile, statusFile, skills: buildCandidates().map((c) => ({ name: c.name, from: c.from, source: c.source })), ledger: ledgerIndex(), config: cfg })
  /** 把状态写成家目录的 status.json（原子：先 .tmp 再换名）；写不上也不许拦住状态口 */
  const writeStatusSnapshot = () => {
    const body = { ...statusBody(), at: new Date().toISOString() }
    try { fs.writeFileSync(statusFile + '.tmp', JSON.stringify(body, null, 2) + '\n', 'utf8'); fs.renameSync(statusFile + '.tmp', statusFile) }
    catch (e) { log('⚠️ status.json 没写上（' + String(e?.code || e?.message || e).slice(0, 120) + '）；状态口本身不受影响') }
    return body
  }
  writeStatusSnapshot()   // 挂载即落一份，不等人来问
  ctx.inject(['webServer'], (w) => {
    const server = w.get('webServer')
    if (!server?.register) { log('⚠️ 没有 webServer，状态口没挂上（工具、skill 与 status.json 快照都不受影响）'); return }
    const off = server.register({
      kind: 'prefix', path: '/api/dsh-bili-skill',
      handler: (req, res) => {
        const p = String(req.url || '').split('?')[0]
        if (req.method === 'GET' && (p === '/api/dsh-bili-skill/status' || p === '/api/dsh-bili-skill/')) { res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }).end(JSON.stringify(writeStatusSnapshot())); return }
        res.writeHead(404, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }).end('{"ok":false,"error":"no-route"}')
      },
    })
    w.effect(() => (typeof off === 'function' ? off : () => {}), 'dsh-bili-skill: status route')
  })

  log(`已挂载（家=${home}，工具 ${registered} 只，skill ${buildCandidates().length} 份，凭证=${readCred()?.sessdata ? '有' : '无'}）`)
}
const PKG = JSON.parse(fs.readFileSync(path.join(here, 'package.json'), 'utf8'))






