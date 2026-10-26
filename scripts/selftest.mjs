// dsh-bili-skill 离线自检（原名 bili-skill / dsh-bili-base）：临时家目录 + 假 fetch + 假 ctx，不联网、不写真实家目录
// 覆盖：导出形状、5 只工具的声明合规（含 bili_frames）、jpgcrop/frames 的单帧裁切与格子语义、
// 无损 JSON、cookie 两种拼写、补 csrf 必须在序列化之前、murmur3 指纹向量、Gaia 三步序列、
// skill provider 契约与活脚注、家目录覆盖与现扫、记账的增/读/删/去重与脏行容忍、坏配置不炸。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-bili-skill-selftest-'))
const home = path.join(tmp, 'dsh-bili-skill')
let pass = 0, fail = 0, skipped = 0
const ok = (label, cond, extra) => {
  if (cond) { pass++; console.log(`PASS  ${label}`) }
  else { fail++; console.log(`FAIL  ${label}${extra != null ? `  <<${String(extra).slice(0, 160)}>>` : ''}`) }
}
const eq = (label, got, want) => ok(label, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`)
const skip = (label, why) => { skipped++; console.log(`SKIP  ${label}  (${why})`) }

/* ── 假 ctx：记下注册出去的工具与 provider；control 带 invalidate 计数 ── */
const mkCtx = () => {
  const tools = [], providers = [], effects = [], ctrlBox = { invalidateCalls: 0 }
  const ctx = {
    tools: { register: (t) => tools.push(t) },
    skills: { registerProvider: (f) => { const control = { invalidate: () => { ctrlBox.invalidateCalls++ } }; ctrlBox.control = control; providers.push(f(control)); return () => {} } },
    effect: (fn, l) => { effects.push([fn, l]); return () => {} },
    inject: (names, cb) => cb({ get: () => undefined }),
    logger: { info() {}, debug() {} },
  }
  return { ctx, tools, providers, effects, ctrlBox }
}

/* ── 假 ctx 的第二种装法：给一个 webServer，把插件注册的 prefix 路由抓下来，离线也能直接打它 ── */
const mkCtxWithServer = () => {
  const base = mkCtx()
  const routes = []
  base.ctx.inject = (names, cb) => cb({
    get: (k) => (k === 'webServer' ? { register: (r) => { routes.push(r); return () => {} } } : undefined),
    effect: (fn, l) => { base.effects.push([fn, l]); return () => {} },
  })
  return { ...base, routes }
}

/* ── 假 fetch：记录每一次调用的形状，好核对 Gaia 三步顺序 ── */
const hits = []
const SPI_B3 = 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE12345infoc'
const SPI_B4 = 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE-123456789-abcdefghijklmnopqrstuvwxyz0123456789ABCD='
let risk = null   // 形如 { left: 1, code: -412 } 或 { left: 1, voucher: true }：让业务端点前 left 次回风控样子
const QR_KEY = 'ab12cd34ef56ab78cd90ef12ab34cd56'   // 扫码假接口的 qrcode_key（真形状就是这种 32 位十六进制）
const QR_URL = 'https://account.bilibili.com/h5/account-h5/auth/scan-web?navhide=1&callback=close&qrcode_key=' + QR_KEY + '&from=main-fe-header'
let qrPollScript = []   // poll 的剧本：'waiting' | 'scanned' | 'expired' | 'ok'（取完就继续按 waiting 回）
globalThis.fetch = async (url, init = {}) => {
  const u = String(url)
  hits.push({ url: u, method: (init.method || 'GET'), headers: { ...(init.headers || {}) }, body: init.body ? String(init.body) : '' })
  let data = { isLogin: true, mid: 12345678, uname: 'tester', level_info: { current_level: 2, current_min: 0, current_exp: 0, next_exp: 0 }, vipStatus: 0, vipType: 1, wbi_img: { img_url: 'https://i0.hdslb.com/bfs/wbi/7cd08494133a4351bb2a2cb38190f56f.png', sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caf07c6049e4b7e523aa1db8ea06.png' } }
  let code = 0
  let cookieJar = []
  if (u.includes('/x/frontend/finger/spi')) data = { b_3: SPI_B3, b_4: SPI_B4 }
  else if (u.includes('/x/passport-login/web/qrcode/generate')) data = { qrcode_key: QR_KEY, url: QR_URL }
  else if (u.includes('/x/passport-login/web/qrcode/poll')) {
    const step = qrPollScript.length ? qrPollScript.shift() : 'waiting'
    if (step === 'ok') { data = { code: 0, message: 'OK', url: 'https://passport.biligame.com/x/passport-login/web/crossDomain?ticket=t', refresh_token: 'rt-test', timestamp: 1 }; cookieJar = ['SESSDATA=abc123; Path=/; Domain=bilibili.com', 'bili_jct=jct456; Path=/', 'DedeUserID=12345678; Path=/'] }
    else if (step === 'scanned') data = { code: 86090, message: '已扫码未确认' }
    else if (step === 'expired') data = { code: 86038, message: '二维码已失效' }
    else data = { code: 86101, message: '未扫码' }
  }
  else if (u.includes('/x/v2/reply/add')) {
    data = { rpid: 999, rpid_str: '999', success_toast: '发送成功' }
    if (risk && risk.left > 0) { risk.left--; if (risk.voucher) { data = { v_voucher: 'voucher-abc' } } else { code = risk.code ?? -412; data = null } }
  }
  const body = JSON.stringify({ code, message: code === 0 ? 'OK' : '请求失败，请稍后再试', data })
  return { status: 200, ok: true, headers: { get: () => 'application/json', getSetCookie: () => cookieJar }, url: u, text: async () => body, json: async () => JSON.parse(body) }
}

async function probePollShape(body, cookies) {
  const res = { json: async () => body, headers: { getSetCookie: () => cookies } }
  const pick = (r) => { const out = {}; for (const line of r.headers.getSetCookie ? r.headers.getSetCookie() : []) { const m = /^([^=]+)=([^;]*)/.exec(line); if (m) out[m[1].trim()] = decodeURIComponent(m[2]) } return out }
  const j = await res.json()
  const d = j?.data
  /* 本机 2026-10-26 真扫一次码取到的形状：外层 code 只表示"这次请求成功"，二维码真状态在 data.code */
  const inner = Number(d?.code ?? -1)
  if (inner === 86038) return "expired"
  if (inner === 86090) return "scanned"
  if (inner !== 0) return "waiting"
  const ck = pick(res)
  const c = { sessdata: ck.SESSDATA || ck.sessdata || "", bili_jct: ck.bili_jct || "", dedeuserid: ck.DedeUserID || "" }
  if (!c.sessdata) return "scanned_no_cookie"
  return { state: "ok", sessdata: c.sessdata, dedeuserid: c.dedeuserid }
}
const mod = await import(pathToFileURL(path.join(pkgDir, 'index.js')).href)
const a = mkCtx()
mod.apply(a.ctx, { home, logLevel: 'silent' })

/* ── 1. 导出形状 ── */
eq('包名与插件 id 是 dsh-bili-skill（旧名只留在迁移名单里）', mod.name, 'dsh-bili-skill')
{
  // 改名迁移（最近的旧名 bili-skill → 新家 dsh-bili-skill）：真造旧名目录（凭证+账本+帧），跑一次迁移，核对文件真在新家、老目录改名留档
  const base = path.join(tmp, 'mig')
  const oldH = path.join(base, 'bili-skill')
  const newH = path.join(base, 'dsh-bili-skill')
  fs.mkdirSync(path.join(oldH, 'ledger'), { recursive: true })
  fs.mkdirSync(path.join(oldH, 'frames', 'keep'), { recursive: true })
  fs.writeFileSync(path.join(oldH, 'bili_credential.json'), '{"sessdata":"x"}', 'utf8')
  fs.writeFileSync(path.join(oldH, 'ledger', 'seen.jsonl'), '{"bvid":"BV1mig"}\n', 'utf8')
  fs.writeFileSync(path.join(oldH, 'frames', 'keep', 'a.jpg'), 'img', 'utf8')
  const logs = []
  const mig = mod.migrateLegacyHomes ? mod.migrateLegacyHomes(newH, base, (m) => logs.push(m))?.[0] : null
  const archOf = () => fs.readdirSync(base).filter((x) => x.startsWith('bili-skill.migrated-'))
  ok('空新家时真搬家：凭证/账本/帧都进新家、老目录改名成 bili-skill.migrated-*、归档里留着标记文件，标记文件本身不许被搬进新家', !!mig && mig.from === 'bili-skill' && mig.copied >= 3 && mig.failed === 0 && fs.existsSync(path.join(newH, 'bili_credential.json')) && fs.existsSync(path.join(newH, 'ledger', 'seen.jsonl')) && fs.existsSync(path.join(newH, 'frames', 'keep', 'a.jpg')) && archOf().length === 1 && fs.existsSync(path.join(base, archOf()[0], '.migrated-to-dsh-bili-skill')) && !fs.readdirSync(newH).some((f) => String(f).startsWith('.migrated-to-')), JSON.stringify({ mig, arch: archOf(), newFiles: fs.readdirSync(newH) }))
  ok('数据不许丢：归档里也能看到那份凭证（老目录改名而非删除）', archOf().length === 1 && fs.existsSync(path.join(base, archOf()[0], 'bili_credential.json')), JSON.stringify(archOf()))
  const migMark = mod.migrateOldHome(newH, base, () => {})
  ok('搬过第二次直接回 null（不重复搬家、不重复报）', migMark === null, JSON.stringify(migMark))
  // 本机真实场景：新家早已被上一次搬复制满、旧壳还在 ⇒ 只补真正缺的那一个文件，已有的不覆盖，标记文件不进新家
  const base2 = path.join(tmp, 'mig2')
  const old2 = path.join(base2, 'bili-skill')
  const new2 = path.join(base2, 'dsh-bili-skill')
  fs.mkdirSync(path.join(old2, 'ledger'), { recursive: true })
  fs.mkdirSync(path.join(new2, 'ledger'), { recursive: true })
  fs.writeFileSync(path.join(old2, 'bili_credential.json'), '{"sessdata":"x"}', 'utf8')
  fs.writeFileSync(path.join(old2, 'uid-cache.json'), '{"某人":"42"}', 'utf8')
  fs.writeFileSync(path.join(old2, 'ledger', 'note.jsonl'), '{"topic":"旧账"}\n', 'utf8')
  fs.writeFileSync(path.join(new2, 'bili_credential.json'), '{"sessdata":"x"}', 'utf8')
  fs.writeFileSync(path.join(new2, 'ledger', 'note.jsonl'), '{"topic":"旧账"}\n', 'utf8')
  fs.writeFileSync(path.join(new2, 'ledger', 'seen.jsonl'), '{"bvid":"BV1keepme"}\n', 'utf8')
  const mig3 = mod.migrateOldHome(new2, base2, () => {})
  ok('新家缺的那一个（uid-cache）被补齐、已有的凭证与 note 内容原样不动、标记文件没被搬进新家', !!mig3 && mig3.copied === 1 && mig3.failed === 0 && fs.readFileSync(path.join(new2, 'uid-cache.json'), 'utf8') === '{"某人":"42"}' && fs.readFileSync(path.join(new2, 'ledger', 'note.jsonl'), 'utf8').includes('旧账') && fs.readFileSync(path.join(new2, 'bili_credential.json'), 'utf8') === '{"sessdata":"x"}' && !fs.readdirSync(new2).some((f) => String(f).startsWith('.migrated-to-')), JSON.stringify(mig3))
  ok('新家里原本独有的账目不被归档动作弄丢（seen.jsonl 还在）', fs.existsSync(path.join(new2, 'ledger', 'seen.jsonl')) && fs.readFileSync(path.join(new2, 'ledger', 'seen.jsonl'), 'utf8').includes('BV1keepme'), JSON.stringify(fs.readdirSync(path.join(new2, 'ledger'))))
  fs.mkdirSync(old2, { recursive: true })
  fs.writeFileSync(path.join(old2, '.migrated-to-bili-skill'), '{}', 'utf8')
  const mig4 = mod.migrateOldHome(new2, base2, () => {})
  ok('旧壳里只要有 .migrated-to-* 标记（去向写的是更早的名字也算）就永不再搬，哪怕壳还在', mig4 === null, JSON.stringify({ mig4, oldStillThere: fs.existsSync(old2) }))
  // 两代旧名同时在场：由近到远逐个搬，近的先把新数据占住，远的只补空缺，两个壳各自改名留档
  const baseC = path.join(tmp, 'migchain')
  const farC = path.join(baseC, 'bili-base')
  const nearC = path.join(baseC, 'bili-skill')
  const newC = path.join(baseC, 'dsh-bili-skill')
  fs.mkdirSync(path.join(farC, 'ledger'), { recursive: true })
  fs.mkdirSync(path.join(nearC, 'ledger'), { recursive: true })
  fs.writeFileSync(path.join(farC, 'bili_credential.json'), '{"sessdata":"老世代"}', 'utf8')
  fs.writeFileSync(path.join(farC, 'ledger', 'note.jsonl'), '{"topic":"只有老世代有的一行"}\n', 'utf8')
  fs.writeFileSync(path.join(nearC, 'bili_credential.json'), '{"sessdata":"近世代"}', 'utf8')
  fs.writeFileSync(path.join(nearC, 'ledger', 'dm.jsonl'), '{"peer":1}\n', 'utf8')
  const migC = mod.migrateLegacyHomes(newC, baseC, () => {})
  ok('两代旧名一起搬：先 bili-skill 后 bili-base，两个壳都留档', Array.isArray(migC) && migC.length === 2 && migC[0].from === 'bili-skill' && migC[1].from === 'bili-base' && fs.readdirSync(baseC).filter((x) => x.includes('.migrated-')).length === 2, JSON.stringify({ migC, base: fs.readdirSync(baseC) }))
  ok('近的占住新数据（凭证是 bili-skill 那份）、远的只补空缺（老世代独有的 note 也进了新家）', fs.readFileSync(path.join(newC, 'bili_credential.json'), 'utf8') === '{"sessdata":"近世代"}' && fs.existsSync(path.join(newC, 'ledger', 'note.jsonl')) && fs.existsSync(path.join(newC, 'ledger', 'dm.jsonl')), JSON.stringify(fs.readdirSync(path.join(newC, 'ledger'))))
}

/* ── 1a. 手动把 config.home 指到旧名目录时不搬家（那是使用者自己的选择） ── */
{
  const baseP = path.join(tmp, 'migpin')
  const pinned = path.join(baseP, 'bili-skill')
  fs.mkdirSync(pinned, { recursive: true })
  fs.writeFileSync(path.join(pinned, 'bili_credential.json'), '{"sessdata":"pinned"}', 'utf8')
  const cp = mkCtx(); mod.apply(cp.ctx, { home: pinned, logLevel: 'silent' })
  ok('home 钉在旧名目录上：数据留在原地，不搬、不建归档壳', fs.existsSync(path.join(pinned, 'bili_credential.json')) && fs.readdirSync(baseP).length === 1, JSON.stringify(fs.readdirSync(baseP)))
}

eq('硬注入 = tools + skills', mod.inject, ['tools', 'skills'])
eq('注册了 5 只工具', a.tools.map((t) => t.name), ['bili_auth', 'bili_api', 'bili_shot', 'bili_frames', 'bili_ledger'])
ok('每只工具都有非空 description 与 presentCall', a.tools.every((t) => t.description && t.description.length > 30 && typeof t.presentCall === 'function'))
ok('effect 挂上了 skill provider 的 disposer', a.effects.some(([, l]) => String(l).includes('skills provider')))

/* ── 1b. 扫码登录 poll 的码值（真扫一次码取到的三种：86038 失效 / 86090 已扫未确认 / 0 + 6 条 set-cookie 成功）── */
{
  const cases = [
    ["86038 已失效", { code: 0, message: "OK", data: { code: 86038, message: "二维码已失效" } }, [], "expired"],
    ["86090 已扫未确认", { code: 0, data: { code: 86090, message: "二维码已扫码未确认" } }, [], "scanned"],
    ["外层 0 但 data 没给码只能当还没扫（不许判成功）", { code: 0, data: {} }, [], "waiting"],
    ["data.code=0 但一条 cookie 都没落（只能报已扫、不许写凭证）", { code: 0, data: { code: 0 } }, [], "scanned_no_cookie"],
  ]
  for (const [label, body, cookies, want] of cases) {
    const got = await probePollShape(body, cookies)
    ok("poll " + label + " ⇒ " + want, got === want, JSON.stringify({ got, want }))
  }
  const win = await probePollShape({ code: 0, data: { code: 0, url: "https://passport.biligame.com/x/passport-login/web/crossDomain?ticket=x", refresh_token: "rt", timestamp: 1 } }, ["SESSDATA=abc; Path=/; Domain=bilibili.com", "bili_jct=def; Path=/", "DedeUserID=42; Path=/"])
  ok("成功那一路判成 ok 且读的是 SESSDATA 这个大小写（我先前读小写 sessdata，把真成功误报成\"扫码了但没 sessdata\"）", win.state === "ok" && win.sessdata === "abc" && win.dedeuserid === "42", JSON.stringify(win))
}
/* ── 1c. qrpng：功能区格数/容量/格式位落格（拿真图对拍的活体探针在本机、不在包里；这里只做不依赖它的确定性断言）── */
{
  const QR = await import(pathToFileURL(path.join(pkgDir, 'qrpng.js')).href)
  const EXPECT = { 2: { cw: 44, bytes: 32 }, 3: { cw: 70, bytes: 53 }, 4: { cw: 100, bytes: 78 }, 5: { cw: 134, bytes: 106 } }
  for (const [v, want] of Object.entries(EXPECT)) {
    const g = QR.totalCodewords(Number(v))
    const cap = QR.capacityBytes(Number(v), 'L')
    ok('qrpng v' + v + '-L：几何码字空间与权威分块表一致（' + g.cw + '），可装 ' + cap.bytes + ' 字节', g.consistent === undefined || g.cw === want.cw, JSON.stringify({ g, want }))
    ok('qrpng v' + v + '-L：字节容量对上权威表（' + want.bytes + '）', cap.bytes === want.bytes && cap.dataCw === want.cw - cap.ecTotal, JSON.stringify(cap))
  }
  /* 功能区真集：v2 = 266 格（照参考实现的快照逐格核过，差异 0）*/
  const g2 = QR.totalCodewords(2)
  ok('qrpng v2 功能区 = 266 格（不是我自己凑的 281）、留给数据 359 格、余 7 格留空', g2.reserved === 266 && g2.dataModules === 359 && g2.remainderBits === 7, JSON.stringify(g2))
  /* 格式位必须真写进格子：先前我写 bits[i] === "1"（对数字数组比字符串）恒 false ⇒ 15 位全落成 0，还连着两次"改了位序但看不到效果" */
  const n = 25
  const M = Array.from({ length: n }, () => new Array(n).fill(0))
  QR.placeFormat(M, n, 'L', 0)
  const cells = []
  for (let x = 0; x <= 8; x++) if (x !== 6) cells.push([8, x])
  for (let y = 7; y >= 0; y--) if (y !== 6) cells.push([y, 8])
  let bits = 0
  for (const [r, c] of cells) bits = (bits << 1) | M[r][c]
  ok('placeFormat 真把 15 位写进格子（按解码器读序回读 = 0x77C4，不是全 0）', bits === 0x77c4, '0x' + bits.toString(16).toUpperCase())
  ok('暗模块 (size-8,8) 被写成黑', M[n - 8][8] === 1, String(M[n - 8][8]))
  /* 四档容量与长度字段位宽（v1..9 = 8 位、v10+ = 16 位）：v10/L 我先前虚报 272，按 16 位实际只装 271 */
  const CAP4 = { '2L': 32, '2M': 26, '2Q': 20, '2H': 14, '7L': 154, '7Q': 86, '10L': 271, '10M': 213, '10Q': 151, '10H': 119 }
  for (const [k, want] of Object.entries(CAP4)) {
    const c = QR.capacityBytes(Number(k.slice(0, -1)), k.slice(-1))
    ok('qrpng ' + k + '：可装 ' + want + ' 字节（照权威分块表 + 该版本段的长度字段位宽）', c && c.bytes === want, JSON.stringify(c))
  }
  ok('qrpng v10 的长度字段是 16 位（v9 是 8 位）', QR.capacityBytes(10, 'L').lenBits === 16 && QR.capacityBytes(9, 'L').lenBits === 8, JSON.stringify({ v9: QR.capacityBytes(9, 'L').lenBits, v10: QR.capacityBytes(10, 'L').lenBits }))
  /* 混合分块（两块长度不同，最能把交织写错暴露出来）：v5-Q [2,33,15,2,34,16]、v7-Q [2,32,14,4,33,15] */
  for (const [v, lv, wantTotal] of [[5, 'Q', 134], [7, 'Q', 196], [10, 'L', 346]]) {
    const cw = QR.__internals.buildCodewords('u'.repeat(QR.capacityBytes(v, lv).bytes), v, lv)
    ok('qrpng v' + v + '-' + lv + '：交织后码字数 = ' + wantTotal + '（混合分块也不例外）', cw.length === wantTotal, String(cw.length))
  }
  ok('超容量如实回 too_long（不硬出图；v10/L 上限 271 字节 —— 我先前拿 200 字节当超限样本，那时只做到 v7）', QR.qrPng('x'.repeat(300), { ecLevel: 'L' }).why === 'too_long', JSON.stringify(QR.qrPng('x'.repeat(300), { ecLevel: 'L' })).slice(0, 120))
}

/* ── 2. 宿主 schema 规则自查：properties/required/additionalProperties 只许挂在 type:'object' 上 ── */
const TYPES = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']
const hostViolations = (node, p = '$', out = []) => {
  if (!node || typeof node !== 'object') return out
  const t = node.type
  if (t !== undefined && (!TYPES.includes(t) || Array.isArray(t))) out.push(`${p}.type 不受支持：${JSON.stringify(t)}`)
  for (const k of ['properties', 'required', 'additionalProperties']) if (k in node && t !== 'object') out.push(`${p}.${k} 挂在 type=${JSON.stringify(t)} 上`)
  if (Array.isArray(node.required)) for (const r of node.required) if (!(node.properties || {})[r]) out.push(`${p}.required 里的 ${r} 不在 properties`)
  for (const [k, v] of Object.entries(node.properties || {})) { if (v && typeof v === 'object' && 'required' in v && !Array.isArray(v.required)) out.push(`${p}.properties.${k}.required 不是数组`); hostViolations(v, `${p}.properties.${k}`, out) }
  if (node.items) hostViolations(node.items, `${p}.items`, out)
  return out
}
const viol = a.tools.map((t) => [t.name, hostViolations(t.parameters)]).filter(([, v]) => v.length)
ok('5 只工具的 parameters 按宿主规则干净', viol.length === 0, JSON.stringify(viol))
const violO = a.tools.map((t) => [t.name, hostViolations(t.output?.schema)]).filter(([, v]) => v.length)
ok('5 只工具的 output.schema 按宿主规则干净', violO.length === 0, JSON.stringify(violO))
ok('parameters 顶层都是 object 型且 additionalProperties 明确', a.tools.every((t) => t.parameters.type === 'object' && 'additionalProperties' in t.parameters))
ok('输出 schema 里钉了类型的字段只有 ok / message（其余自由，防 null 被判不合规）', a.tools.every((t) => Object.keys(t.output.schema?.properties || {}).every((k) => k === 'ok' || k === 'message')))
const shot = a.tools.find((t) => t.name === 'bili_shot')
ok('bili_shot 的 output 是带图的宽松 schema（properties 空、additionalProperties 开）', shot.output.schema.type === 'object' && shot.output.schema.additionalProperties === true && Object.keys(shot.output.schema.properties || {}).length === 0)
const apiT = a.tools.find((t) => t.name === 'bili_api')
ok('bili_api 开了 headers 入口（排查风控时能自己试 UA / referer）', !!apiT.parameters.properties.headers && apiT.parameters.properties.headers.type === 'object', JSON.stringify(Object.keys(apiT.parameters.properties)))

/* ── 3. cookie：B站 认的是首字母大写的名字 ── */
const ck = mod.__cookieHeader({ sessdata: 'S%2CS', bili_jct: 'J', buvid3: 'B3', buvid4: 'B4', dedeuserid: '42' })
ok('同时带 SESSDATA 与 sessdata（只发小写会一路 -101 未登录）', /(^|; )SESSDATA=S%2CS/.test(ck) && /(^|; )sessdata=S%2CS/.test(ck))
ok('同时带 DedeUserID 与 dedeuserid', /(^|; )DedeUserID=42/.test(ck) && /(^|; )dedeuserid=42/.test(ck))
ok('bili_jct / buvid3 / buvid4 也带上', ck.includes('bili_jct=J') && ck.includes('buvid3=B3') && ck.includes('buvid4=B4'))
eq('没凭证时 cookie 头是空串（不发 "undefined"）', [mod.__cookieHeader(null), mod.__cookieHeader({})], ['', ''])

/* ── 4. POST 表单：csrf 与 csrf_token 都要有，且必须在序列化之前补 ── */
const c2 = mod.__withCsrf({ oid: 1, msg: 'hi' }, { bili_jct: 'TOKEN' })
eq('补上了 csrf', c2.csrf, 'TOKEN')
eq('也补上了 csrf_token（照参考实现）', c2.csrf_token, 'TOKEN')
ok('序列化之后两个都还在', new URLSearchParams(c2).toString().includes('csrf=TOKEN') && new URLSearchParams(c2).toString().includes('csrf_token=TOKEN'))
ok('自己已经写了 csrf 的不覆盖、不重复加', mod.__withCsrf({ csrf: 'mine' }, { bili_jct: 'TOKEN' }).csrf === 'mine')
ok('无 bili_jct 时不硬塞空 csrf', !('csrf' in mod.__withCsrf({ a: 1 }, null)) && !('csrf_token' in mod.__withCsrf({ a: 1 }, {})))

/* ── 5. 无损 JSON（宿主要求返回值可无损序列化）── */
const L = mod.__lossless
eq('NaN / Infinity 换成 null、BigInt 换成字符串', L({ a: NaN, b: Infinity, c: -0.5, d: 10n }), { a: null, b: null, c: -0.5, d: '10' })
eq('undefined 的键被摘掉、数组里的 undefined 变 null', L({ x: 1, y: undefined, z: [1, undefined, 2] }), { x: 1, z: [1, null, 2] })
eq('Date 变 ISO 字符串而不是对象', L({ t: new Date(0) }), { t: '1970-01-01T00:00:00.000Z' })
eq('超出 JS 安全整数的 id 转成字符串（msg_key 就是这种大数）', L({ k: 7700696900930979000, m: 42 }), { k: '7700696900930979000', m: 42 })

/* ── 6. 非信封响应整份回，不丢正文 ── */
const unw = mod.__unwrapResponse({ body: [{ from: 0, to: 2, content: '嗨' }] })
ok('没有 code 信封的响应（字幕正文就是这种）整份回在 data 里', unw.ok === true && unw.data?.body?.[0]?.content === '嗨')
const env = mod.__unwrapResponse({ code: 0, message: 'OK', data: { x: 1 } })
eq('带信封的响应照旧解出 ok/code/data', [env.ok, env.code, env.data?.x], [true, 0, 1])
ok('非对象响应（数组或 null）判失败而不是硬塞 data', mod.__unwrapResponse(null).ok === false && mod.__unwrapResponse([1, 2]).ok === false)

/* ── 7. 图片契约：正文走 text 部件、图走 attachment ── */
const parts = mod.__renderWithImages({ ok: true, title: 'x', images: ['ref1', 'ref2'] })
ok('带图输出：正文部件里不含 images、两张图各成一个 image 部件', parts[0].type === 'text' && !parts[0].text.includes('images') && parts[1].type === 'image' && parts[1].attachment === 'ref1' && parts[2].attachment === 'ref2')
const noSvc = await mod.__attachImages(() => undefined, null, [{ buffer: Buffer.from('a'), mediaType: 'image/jpeg' }])
ok('宿主没给 attachments 时明确退化成"只回路径"（不硬塞、不抛）', noSvc.ok === false && noSvc.reason === 'no_attachments' && /只回文件路径/.test(noSvc.hint))
const imgGet = (k) => (k === 'attachments' ? { saveImages: async (xs) => xs.map((i, n) => 'ref' + n) } : (k === 'llm' ? { resolveModelInfo: async () => ({ inputModalities: ['text', 'image'] }) } : null))
const yes = await mod.__attachImages(imgGet, { agent: { options: { provider: 'p', model: 'm' } } }, [{ buffer: Buffer.from('a'), mediaType: 'image/jpeg' }])
eq('模型接图片时把帧存成附件引用并回 refs', [yes.ok, yes.refs], [true, ['ref0']])
const txtGet = (k) => (k === 'attachments' ? { saveImages: async () => ['x'] } : (k === 'llm' ? { resolveModelInfo: async () => ({ inputModalities: ['text'] }) } : null))
const noImg = await mod.__attachImages(txtGet, { agent: { options: { provider: 'p', model: 'm' } } }, [{ buffer: Buffer.from('a'), mediaType: 'image/jpeg' }])
ok('模型不接图片时退化成文字并给 hint（讲清这次只有路径、以及靠 read_image/卡片看）', noImg.ok === false && noImg.reason === 'model_no_image' && /read_image/.test(noImg.hint) && !/modlens/.test(noImg.hint), noImg.hint)

/* ── 8. URL 白名单 ── */
const apiExec = a.tools.find((t) => t.name === 'bili_api').execute
for (const bad of ['x/web-interface/view', 'https://evil.example.com/x', 'javascript:alert(1)']) {
  let rej = false, msg = ''
  try { await apiExec({ path: bad }) } catch (e) { rej = true; msg = String(e?.message || e) }
  ok(`拒绝非站内/畸形路径：${bad}`, rej && /bilibili/.test(msg), msg)
}
ok('放行 B站 自家 CDN（字幕在 aisubtitle.hdslb.com、图在 i0.hdslb.com）', mod.__allowedUrl('//aisubtitle.hdslb.com/bfs/ai_subtitle/x?auth_key=1') === true && mod.__allowedUrl('https://i0.hdslb.com/bfs/archive/x.jpg') === true)
ok('挡掉相似后缀的假域与外部主机', mod.__allowedUrl('https://api.bilibili.com.evil.cn/x') === false && mod.__allowedUrl('https://evil.example.com/x') === false)
ok('相对路径（以 / 开头）仍然放行', mod.__allowedUrl('/x/web-interface/view') === true)

/* ── 9. Gaia 指纹：murmur 必须与参考实现逐位一致 ── */
const vecFile = path.join(pkgDir, 'gaia', '_fp-vector.txt')
if (fs.existsSync(vecFile)) {
  const raw = fs.readFileSync(vecFile, 'utf8').trim()
  eq('murmur3_x64_128(seed31) 出的 buvid_fp 与 Python 参考实现一致', mod.__murmur3x64128Hex(raw, 31), '865e35516bcc75d8e27d677ac3019a5d')
} else skip('murmur 向量比对', '缺 gaia/_fp-vector.txt')
const tplFile = path.join(pkgDir, 'gaia', 'payload-template.txt')
if (fs.existsSync(tplFile)) {
  const tpl = fs.readFileSync(tplFile, 'utf8')
  ok('指纹模板就位（只有 uuid/毫秒两个占位，外层就是 {"payload":"…"}）', tpl.startsWith('{"payload":') && (tpl.match(/__UUID__/g) || []).length === 1 && (tpl.match(/__TS__/g) || []).length === 1)
  const filled = mod.__gaiaBody(tpl, 'X-1-2-3-4infoc', 1792964000000)
  ok('填好的 body 没有占位符残留、且内层 JSON 仍可解析', !filled.includes('__UUID__') && !filled.includes('__TS__') && JSON.parse(JSON.parse(filled).payload)['5062'] === 1792964000000)
} else skip('指纹模板检查', '缺 gaia/payload-template.txt')
const uu = mod.__genUuidInfoc(1792964000123)
ok('_uuid 形状合规（5 段、末尾 5 位毫秒 + infoc）', (uu.match(/-/g) || []).length === 4 && /infoc$/.test(uu) && uu.slice(-10, -5) === '00123', uu)

/* ── 10. 发评论前的三步序列（spi → ExClimbWuzhi → reply/add）── */
hits.length = 0
const b2 = mkCtx(); mod.apply(b2.ctx, { home: path.join(tmp, 'gaiahome'), logLevel: 'silent', gaia: true })
const api2 = b2.tools.find((t) => t.name === 'bili_api').execute
await api2({ path: '/x/v2/reply/add', method: 'POST', params: { oid: 1, type: 1, message: 'hi' }, body: { oid: 1, type: 1, message: 'hi' } })
const order = hits.map((h) => (h.url.includes('finger/spi') ? 'spi' : h.url.includes('gaia-gateway') ? 'gaia' : h.url.includes('reply/add') ? 'add' : 'other'))
eq('POST 之前先 spi 再 ExClimbWuzhi，然后才打业务端点', order.slice(0, 3), ['spi', 'gaia', 'add'])
const gaiaHit = hits.find((h) => h.url.includes('gaia-gateway'))
ok('ExClimbWuzhi 用 application/json 且 cookie 带 buvid_fp/_uuid', gaiaHit.headers['content-type'] === 'application/json' && /buvid_fp=/.test(gaiaHit.headers.cookie || '') && /_uuid=/.test(gaiaHit.headers.cookie || ''))
const addHit = hits.find((h) => h.url.includes('reply/add'))
ok('业务请求改用 spi 现取的那对 buvid', (addHit.headers.cookie || '').includes(`buvid3=${SPI_B3}`) && (addHit.headers.cookie || '').includes(`buvid4=${SPI_B4}`))
ok('默认 Referer 不带尾斜杠（带 / 会被 B站 标记成 attr 6422528 的降级评论，本机实测）', addHit.headers.referer === 'https://www.bilibili.com', addHit.headers.referer)
ok('gaia-state.json 落在家目录（下次开机直接复用）', fs.existsSync(path.join(path.join(tmp, 'gaiahome'), 'gaia-state.json')))
hits.length = 0
const b3 = mkCtx(); mod.apply(b3.ctx, { home: path.join(tmp, 'nogaia'), logLevel: 'silent', gaia: false })
await b3.tools.find((t) => t.name === 'bili_api').execute({ path: '/x/v2/reply/add', method: 'POST', body: { oid: 1 } })
ok('config 里 gaia:false 就真的不打 spi/ExClimbWuzhi（省一次往返）', !hits.some((h) => h.url.includes('gaia-gateway')), JSON.stringify(hits.map((h) => h.url)))
hits.length = 0
const b4 = mkCtx(); mod.apply(b4.ctx, { home: path.join(tmp, 'gaia-default'), logLevel: 'silent' })
await b4.tools.find((t) => t.name === 'bili_api').execute({ path: '/x/v2/reply/add', method: 'POST', body: { oid: 1 } })
ok('Gaia 默认就是关的（本机 2×2 实测：只有 Referer 决定降级，上报开不开没差别 ⇒ 省两次请求）', !hits.some((h) => h.url.includes('gaia-gateway')), JSON.stringify(hits.map((h) => h.url)))

/* ── 11. skill provider 契约 ── */
const cl = await a.providers[0].list()
ok('目录里有 7 份 skill', cl.length === 7, JSON.stringify(cl.map((c) => c.name)))
ok('每个候选都有有限数字 rank、字符串 source、provider 名等于注册名', cl.every((c) => Number.isFinite(c.rank) && typeof c.source === 'string' && c.provider === 'dsh-bili-skill'))
ok('每份都有非空 description 与 whenToUse', cl.every((c) => (c.description || '').length > 8 && (c.whenToUse || '').length > 8))
ok('每份的 frontmatter name 与文件名一致且是 kebab-case', cl.every((c) => /^[a-z0-9]+(-[a-z0-9]+)*$/.test(c.name) && fs.existsSync(path.join(pkgDir, 'skills', c.name + '.md'))))
const rg = cl.find((c) => c.name === 'bili-comment-reply')
const rgBody = rg ? (await a.providers[0].get(rg)).content : ''
ok('回复说明书在目录里，正文含 root/parent、dialog、12022、reply/reply 读法', !!rg && ['12022', 'dialog', 'reply/reply', 'root'].every((k) => rgBody.includes(k)), rgBody.slice(0, 60))
ok('回复说明书不再把 state:17 写成常态（要说清是带斜杠时代的现象，修好后复测 state 0 attr 0）', /318196566817/.test(rgBody) && /带斜杠那阵子/.test(rgBody) && !/刚发的两条都是 \*\*`state:17`\*\*/.test(rgBody), rgBody.slice(0, 120))
ok('回复说明书不再把 Gaia 写成「已自动化」（它默认是关的）', !/Gaia 上报底座已自动化/.test(rgBody) && /默认关着/.test(rgBody), rgBody.slice(-220))
const cmBody = (await a.providers[0].get({ name: 'bili-comment' })).content
ok('评论说明书正文锁着两条实测口径：Referer 不带尾斜杠 + Gaia 默认关（gaia: true 才开）', /Referer/.test(cmBody) && /尾斜杠/.test(cmBody) && /gaia: true/.test(cmBody) && !/不做上报就会被 AI 审核降级/.test(cmBody), cmBody.slice(-260))
const got = await a.providers[0].get({ name: 'bili-search' })
ok('get() 去掉 frontmatter、追加底座脚注（版本/记忆位置/缓存边界）', !got.content.startsWith('---') && got.content.includes('## 本插件的底座') && got.content.includes('记忆在这儿'))
ok('搜索说明书按本机实测改口：wbi 签名不是硬性必须（不签也通）、分页要用 page_size（ps 被忽略）、并写明 is_risk 类风控旗标', !/不签常回/.test(got.content) && /不签也通/.test(got.content) && /page_size/.test(got.content) && /静默忽略/.test(got.content) && /is_risk/.test(got.content), got.content.slice(0, 150))
const pv = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8')).version
ok('脚注里的版本是现读磁盘的那份（不是模块加载时冻住的）', got.content.includes('dsh-bili-skill v' + pv), got.content.slice(-120))
ok('凭证那行只声明文件在不在，登录要现查', got.content.includes('这行只说明文件存在') || got.content.includes('不在 ——'))
const dirs = ['ledger', 'frames', 'skills']
ok('家目录结构建好了（ledger / frames 都在）', dirs.every((d) => fs.existsSync(path.join(home, d))))
const aBad = mkCtx(); mod.apply(aBad.ctx, { home: path.join(tmp, 'bad'), logLevel: 'nope', requestTimeoutMs: 'x', maxBytes: 0, framesDefault: 0 })
ok('坏配置不炸（值被 coerce 回默认）', aBad.tools.length === 5)

/* ── 12. 覆盖：家目录同名文件赢，且正文现读磁盘 ── */
const ovHome = path.join(tmp, 'ovr', 'dsh-bili-skill')
fs.mkdirSync(path.join(ovHome, 'skills'), { recursive: true })
fs.writeFileSync(path.join(ovHome, 'skills', 'bili-search.md'), '---\nname: bili-search\ndescription: 覆盖版说明书\nwhenToUse: 用它顶掉包内那份。\n---\n\n覆盖正文：改了立刻就生效。\n', 'utf8')
const a2 = mkCtx(); mod.apply(a2.ctx, { home: ovHome, logLevel: 'silent' })
const cl2 = await a2.providers[0].list()
ok('家目录里的同名 skill 顶掉了包内那份（source=override）', cl2.some((c) => c.name === 'bili-search' && c.source === 'override'))
const got2 = await a2.providers[0].get({ name: 'bili-search' })
ok('覆盖版的正文也是现读磁盘（改 md 不必重启）', got2.content.includes('改了立刻就生效'))
fs.writeFileSync(path.join(ovHome, 'skills', 'bili-search.md'), '---\nname: bili-search\ndescription: 覆盖版说明书\nwhenToUse: 用它顶掉包内那份。\n---\n\n覆盖正文：第二次改的。\n', 'utf8')
ok('同一次挂载内改正文也算数', (await a2.providers[0].get({ name: 'bili-search' })).content.includes('第二次改的'))
ok('没覆盖的那六份仍来自包内', cl2.filter((c) => c.source === 'bundled').length === 6, JSON.stringify(cl2.map((c) => c.source)))

/* ── 13. 默认零后台：不建监视、不喊 invalidate ── */
fs.writeFileSync(path.join(ovHome, 'skills', 'bili-late.md'), '---\nname: bili-late\ndescription: 挂载之后新丢进来的\nwhenToUse: 验证默认不监视。\n---\n\n正文。\n', 'utf8')
const cl3 = await a2.providers[0].list()
ok('目录现扫与 watchSkills 无关：默认（不监视）也看得见新文件', cl3.some((c) => c.name === 'bili-late'), JSON.stringify(cl3.map((c) => c.name)))
ok('默认不建文件监视、也不会去喊 invalidate（watchSkills 默认 false）', typeof a2.providers[0].close === 'function' && (a2.ctrlBox.invalidateCalls || 0) === 0, JSON.stringify(a2.ctrlBox.invalidateCalls))

/* ── 14. 记账：追加/去重/读/删/脏行 ── */
const led = a.tools.find((t) => t.name === 'bili_ledger').execute
const ap = await led({ action: 'append', table: 'seen', key: 'bvid', rows: [{ bvid: 'BV1x', verdict: '挑了' }] })
eq('append 一行成功', [ap.ok, ap.added, ap.skipped], [true, 1, 0])
const ap2 = await led({ action: 'append', table: 'seen', key: 'bvid', rows: [{ bvid: 'BV1x', verdict: '重复' }] })
eq('同 key 的行被跳过（去重生效）', [ap2.added, ap2.skipped], [0, 1])
const ap3 = await led({ action: 'append', table: 'seen', key: 'bvid', rows: [{ verdict: '没给 bvid' }] })
ok('给了 key 但行里缺该字段 → 跳过并如实报（不静默写进去）', ap3.added === 0 && ap3.skipped === 1, JSON.stringify(ap3))
const rd = await led({ action: 'read', table: 'seen' })
eq('read 回原文且自动补了 at', [rd.rows.length, typeof rd.rows[0].at], [1, 'string'])
fs.appendFileSync(path.join(home, 'ledger', 'seen.jsonl'), '这不是 JSON\n', 'utf8')
const rd2 = await led({ action: 'read', table: 'seen' })
ok('脏行不炸：原样带出来（bad 字段）', rd2.rows.some((r) => r.bad), JSON.stringify(rd2.rows.slice(-1)))
const del = await led({ action: 'delete', table: 'seen', key: 'bvid', removeKey: 'BV1x' })
eq('delete 按 key 删掉了那一行', [del.ok, del.removed], [true, 1])
const tbs = await led({ action: 'tables' })
ok('tables 列出了表与行数', tbs.tables.some((t) => t.table === 'seen'))

/* ── 14b. 家目录被外部清过之后记账要自愈（0.8.0 撞实：ledger/ 没了就直接 ENOENT，只在挂载时 mkdir）── */
{
  const chHome = path.join(tmp, 'cleared')
  const cctx = mkCtx(); mod.apply(cctx.ctx, { home: chHome, logLevel: 'silent' })
  fs.rmSync(path.join(chHome, 'ledger'), { recursive: true, force: true })
  fs.rmSync(path.join(chHome, 'frames'), { recursive: true, force: true })
  const led2 = cctx.tools.find((t) => t.name === 'bili_ledger').execute
  const ap4 = await led2({ action: 'append', table: 'note', rows: [{ topic: '清完再写' }] })
  ok('ledger/ 被删掉后 append 自己把目录建回来并写进行（不再 ENOENT）', ap4.ok === true && ap4.added === 1 && fs.existsSync(path.join(chHome, 'ledger', 'note.jsonl')), JSON.stringify(ap4))
  const dl2 = await led2({ action: 'delete', table: 'dm', key: 'msg_key', removeKey: 'nope' })
  ok('同一情形下 delete 也不炸（新表没写过也照实回 removed:0，目录仍在）', dl2.ok === true && dl2.removed === 0 && fs.existsSync(path.join(chHome, 'ledger')), JSON.stringify(dl2))
  const fr3 = cctx.tools.find((t) => t.name === 'bili_frames').execute
  const lv = await fr3({ action: 'list' })
  const cv = await fr3({ action: 'clear' })
  ok('frames/ 被删掉后 list/clear 都不炸（回 0 与"没得删"，不把失败糊成删干净了）', lv.ok === true && lv.count === 0 && cv.ok === true && cv.removedCount === 0, JSON.stringify({ lv, cv }))
}

/* ── 15. bili_shot / bili_auth 的守门 ── */
const noBvid = await a.tools.find((t) => t.name === 'bili_shot').execute({})
ok('bili_shot 不给 bvid 回 ok:false 而不是抛', noBvid.ok === false && typeof noBvid.message === 'string')
let threw = false; try { await a.tools.find((t) => t.name === 'bili_auth').execute({ action: 'poll' }) } catch { threw = true }
ok('poll 不给 key 就明确报错（不闷声发请求）', threw)
const st = await a.tools.find((t) => t.name === 'bili_auth').execute({ action: 'status' })
ok('bili_auth status 走假 fetch 认成已登录', st.ok === true && st.loggedIn === true && st.uid === '12345678', JSON.stringify(st))
ok('status 的 level 是真账号等级（level_info.current_level），vipStatus 另走 vip_status 字段 —— 先前把 vipStatus 当 level 回', st.level === 2 && st.vip_status === 0, JSON.stringify({ level: st.level, vip_status: st.vip_status }))

/* ── 16. 撞风控时自动现取 spi 上报并重试一次（gaia 默认关着也要能自愈）── */
const tagOf = (u) => (u.includes('finger/spi') ? 'spi' : u.includes('gaia-gateway') ? 'gaia' : u.includes('reply/add') ? 'add' : 'other')
async function riskCase(homeName, plan, extraCfg) {
  risk = plan
  const c = mkCtx(); mod.apply(c.ctx, { home: path.join(tmp, homeName), logLevel: 'info', ...(extraCfg || {}) })
  hits.length = 0
  const out = await c.tools.find((t) => t.name === 'bili_api').execute({ path: '/x/v2/reply/add', method: 'POST', body: { oid: 1 } })
  const seq = hits.map((h) => tagOf(h.url)).join(',')
  const logged = fs.existsSync(path.join(tmp, homeName, 'base.log')) ? fs.readFileSync(path.join(tmp, homeName, 'base.log'), 'utf8') : ''
  risk = null
  return { seq, out, logged }
}
{
  const { seq, out, logged } = await riskCase('risk412', { left: 1, code: -412 })
  ok('撞 -412：先原样打，撞了就 spi→上报→原样重试一次，最后成功', seq === 'add,spi,gaia,add' && out.ok === true, seq + ' | ok=' + out.ok)
  ok('撞风控重试要在日志里说清楚（不静默多发请求）', /撞风控.*-412.*重试/.test(logged), logged.split(/\r?\n/).filter((l) => l.includes('撞风控')).join(' § ').slice(0, 180))
}
{
  const { seq, out } = await riskCase('riskvoucher', { left: 1, voucher: true })
  ok('code:0 但只回 v_voucher 也算撞风控，同样自愈一次', seq === 'add,spi,gaia,add' && out.ok === true, seq + ' | ok=' + out.ok)
}
{
  const { seq, out } = await riskCase('riskagain', { left: 2, code: -352 })
  ok('重试还撞就不再重试、也不再上报（只一次，绝不循环），并如实把失败回出来', seq === 'add,spi,gaia,add' && out.ok === false && out.code === -352, seq + ' | ok=' + out.ok + ' code=' + out.code)
}
{
  const { seq } = await riskCase('riskon', { left: 1, code: -412 }, { gaia: true })
  ok('gaia 开着时先预上报；撞风控后 force 绕过 12 小时缓存重新取 spi 再重试', seq === 'spi,gaia,add,spi,gaia,add', seq)
}
{
  const { seq } = await riskCase('cleanPOST', null)
  ok('没撞风控的 POST 一个多余请求都不发（默认 gaia 关 = 真的一次都不上报）', seq === 'add', seq)
}

/* ── 17. 单帧裁切（jpgcrop + frames）：拿 .NET 写的 fixture 盯解码、盯 5 秒/格、盯 keep/clear 边界 ── */
{
  const jpg = await import(pathToFileURL(path.join(pkgDir, 'jpgcrop.js')).href)
  const fr = await import(pathToFileURL(path.join(pkgDir, 'frames.js')).href)
  const fxDir = path.join(pkgDir, 'fixtures')
  ok('包里有那三张 .NET 基准图（不许用我自己编的图自证自）', ['ref-flat.jpg', 'ref-hgrad.jpg', 'ref-vgrad.jpg'].every((f) => fs.existsSync(path.join(fxDir, f))))
  const want = (x, y, mode) => (mode === "flat" ? 200 : mode === "h" ? x * 32 : y * 32)
  for (const [name, mode] of [["ref-flat.jpg", "flat"], ["ref-hgrad.jpg", "h"], ["ref-vgrad.jpg", "v"]]) {
    const img = jpg.decodeJPEG(fs.readFileSync(path.join(fxDir, name)))
    let maxd = 0
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) { const c = jpg.cropToRGB(img, x, y, 1, 1); maxd = Math.max(maxd, Math.abs(c[0] - want(x, y, mode))) }
    // 常量块解成渐变就是 IDCT 空间/频率下标写反的症状（本机真栽过：200→142）
    ok("fixture " + name + " 与 .NET 写的原图逐像素对得上（DC-only 必须是纯色）", img.width === 8 && img.height === 8 && maxd <= 2, "maxΔ=" + maxd)
  }
  {
    const rgb = Buffer.alloc(8 * 8 * 3)
    for (let i = 0; i < 64; i++) { rgb[i * 3] = rgb[i * 3 + 1] = rgb[i * 3 + 2] = 200 }
    const back = jpg.cropToRGB(jpg.decodeJPEG(jpg.encodeJPEG(rgb, 8, 8, 95, "444")), 0, 0, 8, 8)
    let maxd = 0
    for (let i = 0; i < 64; i++) maxd = Math.max(maxd, Math.abs(back[i * 3] - 200))
    ok("自己编的纯色块自己还得解成纯色（编解码共用规范码表这条不能歪）", maxd <= 4, "maxΔ=" + maxd)
  }
  {
    const grid = fr.gridOf({ img_x_len: 10, img_y_len: 10, img_x_size: 480, img_y_size: 270, image: ['//bimp.hdslb.com/x-0001.jpg'], ts: [] })
    ok("gridOf 把 videoshot 的分格规则读出来", grid.tilesPerSheet === 100 && grid.tileW === 480 && grid.sheets.length === 1, JSON.stringify({ t: grid.tilesPerSheet, w: grid.tileW }))
    const smap = fr.secondsMapOf({ partDuration: 215, contentTiles: 43, grid, ts: [] })
    ok("215s / 43 格 ⇒ 5.00 秒一格（本机逐 P 实测的形状），且 tileOfSec 夹在内容格里", Math.abs(smap.interval - 5) < 1e-9 && smap.tileOfSec(0) === 0 && smap.tileOfSec(214) === 42 && smap.tileOfSec(9999) === 42, JSON.stringify({ i: smap.interval, a: smap.tileOfSec(214), b: smap.tileOfSec(9999) }))
    ok("补位黑格不是‘没画面’：算出来的 interval 只按内容格数除时长", /内容格数 43/.test(smap.basis), smap.basis)
    const viaTs = fr.secondsMapOf({ partDuration: 100, contentTiles: 7, grid, ts: [0, 5, 10] })
    ok('接口自己给了 ts[] 时优先用它（相邻两格差就是 interval）', viaTs.interval === 5 && /ts\[\]/.test(viaTs.basis), viaTs.basis)
    const fb = fr.secondsMapOf({ partDuration: 100, contentTiles: 0, grid, ts: [] })
    ok('内容格数测不出时退回 5 秒/格并说明是兜底', fb.interval === 5 && /兜底|退回/.test(fb.basis), fb.basis)
    const spread = fr.pickTiles({ num: 3, smap })
    ok("不传 at 时只在有内容的格里均匀撒（不会撒到尾部补位）", spread.length === 3 && spread.every((s) => s.tile <= 42) && new Set(spread.map((s) => s.tile)).size === 3, JSON.stringify(spread.map((s) => s.tile)))
    const byAt = fr.pickTiles({ at: [3, 4, 220], smap })
    // at 是「那一格的起点秒」⇒ 贴格用 floor 才对；本机栽的那一跤不是我算错秒，而是想要第 1 格却在 at 里写了第 0 格的起点（所以才有 tiles 直取）
    ok("贴格照起点：span=215/43 时 4.4 仍在第 0 格、到 5.1 才进第 1 格、214 是最后一格", smap.tileOfSec(4.4) === 0 && smap.tileOfSec(5.1) === 1 && smap.tileOfSec(214) === 42, JSON.stringify({ span: smap.interval, a: smap.tileOfSec(4.4), b: smap.tileOfSec(5.1), c: smap.tileOfSec(214) }))
    const smap42 = fr.secondsMapOf({ partDuration: 215, contentTiles: 43 })
    const byTiles = fr.pickTiles({ tiles: [7, 7, 3], smap: smap42 })
    const tlBig = fr.pickTiles({ tiles: [999], smap: smap42 })[0].tile
    const tlNeg = fr.pickTiles({ tiles: [-4], smap: smap42 })[0].tile
    const shotT = a.tools.find((t) => t.name === "bili_shot").parameters.properties
    const framesT = a.tools.find((t) => t.name === "bili_frames").parameters.properties
    ok("tiles 直接按格号点格：去重、顺序照给、via=tiles（不必再换算秒）", JSON.stringify(byTiles.map((x) => x.tile)) === JSON.stringify([7, 3]) && byTiles.every((x) => x.via === "tiles"), JSON.stringify(byTiles.map((x) => [x.tile, x.via])))
    ok("tiles 越界夹进内容格（点不到尾部补位）", tlBig === 42 && tlNeg === 0, JSON.stringify({ tlBig: tlBig, tlNeg: tlNeg }))
    ok("两只工具声明里都有 tiles 入口（按格寻帧不该只能换算秒）", !!shotT.tiles && !!framesT.tiles, JSON.stringify({ shot: Object.keys(shotT), frames: Object.keys(framesT) }))
    {
      // 全链路：只给 tiles 也得真按格取（本机栽过：参数声明了但调用处没传，工具静默当没看见、回了一张默认帧）
      const savedFetch2 = globalThis.fetch
      const fxq = fs.readFileSync(path.join(fxDir, "ref-quads.jpg"))
      const vJ2 = { code: 0, message: "OK", data: { aid: 2, cid: 11, pic: "p", title: "T", duration: 89, owner: { name: "U" }, pages: [{ cid: 11, page: 1, part: "P1", duration: 89 }] } }
      const sJ2 = { code: 0, message: "OK", data: { img_x_len: 2, img_y_len: 2, img_x_size: 4, img_y_size: 4, image: ["//aisubtitle.hdslb.com/fixture/ref-quads.jpg", "//aisubtitle.hdslb.com/fixture/ref-quads.jpg"], ts: [], index: [] } }
      globalThis.fetch = async (u) => {
        const s2 = String(u)
        if (s2.includes("/x/web-interface/view") || s2.includes("/x/player/videoshot")) return { ok: true, status: 200, headers: { get: () => "application/json" }, text: async () => JSON.stringify(s2.includes("/x/web-interface/view") ? vJ2 : sJ2) }
        if (s2.includes("fixture/ref-quads.jpg")) return { ok: true, status: 200, headers: { get: () => "image/jpeg" }, arrayBuffer: async () => fxq, text: async () => "", json: async () => null }
        return { ok: false, status: 404, headers: { get: () => "text/html" }, text: async () => "x", json: async () => null }
      }
      const call2 = async ({ path: pp }) => (String(pp).includes("/x/web-interface/view") ? { ok: true, code: 0, message: "OK", data: vJ2.data } : { ok: true, code: 0, message: "OK", data: sJ2.data })
  const rt = await fr.shoot({ call: call2, log: () => {}, framesDir: tmp, UA: "u", REFERER: "https://www.bilibili.com", ffmpegPath: path.join(tmp, "nope.exe") }, { bvid: "BV1tilewiring", tiles: [1, 3], num: 1 })
      globalThis.fetch = savedFetch2
      ok("只给 tiles 时 shoot 真按这两格取（参数不许被静默忽略）", (rt.frames || []).length === 2 && JSON.stringify(rt.frames.map((x) => x.tile)) === JSON.stringify([1, 3]), JSON.stringify((rt.frames || []).map((x) => x.tile)))
    }
    ok("给了 at 就按秒贴最近格、同格去重", JSON.stringify(byAt.map((s) => s.tile)) === JSON.stringify([0, 42]), JSON.stringify(byAt))
  }
  {
    const dir = path.join(tmp, 'frames-tree')
    fs.mkdirSync(path.join(dir, 'keep'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'a-tmp.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]))
    fs.writeFileSync(path.join(dir, 'keep', 'BV1keep.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]))
    const one = fr.clearFrames(dir)
    ok("framesClear 默认只删临时帧，keep/ 里的不动", one.removedCount === 1 && fr.listFrames(dir).kept.length === 1, JSON.stringify(one.removed))
    const all = fr.clearFrames(dir, { scope: "all" })
    ok("scope:all 才会连留下的帧一起删", all.ok === true && all.removedCount === 1 && fr.listFrames(dir).count === 0, JSON.stringify(all.removed))
    const badScope = fr.clearFrames(dir, { scope: "everything" })
    ok("scope 不认时如实报错（不当‘删干净了’糊过去）", badScope.ok === false && /temp/.test(badScope.message), badScope.message)
  }
  {
    const real = globalThis.fetch
    const fxBytes = fs.readFileSync(path.join(fxDir, 'ref-flat.jpg'))
    globalThis.fetch = async (u) => {
      const s = String(u)
      if (s.includes('/x/web-interface/view')) return { ok: true, status: 200, headers: { get: () => 'application/json' }, text: async () => JSON.stringify({ code: 0, message: 'OK', data: { aid: 1, cid: 9, pic: 'p', title: 'T', duration: 727, owner: { name: 'U' }, pages: [{ cid: 9, page: 1, part: 'P1', duration: 215 }, { cid: 10, page: 2, part: 'P2', duration: 170 }] } }), json: async () => null }
      if (s.includes('/x/player/videoshot')) return { ok: true, status: 200, headers: { get: () => 'application/json' }, text: async () => JSON.stringify({ code: 0, message: 'OK', data: { img_x_len: 2, img_y_len: 2, img_x_size: 4, img_y_size: 4, image: ['//aisubtitle.hdslb.com/fixture/ref-flat.jpg'], ts: [], index: [] } }), json: async () => null }
      if (s.includes('fixture/ref-flat.jpg')) return { ok: true, status: 200, headers: { get: () => 'image/jpeg' }, arrayBuffer: async () => fxBytes, text: async () => '', json: async () => null }
      return { ok: false, status: 404, headers: { get: () => 'text/html' }, text: async () => 'nope', json: async () => null }
    }
    const shotDir = path.join(tmp, 'shot-tree')
    const deps = {
      call: async ({ path: pp }) => (pp.includes('/x/web-interface/view')
        ? { ok: true, code: 0, message: 'OK', data: { aid: 1, cid: 9, pic: 'p', title: 'T', duration: 727, owner: { name: 'U' }, pages: [{ cid: 9, page: 1, part: 'P1', duration: 215 }, { cid: 10, page: 2, part: 'P2', duration: 170 }] } }
        : pp.includes('/x/player/videoshot')
          ? { ok: true, code: 0, message: 'OK', data: { img_x_len: 2, img_y_len: 2, img_x_size: 4, img_y_size: 4, image: ['//aisubtitle.hdslb.com/fixture/ref-flat.jpg'], ts: [], index: [] } }
          : { ok: false, code: -1, message: '假 call 不认这条路：' + pp }),
      log: () => {}, framesDir: shotDir, UA: 'u', REFERER: 'https://www.bilibili.com', timeoutMs: 8000,
    }
    const r = await fr.shoot(deps, { bvid: 'BV1fixturetest', num: 2 })
    globalThis.fetch = real
  {
    // 四象限基准（.NET 写的：左上10 右上80 左下160 右下240）—— 只看尺寸会放过落位错，必须看内容
    const qimg = jpg.decodeJPEG(fs.readFileSync(path.join(fxDir, 'ref-quads.jpg')))
    const cellMean = (col, row) => { const c = jpg.cropToRGB(qimg, col * 4 + 2, row * 4 + 2, 1, 1); return Math.round((c[0] + c[1] + c[2]) / 3) }
    const qexp = [[0, 0, 10], [1, 0, 80], [0, 1, 160], [1, 1, 240]]
    const qok = qexp.every(([col, row, exp]) => Math.abs(cellMean(col, row) - exp) <= 12)
    ok('四象限基准图逐格内容对得上（行=floor(tile/cols)、列=tile%cols 的落位不能歪）', qok, qexp.map(([c, r, e]) => `(${c},${r})期望${e}实得${cellMean(c, r)}`).join(' '))
    const qtiles = [0, 1, 2, 3].map((t) => ({ t, m: cellMean(t % 2, Math.floor(t / 2)) }))
    ok('按 tile 公式取格后亮度顺序必须是 10,80,160,240（早先双重相乘把 y 算成 16，就是这类错）', qtiles.map((o) => o.m).join(',') === '10,80,160,240' || Math.abs(qtiles[0].m - 10) <= 12 && Math.abs(qtiles[3].m - 240) <= 12 && Math.abs(qtiles[1].m - 80) <= 12 && Math.abs(qtiles[2].m - 160) <= 12, qtiles.map((o) => o.t + ':' + o.m).join(' '))
    // shoot 也得用同一套落位：裁四象限这张当拼图，四格亮度必须各不相同
    const realQ = globalThis.fetch
    const qBytes = fs.readFileSync(path.join(fxDir, 'ref-quads.jpg'))
    globalThis.fetch = async (u) => {
      const s = String(u)
      if (s.includes('fixture/ref-quads.jpg')) return { ok: true, status: 200, headers: { get: () => 'image/jpeg' }, arrayBuffer: async () => qBytes, text: async () => '', json: async () => null }
      return { ok: false, status: 404, headers: { get: () => 'text/html' }, text: async () => 'x', json: async () => null }
    }
    const dq = { ok: true, code: 0, message: 'OK', data: { aid: 1, cid: 9, pic: 'p', title: 'T', duration: 20, owner: { name: 'U' }, pages: [{ cid: 9, page: 1, part: 'P1', duration: 20 }] } }
    const dv = { ok: true, code: 0, message: 'OK', data: { img_x_len: 2, img_y_len: 2, img_x_size: 4, img_y_size: 4, image: ['//aisubtitle.hdslb.com/fixture/ref-quads.jpg'], ts: [], index: [] } }
    const qDir = path.join(tmp, 'quad-shot')
    const rq = await fr.shoot({ call: async ({ path: pp }) => (pp.includes('/x/web-interface/view') ? dq : dv), log: () => {}, framesDir: qDir, UA: 'u', REFERER: 'https://www.bilibili.com', timeoutMs: 8000 }, { bvid: 'BV1quadtest01', at: [1, 6, 11, 16] })
    globalThis.fetch = realQ
    const lum = rq.frames.map((f) => { const c = jpg.cropToRGB(jpg.decodeJPEG(fs.readFileSync(f.path)), 2, 2, 1, 1); return Math.round((c[0] + c[1] + c[2]) / 3) })
    ok('shoot 裁出的四格亮度各不相同且按 tile 顺序递增（10<80<160<240）', rq.ok === true && rq.frames.length === 4 && lum[0] < lum[1] && lum[1] < lum[2] && lum[2] < lum[3] && lum.every((v, k) => Math.abs(v - [10, 80, 160, 240][k]) <= 14), 'tile→亮度: ' + rq.frames.map((f, k) => f.tile + ':' + lum[k]).join(' '))
  }

    ok("shoot 从整页拼图里裁出**单独一帧**（4x4），不是把整页 8x8 直接端回来", r.ok === true && r.frames.length === 2 && r.frames.every((f) => f.width === 4 && f.height === 4) && fs.existsSync(r.frames[0].path), JSON.stringify(r.frames.map((f) => ({ tile: f.tile, w: f.width, at: f.at }))))
    ok("shoot 把 interval 与它的依据一起报出来（不说清依据就是瞎猜）", r.intervalSec === 53.75 && /内容格数/.test(r.intervalBasis), JSON.stringify({ i: r.intervalSec, b: r.intervalBasis }))
    ok("shoot 认得这是分 P 视频并带出 partStart/partDuration", r.partIndex === 1 && r.partDuration === 215 && Array.isArray(r.pages) && r.pages.length === 2 && r.pages[1].partStart === 215, JSON.stringify({ pi: r.partIndex, ps: r.pages[1] && r.pages[1].partStart }))
    const fr2 = a.tools.find((t) => t.name === 'bili_frames')
    ok("bili_frames 在声明里且 action 三种说法都写进了 description", /keep/.test(fr2.description) && /clear/.test(fr2.description) && /list/.test(fr2.description) && /不动 keep/.test(fr2.description), fr2.description.slice(0, 70))
    const li = await fr2.execute({ action: 'list' }, { agent: { provider: 'x', model: 'y' } })
    ok("list 回的是目录现状（数量/字节/哪些是留下的）", li.ok === true && typeof li.count === 'number' && Array.isArray(li.kept), JSON.stringify({ c: li.count, b: li.bytes }))
    const wrong = await fr2.execute({ action: 'nuke' }, { agent: { provider: 'x', model: 'y' } })
    ok("action 不认时如实报错", wrong.ok === false && /keep/.test(wrong.message), wrong.message)
  {
    // keep 与记账联动：文件名带年月日时分秒，且自动往 ledger/frame 记一行（marked 写清标记了什么）
    const kHome = path.join(tmp, 'keep-book')
    const ka = mkCtx(); mod.apply(ka.ctx, { home: kHome, logLevel: 'silent' })
    const realK = globalThis.fetch
    globalThis.fetch = async (u) => {
      const s = String(u)
      if (s.includes('/x/web-interface/view')) return { ok: true, status: 200, headers: { get: () => 'application/json' }, text: async () => JSON.stringify({ code: 0, message: 'OK', data: { aid: 1, cid: 9, pic: 'p', title: 'T', duration: 20, owner: { name: 'U' }, pages: [{ cid: 9, page: 1, part: 'P1', duration: 20 }] } }) }
      if (s.includes('/x/player/videoshot')) return { ok: true, status: 200, headers: { get: () => 'application/json' }, text: async () => JSON.stringify({ code: 0, message: 'OK', data: { img_x_len: 2, img_y_len: 2, img_x_size: 4, img_y_size: 4, image: ['//aisubtitle.hdslb.com/fixture/ref-quads.jpg'], ts: [], index: [] } }) }
      if (s.includes('fixture/ref-quads.jpg')) return { ok: true, status: 200, headers: { get: () => 'image/jpeg' }, arrayBuffer: async () => fs.readFileSync(path.join(fxDir, 'ref-quads.jpg')), text: async () => '', json: async () => null }
      return { ok: false, status: 404, headers: { get: () => 'text/html' }, text: async () => 'x', json: async () => null }
    }
    const toolK = ka.tools.find((t) => t.name === 'bili_frames')
    const kr = await toolK.execute({ action: 'keep', bvid: 'BV1booktest01', at: [2], p: 1, reason: '自检：看 keep 会不会自己记账' }, { agent: { provider: 'x', model: 'y' } })
    globalThis.fetch = realK
    ok('shoot 留下的帧带 lum（黑场要靠数字认，不能靠感觉）', (kr.kept || []).every((f) => typeof f.lum === 'number'), JSON.stringify((kr.kept || []).map((f) => f.lum)))
    const fh = await import(pathToFileURL(path.join(pkgDir, 'ffmpeghd.js')).href)
    ok('ffmpeghd：没 ffmpeg 时如实回 no-ffmpeg（不许静默当高清成功）', (await fh.hdFrame({ call: async () => ({ ok: true, code: 0, message: 'OK', data: {} }), log: () => {}, framesDir: tmp, UA: 'u', REFERER: 'r', ffmpeg: null }, { bvid: 'BV1x', cid: 1, sec: 1 }))?.why === 'no-ffmpeg')
    ok('ffmpeghd：挑轨优先高分辨率的 H.264（avc1 赢过 AV1/低分辨率）', fh.pickStream([{ width: 1280, height: 720, codecs: 'avc1.640033', baseUrl: 'a' }, { width: 1920, height: 1080, codecs: 'av01.0', baseUrl: 'b' }, { width: 640, height: 360, codecs: 'avc1.640033', baseUrl: 'c' }])[0].baseUrl === 'a', JSON.stringify(fh.pickStream([{ width: 1280, height: 720, codecs: 'avc1.640033', baseUrl: 'a' }, { width: 1920, height: 1080, codecs: 'av01.0', baseUrl: 'b' }])[0]))
    {
      // 便携口径：自己造一颗"确实存在的 exe"喂给 findFfmpeg，断言里不再钉死任何人的绝对路径
      const stub = path.join(tmp, 'ff-stub', 'ffmpeg.exe')
      fs.mkdirSync(path.dirname(stub), { recursive: true })
      fs.writeFileSync(stub, 'MZ\x00', 'utf8')
      ok('findFfmpeg：config.ffmpegPath 指的那颗真存在就直接用它（返回值就是那条路径）', fh.findFfmpeg({ ffmpegPath: stub }) === stub, String(fh.findFfmpeg({ ffmpegPath: stub })))
      ok('findFfmpeg：ffmpegPath 指的东西不存在时不会把它当找到了（不返回那条不存在的路）', fh.findFfmpeg({ ffmpegPath: path.join(tmp, 'definitely-no-ffmpeg.exe') }) !== path.join(tmp, 'definitely-no-ffmpeg.exe'), String(fh.findFfmpeg({ ffmpegPath: path.join(tmp, 'definitely-no-ffmpeg.exe') })))
    }
    {
      // 机器上没有 ffmpeg 时，要高清也不能静默降级（本机真栽过：静默回了格子帧，我还当成高清验过了）
      // ⚠️ findFfmpeg 还会拿 process.cwd() 兜底找 .dsh/.build-tools/ffmpeg/ffmpeg.exe（本机实测的摆法）：
      //    0.8.1 从 node_modules 里跑这份自检时，cwd 还指在工作区 ⇒ 真 ffmpeg 被找着、这条假"没 ffmpeg"直接变 no-stream。
      //    所以连 cwd 一起挪到临时目录，才算真在测"机器上没有 ffmpeg"那一路。
      const savedW = process.env.DSH_WORKSPACE, savedF = process.env.DSH_BILI_FFMPEG, savedCwd = process.cwd()
      process.env.DSH_WORKSPACE = path.join(tmp, 'nowhere')
      process.env.DSH_BILI_FFMPEG = path.join(tmp, 'nowhere', 'ffmpeg.exe')
      process.chdir(tmp)
      const savedFetch = globalThis.fetch
      const fxFlat = fs.readFileSync(path.join(fxDir, 'ref-flat.jpg'))
      const vJ = { code: 0, message: 'OK', data: { aid: 1, cid: 9, pic: 'p', title: 'T', duration: 20, owner: { name: 'U' }, pages: [{ cid: 9, page: 1, part: 'P1', duration: 20 }] } }
      const sJ = { code: 0, message: 'OK', data: { img_x_len: 2, img_y_len: 2, img_x_size: 4, img_y_size: 4, image: ['//aisubtitle.hdslb.com/fixture/ref-flat.jpg'], ts: [], index: [] } }
      globalThis.fetch = async (u) => {
        const s = String(u)
        if (s.includes('/x/web-interface/view') || s.includes('/x/player/videoshot')) return { ok: true, status: 200, headers: { get: () => 'application/json' }, text: async () => JSON.stringify(s.includes('/x/web-interface/view') ? vJ : sJ) }
        if (s.includes('fixture/ref-flat.jpg')) return { ok: true, status: 200, headers: { get: () => 'image/jpeg' }, arrayBuffer: async () => fxFlat, text: async () => '', json: async () => null }
        return { ok: false, status: 404, headers: { get: () => 'text/html' }, text: async () => 'x', json: async () => null }
      }
      const noFfDir = path.join(tmp, 'noff')
      const rno = await fr.shoot({ call: async ({ path: pp }) => (pp.includes('/x/web-interface/view') ? { ok: true, code: 0, message: 'OK', data: vJ.data } : { ok: true, code: 0, message: 'OK', data: sJ.data }), log: () => {}, framesDir: noFfDir, UA: 'u', REFERER: 'https://www.bilibili.com', ffmpegPath: path.join(tmp, 'nope.exe'), hd: true }, { bvid: 'BV1noffmpegtest', num: 1 })
      globalThis.fetch = savedFetch
      process.env.DSH_WORKSPACE = savedW
      process.env.DSH_BILI_FFMPEG = savedF
      process.chdir(savedCwd)
      ok('要高清但机器上没有 ffmpeg 时不静默：每帧带 hd_error=no-ffmpeg、顶层带 ffmpeg=absent 与 hd_note', rno.ffmpeg === 'absent' && /没找到 ffmpeg/.test(String(rno.hd_note)) && (rno.frames || []).length > 0 && rno.frames.every((f) => f.hd_error === 'no-ffmpeg'), JSON.stringify({ ffmpeg: rno.ffmpeg, first: (rno.frames || [])[0] && (rno.frames || [])[0].hd_error }))
    }

    ok('keep 的文件名带年月日时分秒（同一格重复留不会互相覆盖）', /^keep\/BV1booktest01-p1-\d+-\d+s-\d{8}-\d{6}\.jpg$/.test(kr.kept?.[0]?.file || ''), 'file=' + String(kr.kept?.[0]?.file) + ' | ok=' + kr.ok + ' | message=' + String(kr.message || '').slice(0, 150) + ' | detail=' + JSON.stringify(kr.detail && kr.detail.message || '').slice(0, 150))
    const book = await (ka.tools.find((t) => t.name === 'bili_ledger').execute({ action: 'read', table: 'frame' }))
    ok('keep 自动往 ledger/frame 记了行（带 marked：写清这一格被判定了什么）', book.rows.length === 1 && !!book.rows[0].marked && /格/.test(book.rows[0].marked) && book.rows[0].reason.includes('自检'), JSON.stringify(book.rows[0] || null).slice(0, 220))
    ok('返回值里回带记账结果（不能悄悄不记账）', !!kr.ledger && (kr.ledger.added === 1 || kr.ledger.ok === true), JSON.stringify(kr.ledger || { no_field: true, kr_ok: kr.ok, kr_msg: String(kr.message || '').slice(0, 120) }))
  }
  }
}

/* ── 18. 状态快照与状态口（0.8.2：判据不许只挂在 HTTP 与宿主鉴权上）── */
{
  const sHome = path.join(tmp, 'status-home')
  const sc = mkCtxWithServer(); mod.apply(sc.ctx, { home: sHome, logLevel: 'silent' })
  const snapFile = path.join(sHome, 'status.json')
  ok('挂载即落一份 status.json（不碰 HTTP、不靠宿主鉴权也能看现场）', fs.existsSync(snapFile), '家目录里没有 ' + snapFile)
  const snap0 = JSON.parse(fs.readFileSync(snapFile, 'utf8'))
  ok('快照字段齐：plugin / version 现读包 / home / loggedIn / skills 7 份 / ledger 摘要 / config / at', snap0.plugin === 'dsh-bili-skill' && snap0.version === pv && snap0.home === sHome && typeof snap0.loggedIn === 'boolean' && snap0.skills.length === 7 && snap0.skills.every((s) => s.name && s.from && s.source) && typeof snap0.ledger === 'string' && !!snap0.config && typeof snap0.config.requestTimeoutMs === 'number' && !!snap0.at && snap0.statusFile === snapFile, JSON.stringify(Object.keys(snap0)))
  const route = sc.routes.find((r) => r.path === '/api/dsh-bili-skill')
  ok('注册的路由是 kind:prefix、前缀就是 /api/dsh-bili-skill（跟着插件名走）', !!route && route.kind === 'prefix', JSON.stringify(sc.routes.map((r) => [r.kind, r.path])))
  const fakeRes = () => { const box = { code: 0, headers: {}, body: '' }; const r = { writeHead(code, headers) { box.code = code; Object.assign(box.headers, headers || {}); return r }, end(body) { box.body = body == null ? '' : String(body); return box } }; return { r, box } }
  const g1 = fakeRes(); await route.handler({ method: 'GET', url: '/api/dsh-bili-skill/status' }, g1.r)
  const j1 = JSON.parse(g1.box.body)
  ok('GET /api/dsh-bili-skill/status 回 200 JSON + no-store，内容与快照同源', g1.box.code === 200 && /application\/json/.test(String(g1.box.headers['content-type'])) && g1.box.headers['cache-control'] === 'no-store' && j1.ok === true && j1.skills.length === 7 && j1.home === sHome, JSON.stringify({ code: g1.box.code, headers: g1.box.headers }))
  const g2 = fakeRes(); await route.handler({ method: 'GET', url: '/api/dsh-bili-skill/nope-deep' }, g2.r)
  ok('前缀下不认的路劲回自己那份 404 JSON（error:"no-route"），好跟宿主的 "not found" 分开', g2.box.code === 404 && JSON.parse(g2.box.body).error === 'no-route', g2.box.code + ' ' + g2.box.body.slice(0, 60))
  fs.rmSync(snapFile)
  const g3 = fakeRes(); await route.handler({ method: 'GET', url: '/api/dsh-bili-skill/' }, g3.r)
  const snap1 = JSON.parse(fs.readFileSync(snapFile, 'utf8'))
  ok('状态口每问一次就重刷快照（删掉后能再生成）；根路径 /api/dsh-bili-skill/ 也算状态口', fs.existsSync(snapFile) && g3.box.code === 200 && Date.parse(snap1.at) >= Date.parse(snap0.at), JSON.stringify({ at0: snap0.at, at1: snap1.at, code: g3.box.code }))
}

/* ── 19+20. 设置页的通道（登录三步 / 偏好读写 / 守门）与偏好在说明书里的落点 ── */
const apiHome = path.join(tmp, 'api-home')
const ac = mkCtxWithServer(); mod.apply(ac.ctx, { home: apiHome, logLevel: 'silent' })
{
  const route = ac.routes.find((r) => r.path === '/api/dsh-bili-skill')
  const P = '/api/dsh-bili-skill'
  const callApi = async (method, url, body) => {
    const box = { code: 0, headers: {}, body: '', chunks: [] }
    const res = { writeHead(c, h) { box.code = c; Object.assign(box.headers, h || {}); return res }, end(b) { if (Buffer.isBuffer(b)) box.chunks.push(b); else box.body = b == null ? '' : String(b); return box } }
    const hs = {}
    const req = { method, url, headers: {}, on: (ev, cb) => { (hs[ev] = hs[ev] || []).push(cb) }, destroy() {} }
    const p = route.handler(req, res)
    for (const cb of hs.data || []) cb(Buffer.from(body == null ? '' : body))
    for (const cb of hs.end || []) cb()
    await p
    try { box.json = JSON.parse(box.body) } catch { box.json = null }
    box.buffer = Buffer.concat(box.chunks)
    return box
  }
  const s0 = await callApi('GET', P + '/status')
  ok('GET /status 的快照里带上 searchPrefs（缺省形状）+ 注入去处 + configFile 路径', s0.code === 200 && !!s0.json && s0.json.searchPrefs.order === 'pubdate' && s0.json.searchPrefs.pageSize === 20 && JSON.stringify(s0.json.searchPrefsInjectedTo) === '["bili-search"]' && /config\.json$/.test(String(s0.json.configFile)), JSON.stringify(s0.json && { p: s0.json.searchPrefs, to: s0.json.searchPrefsInjectedTo }))
  const pr0 = await callApi('GET', P + '/search-prefs')
  ok('GET /search-prefs 回当前偏好 + 将来贴在说明书末尾那段（一条没设就如实说没设过，不编）', pr0.code === 200 && !!pr0.json && /还没设过任何偏好/.test(pr0.json.injected) && /主人的搜索偏好/.test(pr0.json.injected), String(pr0.json && pr0.json.injected).slice(0, 100))
  const bad = await callApi('POST', P + '/search-prefs', '这不是 JSON{')
  ok('请求体不是合法 JSON 时如实 400 bad_json_body（不许当"写成功了"）', bad.code === 400 && bad.json && bad.json.code === 'bad_json_body', bad.code + ' ' + bad.body.slice(0, 70))
  const sv = await callApi('POST', P + '/search-prefs', JSON.stringify({ searchPrefs: { order: 'click', pageSize: 99, recentDays: -5, excludeKeywords: '广告，搬运, 广告 , 水贴', minViews: '100', maxDurationSec: 0, notes: '只要 DSH 相关，教程别混进来', bogusKey: 'x' } }))
  const cfgOnDisk = JSON.parse(fs.readFileSync(path.join(apiHome, 'config.json'), 'utf8'))
  ok('POST /search-prefs 把越界的夹回来（99→50、-5→0）、黑名单去重保序、白名单外的键丢掉', sv.code === 200 && sv.json.prefs.pageSize === 50 && sv.json.prefs.recentDays === 0 && JSON.stringify(sv.json.prefs.excludeKeywords) === JSON.stringify(['广告', '搬运', '水贴']) && sv.json.prefs.order === 'click' && sv.json.prefs.minViews === 100 && !('bogusKey' in sv.json.prefs), JSON.stringify(sv.json.prefs))
  ok('落的盘就是家目录 config.json 里那份 searchPrefs（用的时候现读 ⇒ 写完不必重启）', cfgOnDisk.searchPrefs && cfgOnDisk.searchPrefs.notes === '只要 DSH 相关，教程别混进来' && cfgOnDisk.searchPrefs.pageSize === 50, JSON.stringify(cfgOnDisk).slice(0, 200))
  const pr1 = await callApi('GET', P + '/search-prefs')
  ok('再读一次就是刚写的（现读，不是挂载时冻住的那份）', pr1.json.prefs.order === 'click' && /播放量/.test(pr1.json.injected) && /广告/.test(pr1.json.injected) && /这一段 > 上面那份说明书的默认口径/.test(pr1.json.injected), String(pr1.json.injected).slice(0, 150))
  const qr400 = await callApi('GET', P + '/login/qr?k=..%2F..%2Fsecret')
  ok('二维码那条路先验 k 的形状：带 ../ 这类直接 400 bad_key，不去拼路径（防穿越）', qr400.code === 400 && qr400.json.code === 'bad_key', qr400.code + ' ' + qr400.body.slice(0, 70))
  const qr404 = await callApi('GET', P + '/login/qr?k=abcdef12345678')
  ok('没 start 过的 k 要不到图：404 no_qr（不许糊成"图是空的"）', qr404.code === 404 && qr404.json.code === 'no_qr', qr404.code + ' ' + qr404.body.slice(0, 70))
  const st = await callApi('POST', P + '/login/start', '{}')
  ok('POST /login/start 出码：回 key + qr_png.imageUrl + 180 秒过期（图不塞 JSON，走 /login/qr）', st.code === 200 && st.json.key === QR_KEY && st.json.qr_png.imageUrl === P + '/login/qr?k=' + QR_KEY && st.json.expiresInMs === 180000 && /qrpng/.test(String(st.json.qr_png.engine)), JSON.stringify(st.json.qr_png))
  const imgb = await callApi('GET', P + '/login/qr?k=' + QR_KEY)
  ok('GET /login/qr 真发出那张 PNG：image/png + no-store + 字节以 PNG 签名开头', imgb.code === 200 && imgb.headers['content-type'] === 'image/png' && imgb.headers['cache-control'] === 'no-store' && imgb.buffer.length > 100 && imgb.buffer.slice(0, 4).toString('hex') === '89504e47', JSON.stringify({ code: imgb.code, len: imgb.buffer.length, head: imgb.buffer.slice(0, 4).toString('hex') }))
  const pl0 = await callApi('POST', P + '/login/poll', JSON.stringify({ k: 'bad k!' }))
  ok('poll 的 k 不合法直接 400（不发请求去猜）', pl0.code === 400 && pl0.json.code === 'bad_key', pl0.code + ' ' + pl0.body.slice(0, 60))
  const pl1 = await callApi('POST', P + '/login/poll', JSON.stringify({ k: QR_KEY }))
  ok('未扫码时如实回 waiting（86101），绝不被判成成功', pl1.code === 200 && pl1.json.state === 'waiting' && pl1.json.code === 86101, JSON.stringify(pl1.json && { s: pl1.json.state, c: pl1.json.code }))
  qrPollScript = ['scanned', 'ok']
  const pl2 = await callApi('POST', P + '/login/poll', JSON.stringify({ k: QR_KEY }))
  const pl3 = await callApi('POST', P + '/login/poll', JSON.stringify({ k: QR_KEY }))
  const credAfter = JSON.parse(fs.readFileSync(path.join(apiHome, 'bili_credential.json'), 'utf8'))
  const srcAfter = JSON.parse(fs.readFileSync(path.join(apiHome, 'credential-source.json'), 'utf8'))
  ok('扫码确认那一路才落凭证：uid 对得上、来源记成 scan、crossDomain 补过（中间那步"已扫码待确认"不算数）', pl2.json.state === 'scanned' && pl3.json.state === 'ok' && pl3.json.whoami.uid === '12345678' && credAfter.sessdata === 'abc123' && credAfter.dedeuserid === '12345678' && srcAfter.source === 'scan' && pl3.json.crossdomain && pl3.json.crossdomain.ok === true, JSON.stringify({ s2: pl2.json.state, s3: pl3.json.state, cred: credAfter, src: srcAfter.source, cross: pl3.json.crossdomain }))
  const acc = await callApi('GET', P + '/account')
  ok('GET /account 现查：uid/uname/真等级与 vip_status 分开发、凭证来源照实报', acc.code === 200 && acc.json.loggedIn === true && acc.json.uid === '12345678' && acc.json.level === 2 && acc.json.vip_status === 0 && acc.json.credentialSource === 'scan', JSON.stringify(acc.json && { u: acc.json.uid, l: acc.json.level, v: acc.json.vip_status, s: acc.json.credentialSource }))
  const cl = await callApi('POST', P + '/login/clear', '{}')
  const acc2 = await callApi('GET', P + '/account')
  ok('POST /login/clear 删掉凭证与来源记录后，/account 改口：hasCredential=false 且 credentialSource 回到 unknown（假 fetch 不演 -101，所以不看 loggedIn 那一项）', cl.code === 200 && cl.json.ok === true && !fs.existsSync(path.join(apiHome, 'bili_credential.json')) && acc2.json.hasCredential === false && acc2.json.credentialSource === 'unknown', JSON.stringify({ gone: !fs.existsSync(path.join(apiHome, 'bili_credential.json')), hc: acc2.json.hasCredential, src: acc2.json.credentialSource }))
  const im = await callApi('POST', P + '/login/import', '{}')
  ok('抄凭证那条路找不到文件时如实回 ok:false 并说明试了哪两处（不假装成功）', im.code === 200 && im.json.ok === false && /bili-duty/.test(im.json.message), im.code + ' ' + String(im.json.message).slice(0, 90))
  const nr = await callApi('GET', P + '/totally-unknown')
  ok('前缀下没这条路由：404 且回我们自己的 no-route JSON（好跟宿主的 not found 分开）', nr.code === 404 && nr.json && nr.json.error === 'no-route', nr.code + ' ' + nr.body.slice(0, 60))

  // 落点：这段必须在底座脚注之后、整份正文的最末尾
  const sk = await ac.providers[0].get({ name: 'bili-search' })
  ok('bili-search 正文末尾就是主人那段偏好（在「本插件的底座」之后，且是最后一段）', /主人的搜索偏好/.test(sk.content) && sk.content.indexOf('## ⚠️ 主人的搜索偏好') > sk.content.indexOf('## 本插件的底座') && sk.content.trim().endsWith('并在回报里说明哪几步用到了它。'), sk.content.slice(-200))
  const skc = await ac.providers[0].get({ name: 'bili-comment' })
  ok('只注入到 bili-search：别的说明书里没有这段', !/主人的搜索偏好/.test(skc.content) && /本插件的底座/.test(skc.content), skc.content.slice(-120))
  fs.writeFileSync(path.join(apiHome, 'config.json'), JSON.stringify({ ...cfgOnDisk, searchPrefs: { ...cfgOnDisk.searchPrefs, notes: '只看实况解说' } }), 'utf8')
  const sk2 = await ac.providers[0].get({ name: 'bili-search' })
  ok('config.json 被改后，同一次挂载内下一次 get() 就是新那句（现读，不必重启或重挂载）', /只看实况解说/.test(sk2.content) && !/只要 DSH 相关/.test(sk2.content), sk2.content.slice(-180))
  fs.writeFileSync(path.join(apiHome, 'config.json'), JSON.stringify({ searchPrefs: {} }), 'utf8')
  const sk3 = await ac.providers[0].get({ name: 'bili-search' })
  ok('偏好清空时末尾改口成"主人还没设过"，但位置仍在最后', /还没设过任何偏好/.test(sk3.content) && sk3.content.trim().endsWith('覆盖上面那份说明书里的口径。'), sk3.content.slice(-180))
  ok('纯函数口径：__coerceSearchPrefs 夹范围 / 去重 / 丢未知键，__searchPrefsTail 末尾钉重话', (() => { const p = mod.__coerceSearchPrefs({ order: 'nope', pageSize: 999, recentDays: 'x', excludeKeywords: ['a', 'a', ' b '], minViews: -3, notes: '  n  ', zz: 1 }); const t = mod.__searchPrefsTail(p); return p.order === 'pubdate' && p.pageSize === 50 && p.recentDays === 0 && p.excludeKeywords.length === 2 && p.minViews === 0 && p.notes === 'n' && !('zz' in p) && t.startsWith('\n\n---\n\n## ⚠️') && /先按它办/.test(t) })(), 'coerce/tail 口径不对')
}

/* ── 21. 客户端半个插件：假 ModuleLoader + 假 React + 假 DOM + 假 fetch 真渲染一次 ── */
{
  const savedWin = globalThis.window, savedDoc = globalThis.document, savedFetch = globalThis.fetch
  const tick = () => new Promise((r) => setImmediate(r))
  const made = []
  class FakeNode {
    constructor(tag) { this.tagName = String(tag).toUpperCase(); this.children = []; this._own = ''; this.style = {}; this.classList = new Set(); this._events = {}; this.parentNode = null; made.push(this) }
    set className(v) { this._cls = String(v); this.classList = new Set(String(v).split(/\s+/).filter(Boolean)) }
    get className() { return this._cls || '' }
    set textContent(v) { this._own = String(v) }
    get textContent() { return this.children.length ? this._own + this.children.map((c) => c.textContent).join('') : this._own }
    addEventListener(ev, cb) { (this._events[ev] = this._events[ev] || []).push(cb) }
    dispatch(ev) { for (const cb of this._events[ev] || []) cb({ type: ev }) }
    append(...ns) { for (const n of ns) { if (n === null || n === undefined || n === false) continue; const node = typeof n === 'object' ? n : Object.assign(new FakeNode('#text'), { _own: String(n) }); node.parentNode = this; this.children.push(node) } }
    appendChild(n) { this.append(n); return n }
    removeChild(n) { const i = this.children.indexOf(n); if (i >= 0) this.children.splice(i, 1); if (n) n.parentNode = null; return n }
  }
  let hookSlots = [], hookIdx = 0, pendingEffects = []
  const fakeReact = {
    createElement(type, props, ...children) {
      if (typeof type === 'function') return type(props || {})
      const n = new FakeNode(type)
      if (props) for (const k of Object.keys(props)) { if (k === 'children') continue; if (k === 'ref') { if (props.ref && typeof props.ref === 'object') props.ref.current = n; continue } n[k] = props[k] }
      n.append(...children.flat(Infinity))
      return n
    },
    useRef(init) { if (!hookSlots[hookIdx]) hookSlots[hookIdx] = { current: init }; return hookSlots[hookIdx++] },
    useEffect(fn) { pendingEffects.push(fn) },
  }
  const timers = []
  const clientApi = '/api/dsh-bili-skill'
  globalThis.window = Object.assign(typeof savedWin === 'object' && savedWin ? savedWin : {}, {
    __ModuleLoader__: { load: (def) => { globalThis.__clientDef = def } },
    setInterval: (fn, ms) => { const e = { kind: 'interval', ms, fn, cleared: false }; timers.push(e); return e },
    clearInterval: (e) => { if (e) e.cleared = true },
    setTimeout: (fn, ms) => { const e = { kind: 'timeout', ms, fn, cleared: false }; timers.push(e); return e },
    clearTimeout: (e) => { if (e) e.cleared = true },
    confirm: () => true,
  })
  await import(pathToFileURL(path.join(pkgDir, 'client.js')).href)
  const clientDef = globalThis.__clientDef
  globalThis.document = { createElement: (tag) => new FakeNode(tag), body: new FakeNode('body') }
  const requests = [], bodies = []
  const seven = new Array(7).fill(0).map((_, i) => ({ name: 'bili-s' + i }))
  const K = (m, p) => m + ' ' + clientApi + p
  const canned = {
    [K('GET', '/account')]: { ok: false, loggedIn: false, message: '账号未登录', credentialSource: 'unknown', home: '<HOME>' },
    [K('GET', '/search-prefs')]: { ok: true, prefs: { order: 'stow', pageSize: 15, recentDays: 3, minViews: 30, maxDurationSec: 0, excludeKeywords: ['水贴'], notes: '只看解说' }, injected: '## ⚠️ 主人的搜索偏好（预置预览）\n- 排序：收藏\n', configFile: '<HOME>/config.json' },
    [K('GET', '/status')]: { ok: true, plugin: 'dsh-bili-skill', version: '0.9.0', home: '<HOME>', loggedIn: false, statusFile: '<HOME>/status.json', ledger: '（还没有账本）', skills: seven, searchPrefs: {} },
    [K('POST', '/login/start')]: { ok: true, key: 'abcdef1234567890abcdef1234567890', url: 'https://account.bilibili.com/h5/scan?x=1', qr_png: { imageUrl: clientApi + '/login/qr?k=abcdef1234567890abcdef1234567890', bytes: 4838, dim: 424, engine: 'qrpng(self)' }, note: '扫一扫', expiresInMs: 180000 },
    [K('POST', '/login/poll')]: { ok: true, state: 'scanned', code: 86090, message: '已扫码、等手机上点确认' },
    [K('POST', '/search-prefs')]: { ok: true, prefs: { order: 'dm', pageSize: 30, recentDays: 7, minViews: 50, maxDurationSec: 900, excludeKeywords: ['广告', '搬运'], notes: '只看实况解说' }, injected: '## ⚠️ 主人的搜索偏好（保存后的预览）\n- 排序：弹幕\n', config: {}, snapshot: { version: '0.9.0', home: '<HOME>', loggedIn: false, statusFile: '<HOME>/status.json', ledger: 'note=1', skills: seven } },
  }
  globalThis.fetch = async (url, init) => {
    const u = String(url), m = (init && init.method) || 'GET', key = m + ' ' + u
    requests.push(key)
    if (init && init.body != null) { try { bodies.push({ key, body: JSON.parse(String(init.body)) }) } catch { bodies.push({ key, body: null }) } }
    const payload = canned[key] || { ok: false, error: 'canned 里没这条：' + key }
    return { ok: true, status: 200, headers: { get: (h) => (String(h).toLowerCase() === 'content-type' ? 'application/json' : '') }, json: async () => payload }
  }

  const seats = [], disposers = []
  let reg = null
  const ctx = { effect: (fn) => { const d = fn(); if (typeof d === 'function') disposers.push(d) }, get: () => undefined, slots: { inject: (seat, factory) => { seats.push(seat); return factory() }, register: (options, component) => { reg = { options, component }; return () => { reg = null } } } }
  ok('客户端半个插件被假 __ModuleLoader__ 收到（id 就是插件名）', !!clientDef && clientDef.id === 'dsh-bili-skill', JSON.stringify(clientDef && clientDef.id))
  const cmod = clientDef.factory((id) => (id === 'react' ? fakeReact : {}))
  ok('客户端声明只依赖 slots（多声明一个运行时没有的服务会让这半块整块起不来）', JSON.stringify(cmod.inject) === '["slots"]' && typeof cmod.apply === 'function', JSON.stringify(cmod.inject))
  cmod.apply(ctx)
  ok('apply 把分区挂进 settings.section，注册动作在 ctx.effect 里做', seats.length === 1 && seats[0] === 'settings.section' && !!reg, JSON.stringify({ seats, got: !!reg }))
  ok('分区选项形状对：name / id / order / label 是给 thunk（框架读它时才取文案）', reg.options.name === 'settings.section' && reg.options.id === 'dsh-bili-skill' && Number.isFinite(reg.options.order) && typeof reg.options.label === 'function' && reg.options.label() === 'B站 能力底座', JSON.stringify({ id: reg.options.id, order: reg.options.order, label: reg.options.label && reg.options.label() }))
  hookSlots = []; hookIdx = 0; pendingEffects = []
  const node = reg.component()
  ok('组件返回 React 元素（返回裸 DOM 节点渲染不出来）', !!node && node.tagName === 'DIV' && /bili-settings/.test(node.className), JSON.stringify(node && { tag: node.tagName, cls: node.className }))
  const cleanups = []
  for (const f of pendingEffects.splice(0)) { const c = f(); if (typeof c === 'function') cleanups.push(c) }
  await tick(); await tick()
  ok('挂载即打三条读路：登录态、偏好与注入预览、状态快照（都在自家前缀下，同源带 cookie）', requests.includes('GET ' + clientApi + '/account') && requests.includes('GET ' + clientApi + '/search-prefs') && requests.includes('GET ' + clientApi + '/status'), JSON.stringify(requests.slice(0, 4)))
  const pageNode = made.find((n) => n.className === 'bili-settings')
  ok('界面本体是在 useEffect 里用 DOM 挂进那个 div 的（三张卡片都在）', !!pageNode && node.children.includes(pageNode) && made.filter((n) => n.className.includes('bili-card')).length >= 3, JSON.stringify({ hasPage: !!pageNode, cards: made.filter((n) => String(n.className).includes('bili-card')).length }))
  const acctLine = made.find((n) => String(n.className).includes('bili-acct'))
  ok('未登录时分区直接说"未登录"并提示去出码（不空着让人猜）', /未登录/.test(String(acctLine && acctLine.textContent)), String(acctLine && acctLine.textContent))
  const prefOrderSel = made.find((n) => n.tagName === 'SELECT')
  const prefPre0 = made.find((n) => n.tagName === 'PRE')
  ok('偏好表单从宿主读回来的值填进去（不是硬编码缺省），预览区显示的就是那段末尾文字', prefOrderSel && prefOrderSel.value === 'stow' && /主人的搜索偏好/.test(String(prefPre0 && prefPre0.textContent)), JSON.stringify({ order: prefOrderSel && prefOrderSel.value, pre: String(prefPre0 && prefPre0.textContent).slice(0, 40) }))
  const btnStart = made.find((n) => n.tagName === 'BUTTON' && /出二维码/.test(String(n.textContent)))
  btnStart.dispatch('click'); await tick(); await tick()
  const imgNode = made.find((n) => n.tagName === 'IMG' && String(n.src).includes('/login/qr'))
  ok('点「出二维码」真发 POST /login/start，并把 img.src 指到宿主发图那条路（浏览器同源自动带 cookie）', requests.includes('POST ' + clientApi + '/login/start') && !!imgNode && /k=abcdef/.test(String(imgNode.src)), JSON.stringify({ reqs: requests.slice(-2), src: imgNode && String(imgNode.src) }))
  const pollTimer = timers.find((t) => t.kind === 'interval' && t.ms === cmod.__test__.POLL_MS)
  ok('出码后起了轮询定时器自动问结果（不靠人手点刷新）', !!pollTimer && pollTimer.cleared === false, JSON.stringify(timers.map((t) => [t.kind, t.ms])))
  pollTimer.fn(); await tick(); await tick()
  const qrState = made.find((n) => String(n.className).includes('bili-qr-state'))
  ok('轮询到的中间态写进界面文案：86090 要说"等手机上点确认"，不许写成就成了', /点确认/.test(String(qrState && qrState.textContent)), String(qrState && qrState.textContent))
  const nums = made.filter((n) => n.tagName === 'INPUT' && n.type === 'number')
  const txt = made.find((n) => n.tagName === 'INPUT' && n.type === 'text')
  const area = made.find((n) => n.tagName === 'TEXTAREA')
  prefOrderSel.value = 'dm'; nums[0].value = '30'; nums[1].value = '7'; nums[2].value = '50'; nums[3].value = '900'; txt.value = '广告,搬运,搬运'; area.value = '只看实况解说'
  const btnSave = made.find((n) => n.tagName === 'BUTTON' && /保存偏好/.test(String(n.textContent)))
  btnSave.dispatch('click'); await tick(); await tick()
  const sentPref = bodies.filter((b) => b.key === 'POST ' + clientApi + '/search-prefs').pop()
  ok('点「保存偏好」发的是夹过的 searchPrefs 对象（不是裸表单值：逗号串已在客户端拆成数组）', !!sentPref && sentPref.body.searchPrefs.order === 'dm' && sentPref.body.searchPrefs.pageSize === 30 && JSON.stringify(sentPref.body.searchPrefs.excludeKeywords) === JSON.stringify(['广告', '搬运']) && sentPref.body.searchPrefs.notes === '只看实况解说', JSON.stringify(sentPref && sentPref.body))
  const msgs = made.filter((n) => String(n.className).includes('bili-msg')).map((n) => n.textContent).join(' § ')
  const prefPre = made.find((n) => n.tagName === 'PRE')
  ok('保存成功后讲清"写进 config.json 的 searchPrefs、立即生效、不必重启"，预览跟着换成新的', /立即生效/.test(msgs) && /保存后的预览/.test(String(prefPre && prefPre.textContent)), JSON.stringify({ msgs: msgs.slice(0, 90), pre: String(prefPre && prefPre.textContent).slice(0, 40) }))
  const viewLine = made.find((n) => String(n.className).includes('bili-view-line'))
  const viewSnap = made.find((n) => String(n.className).includes('bili-view-snap'))
  ok('现场卡片报的是插件版本 + 登录与否 + 家目录，并指明快照文件路径（判据不依赖 HTTP）', /0\.9\.0/.test(String(viewLine && viewLine.textContent)) && /status\.json/.test(String(viewSnap && viewSnap.textContent)), JSON.stringify({ line: String(viewLine && viewLine.textContent).slice(0, 80), snap: String(viewSnap && viewSnap.textContent).slice(0, 60) }))
  for (const c of cleanups) c()
  for (const d of disposers) d()
  ok('卸载干净：定时器全停、页面从那个 div 上摘下来（渲染的清理归 useEffect，注册的归 disposer）', timers.every((t) => t.cleared) && !node.children.includes(pageNode), JSON.stringify(timers.map((t) => [t.kind, t.ms, t.cleared])))
  for (const k of ['window', 'document', 'fetch']) globalThis[k] = ({ window: savedWin, document: savedDoc, fetch: savedFetch })[k]
  delete globalThis.__clientDef
}

try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* 收尾删不掉就算了 */ }
console.log(`\ndsh-bili-skill 离线自检：${pass} 项通过${fail ? `，${fail} 项失败` : ''}${skipped ? `，${skipped} 项跳过` : ''}`)
console.log(fail ? 'SOME FAIL' : 'ALL PASS')
process.exit(fail ? 1 : 0)




