// dsh-bili-base 离线自检（重建版）：临时家目录 + 假 fetch + 假 ctx，不联网、不写真实家目录
// 覆盖：导出形状、4 只工具的声明合规（照宿主 schema 规则自查）、URL 白名单、非信封响应、
// 无损 JSON、cookie 两种拼写、补 csrf 必须在序列化之前、murmur3 指纹向量、Gaia 三步序列、
// skill provider 契约与活脚注、家目录覆盖与现扫、记账的增/读/删/去重与脏行容忍、坏配置不炸。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-base-selftest-'))
const home = path.join(tmp, 'bili-base')
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

/* ── 假 fetch：记录每一次调用的形状，好核对 Gaia 三步顺序 ── */
const hits = []
const SPI_B3 = 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE12345infoc'
const SPI_B4 = 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE-123456789-abcdefghijklmnopqrstuvwxyz0123456789ABCD='
globalThis.fetch = async (url, init = {}) => {
  const u = String(url)
  hits.push({ url: u, method: (init.method || 'GET'), headers: { ...(init.headers || {}) }, body: init.body ? String(init.body) : '' })
  let data = { isLogin: true, mid: 443924958, uname: 'tester', wbi_img: { img_url: 'https://i0.hdslb.com/bfs/wbi/7cd08494133a4351bb2a2cb38190f56f.png', sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caf07c6049e4b7e523aa1db8ea06.png' } }
  if (u.includes('/x/frontend/finger/spi')) data = { b_3: SPI_B3, b_4: SPI_B4 }
  else if (u.includes('/x/v2/reply/add')) data = { rpid: 999, rpid_str: '999', success_toast: '发送成功' }
  const body = JSON.stringify({ code: 0, message: 'OK', data })
  return { status: 200, ok: true, headers: { get: () => 'application/json' }, text: async () => body, json: async () => JSON.parse(body) }
}

const mod = await import(pathToFileURL(path.join(pkgDir, 'index.js')).href)
const a = mkCtx()
mod.apply(a.ctx, { home, logLevel: 'silent' })

/* ── 1. 导出形状 ── */
eq('包名导出是 bili-base', mod.name, 'bili-base')
eq('硬注入 = tools + skills', mod.inject, ['tools', 'skills'])
eq('注册了 4 只工具', a.tools.map((t) => t.name), ['bili_auth', 'bili_api', 'bili_shot', 'bili_ledger'])
ok('每只工具都有非空 description 与 presentCall', a.tools.every((t) => t.description && t.description.length > 30 && typeof t.presentCall === 'function'))
ok('effect 挂上了 skill provider 的 disposer', a.effects.some(([, l]) => String(l).includes('skills provider')))

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
ok('4 只工具的 parameters 按宿主规则干净', viol.length === 0, JSON.stringify(viol))
const violO = a.tools.map((t) => [t.name, hostViolations(t.output?.schema)]).filter(([, v]) => v.length)
ok('4 只工具的 output.schema 按宿主规则干净', violO.length === 0, JSON.stringify(violO))
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
ok('模型不接图片时退化成文字并给 hint（说清为什么这次只有路径）', noImg.ok === false && noImg.reason === 'model_no_image' && /modlens_read_image/.test(noImg.hint))

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
ok('每个候选都有有限数字 rank、字符串 source、provider 名等于注册名', cl.every((c) => Number.isFinite(c.rank) && typeof c.source === 'string' && c.provider === 'dsh-bili-base'))
ok('每份都有非空 description 与 whenToUse', cl.every((c) => (c.description || '').length > 8 && (c.whenToUse || '').length > 8))
ok('每份的 frontmatter name 与文件名一致且是 kebab-case', cl.every((c) => /^[a-z0-9]+(-[a-z0-9]+)*$/.test(c.name) && fs.existsSync(path.join(pkgDir, 'skills', c.name + '.md'))))
const rg = cl.find((c) => c.name === 'bili-comment-reply')
const rgBody = rg ? (await a.providers[0].get(rg)).content : ''
ok('回复说明书在目录里，正文含 root/parent、dialog、12022、reply/reply 读法', !!rg && ['12022', 'dialog', 'reply/reply', 'root'].every((k) => rgBody.includes(k)), rgBody.slice(0, 60))
const cmBody = (await a.providers[0].get({ name: 'bili-comment' })).content
ok('评论说明书正文锁着两条实测口径：Referer 不带尾斜杠 + Gaia 默认关（gaia: true 才开）', /Referer/.test(cmBody) && /尾斜杠/.test(cmBody) && /gaia: true/.test(cmBody) && !/不做上报就会被 AI 审核降级/.test(cmBody), cmBody.slice(-260))
const got = await a.providers[0].get({ name: 'bili-search' })
ok('get() 去掉 frontmatter、追加底座脚注（版本/记忆位置/缓存边界）', !got.content.startsWith('---') && got.content.includes('## 本插件的底座') && got.content.includes('记忆在这儿'))
const pv = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8')).version
ok('脚注里的版本是现读磁盘的那份（不是模块加载时冻住的）', got.content.includes('dsh-bili-base v' + pv), got.content.slice(-120))
ok('凭证那行只声明文件在不在，登录要现查', got.content.includes('这行只说明文件存在') || got.content.includes('不在 ——'))
const dirs = ['ledger', 'frames', 'skills']
ok('家目录结构建好了（ledger / frames 都在）', dirs.every((d) => fs.existsSync(path.join(home, d))))
const aBad = mkCtx(); mod.apply(aBad.ctx, { home: path.join(tmp, 'bad'), logLevel: 'nope', requestTimeoutMs: 'x', maxBytes: 0, framesDefault: 0 })
ok('坏配置不炸（值被 coerce 回默认）', aBad.tools.length === 4)

/* ── 12. 覆盖：家目录同名文件赢，且正文现读磁盘 ── */
const ovHome = path.join(tmp, 'ovr', 'bili-base')
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

/* ── 15. bili_shot / bili_auth 的守门 ── */
const noBvid = await a.tools.find((t) => t.name === 'bili_shot').execute({})
ok('bili_shot 不给 bvid 回 ok:false 而不是抛', noBvid.ok === false && typeof noBvid.message === 'string')
let threw = false; try { await a.tools.find((t) => t.name === 'bili_auth').execute({ action: 'poll' }) } catch { threw = true }
ok('poll 不给 key 就明确报错（不闷声发请求）', threw)
const st = await a.tools.find((t) => t.name === 'bili_auth').execute({ action: 'status' })
ok('bili_auth status 走假 fetch 认成已登录', st.ok === true && st.loggedIn === true && st.uid === '443924958', JSON.stringify(st))

try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* 收尾删不掉就算了 */ }
console.log(`\ndsh-bili-base 离线自检：${pass} 项通过${fail ? `，${fail} 项失败` : ''}${skipped ? `，${skipped} 项跳过` : ''}`)
console.log(fail ? 'SOME FAIL' : 'ALL PASS')
process.exit(fail ? 1 : 0)
