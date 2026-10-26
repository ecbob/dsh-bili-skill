/**
 * frames.js —— 故事板取帧/裁格/留帧的纯逻辑 + 文件动作（被 index.js 的两只工具调用）。
 *
 * 本机实测出来的语义（2026-10-26，BV1VpjW6YE4o 这条 4P 视频逐 P 验过）：
 * - `x/player/videoshot?bvid&cid&p` 里的 cid 必须是**那个 P 自己的 cid**（pagelist 给），每 P 有独立故事板；
 * - 返回 `img_x_len` × `img_y_len` 的格子表 + `img_x_size` × `img_y_size` 的格尺寸 + `image[]` 拼图地址；
 *   本机这几条都是 10x10=100 格、每格 480x270、`image` 只有 1 张 4800x2700 的**拼图**；
 * - **格子是按这个 P 的时长、5 秒一格从 0 开始铺的，尾部补纯黑格**（P1 215s → 内容到第 42 格；P2 170s → 33；P3/P4 171s → 33）；
 *   所以"100 格覆盖整条视频"是错的，别按总时长除。
 * - 因此：要"某一秒的单帧"，就得自己按 `tile = floor(sec / interval)` 定位，再把那一格从拼图里**裁出来重编码**
 *   （裁必须解码：每格 270 高不是 8 的倍数，格边界跨 8x8 块 ⇒ 做不了无损 MCU 对齐裁剪；用的解码/编码在同目录 jpgcrop.js）。
 *
 * 秒数一律**相对所选 P 的起点**；跨 P 的绝对秒数自己按 pages 累加换算（结果里给了 partStart）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { decodeJPEG, cropToRGB, encodeJPEG } from './jpgcrop.js'
import { findFfmpeg, hdFrame } from './ffmpeghd.js'

const BLACK_MAX = 8      // 单点算"亮不亮"的门限
const BRIGHT_RATIO = 0.3   // 一格的采样点里亮于 BLACK_MAX 的不到 30% ⇒ 判定它是黑格（原先"任一点 >8 就不黑"太松：暗帧/淡出会被算成内容格，把 interval 稀释掉）
const FALLBACK_STEP = 5  // 万一内容格数测不出来，按实测的 5 秒/格兜底

/** 把 videoshot 的响应变成格子几何。 */
export function gridOf(videoshotData) {
  const d = videoshotData || {}
  const cols = Number(d.img_x_len) || 0
  const rows = Number(d.img_y_len) || 0
  const tileW = Number(d.img_x_size) || 0
  const tileH = Number(d.img_y_size) || 0
  const sheets = (Array.isArray(d.image) ? d.image : []).filter((u) => typeof u === 'string' && u.trim())
  const ts = Array.isArray(d.ts) ? d.ts.map(Number) : []
  return { cols, rows, tileW, tileH, sheets, ts, tilesPerSheet: cols * rows, totalTiles: cols * rows * sheets.length }
}

/** 这一格是不是补位的纯黑。 */
export function isBlackTile(img, box) {
  if (!img || !box) return false
  const w = Math.min(box.w, img.width - box.x), h = Math.min(box.h, img.height - box.y)
  if (w <= 0 || h <= 0) return true
  const pts = []
  const stepX = Math.max(1, Math.floor(w / 5)), stepY = Math.max(1, Math.floor(h / 5))
  for (let y = 0; y < h; y += stepY) for (let x = 0; x < w; x += stepX) pts.push([x, y])
  pts.push([w - 1, h - 1])
  let mx = 0, bright = 0
  for (const [x, y] of pts) {
    const c = cropToRGB(img, box.x + x, box.y + y, 1, 1)
    const v = Math.max(c[0], c[1], c[2])
    if (v > mx) mx = v
    if (mx > BLACK_MAX) bright++
  }
  const n = pts.length
  return bright / n < BRIGHT_RATIO   // 注意方向：bright 数的是"亮点"占比，所以要「亮点不到 30%」才算黑格
}

/** 从尾部往回数，算这一 P 真占了几个格（内容格数）。 */
export function contentTileCount(img, grid) {
  if (!img || !grid.cols || !grid.rows || !grid.tileW || !grid.tileH) return null
  let last = -1
  for (let i = grid.tilesPerSheet - 1; i >= 0; i--) {
    const box = { x: (i % grid.cols) * grid.tileW, y: Math.floor(i / grid.cols) * grid.tileH, w: grid.tileW, h: grid.tileH }
    if (!isBlackTile(img, box)) { last = i; break }
  }
  return last < 0 ? null : last + 1
}

/**
 * 秒 ↔ 格的换算表。interval 优先用「这个 P 的时长 ÷ 实测内容格数」得到（本机这样算出来正好是 5.00s ⇒ 可信），
 * 测不出来才退回 5 秒/格，并在 basis 里说明是怎么定的。
 */
export function secondsMapOf({ partDuration, contentTiles, grid, ts }) {
  const tiles = contentTiles || (grid && grid.tilesPerSheet) || 0
  let interval, basis
  if (Array.isArray(ts) && ts.length >= 2) {
    const d = Number(ts[1]) - Number(ts[0])
    interval = d > 0 ? d : 0
    basis = `接口自己给了 ts[] 时间戳（相邻两格差 ${d}s）`
  } else if (contentTiles && partDuration) {
    interval = partDuration / contentTiles
    basis = `按实测内容格数 ${contentTiles} 除本 P 时长 ${partDuration}s 得出`
  } else {
    interval = FALLBACK_STEP
    basis = `内容格数没测出来，退回实测常用的 ${FALLBACK_STEP}s/格`
  }
  if (!Number.isFinite(interval) || interval <= 0) { interval = FALLBACK_STEP; basis += '（interval 无效，再用 5s 兜底）' }
  const span = Math.max(1, Math.round(interval * 100) / 100)
  return {
    interval: span, basis, tiles,
    tileOfSec: (sec) => Math.max(0, Math.min(tiles - 1, Math.floor(Number(sec) / span))),
    secOfTile: (i) => Math.round((i * span + span / 2) * 100) / 100,
    secRangeOfTile: (i) => ({ from: Math.round(i * span * 100) / 100, to: Math.round((i + 1) * span * 100) / 100 }),
  }
}

/** 挑哪几格：给了 at 就按秒贴最近格（去重），否则在内容格里均匀撒 num 个。 */
export function pickTiles({ num, at, smap }) {
  const tiles = Math.max(1, smap.tiles || 1)
  if (Array.isArray(at) && at.length) {
    const seen = new Map()
    for (const sec of at.slice(0, 12)) {
      const i = smap.tileOfSec(sec)
      if (!seen.has(i)) seen.set(i, Number(sec))
    }
    return [...seen.entries()].map(([tile, requested]) => ({ tile, requested, via: 'at' }))
  }
  const want = Math.max(1, Math.min(12, Number(num) || 1))
  const n = Math.min(want, tiles)
  const out = []
  for (let k = 0; k < n; k++) {
    const tile = n === 1 ? Math.min(1, tiles - 1) : Math.round(k * (tiles - 1) / (n - 1))
    out.push({ tile, requested: smap.secOfTile(tile), via: 'spread' })
  }
  return out
}

/** 取帧的文件名：把秒数与格号都编进去，方便人眼对位。 */
export function frameFileName(bvid, p, tile, sec, ext, keep, stamp) {
  const s = String(Math.round(sec)).padStart(5, '0')
  const t = String(tile).padStart(3, '0')
  return `${keep ? 'keep/' : ''}${bvid}-p${p}-${t}-${s}s${keep && stamp ? '-' + stamp : ''}.${ext}`   // 留下的帧带年月日时分秒，文件名天然唯一、与账本行一一对应
}

/** 攒着写盘的临时帧目录与留帧目录都在 frames/ 下，keep 单独一层，clear 默认不碰它。 */
export function dirsOf(framesRoot) {
  return { root: framesRoot, keep: path.join(framesRoot, 'keep') }
}

/** 列 frames/：分「临时取帧」与「留下的单帧」两类。 */
export function listFrames(framesRoot) {
  const walk = (d, rel) => {
    if (!fs.existsSync(d)) return []
    return fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
      const full = path.join(d, e.name)
      if (e.isDirectory()) return walk(full, path.join(rel, e.name))
      const st = fs.statSync(full)
      return [{ file: rel ? `${rel}/${e.name}` : e.name, bytes: st.size, mtime: new Date(st.mtimeMs).toISOString(), kept: rel.startsWith('keep') }]
    })
  }
  const files = walk(framesRoot, '')
  return { ok: true, dir: framesRoot, count: files.length, bytes: files.reduce((s, f) => s + f.bytes, 0), kept: files.filter((f) => f.kept), temp: files.filter((f) => !f.kept), files }
}

/**
 * 删帧。scope: 'temp'（默认，不动 keep）| 'keep' | 'all'；可按天数或数量收紧。
 * 返回删了哪些、释放多少字节 —— 不留不明不白的删除。
 */
export function clearFrames(framesRoot, { scope = 'temp', olderThanDays, keepLast } = {}) {
  const all = listFrames(framesRoot).files
  let pool = all
  if (scope === 'temp') pool = all.filter((f) => !f.kept)
  else if (scope === 'keep') pool = all.filter((f) => f.kept)
  else if (scope !== 'all') return { ok: false, message: `scope 只认 temp / keep / all，收到的是「${scope}」` }
  if (Number(olderThanDays) > 0) {
    const cut = Date.now() - Number(olderThanDays) * 86400000
    pool = pool.filter((f) => new Date(f.mtime).getTime() < cut)
  }
  if (Number(keepLast) > 0) pool = pool.slice().sort((a, b) => (a.mtime < b.mtime ? -1 : 1)).slice(0, Math.max(0, pool.length - Number(keepLast)))
  const removed = []
  let freed = 0, failed = 0
  for (const f of pool) {
    try { fs.unlinkSync(path.join(framesRoot, f.file)); freed += f.bytes; removed.push(f.file) } catch { failed++ }
  }
  // 顺手清掉空掉的 keep/ 目录（不留空壳）
  const kp = dirsOf(framesRoot).keep
  try { if (fs.existsSync(kp) && fs.readdirSync(kp).length === 0) fs.rmdirSync(kp) } catch { /* 删不掉就算了 */ }
  return { ok: true, scope, removed, removedCount: removed.length, freedBytes: freed, failed, note: removed.length ? '' : '没有符合条件的文件可删（keep/ 里的帧默认不动）' }
}

/**
 * 取帧主流程。deps 由 index.js 注进来（call = 带 cookie/csrf/wbi 的通道、log、framesDir、UA、REFERER），
 * 这样这块逻辑能离线测（假 call + 真 fixture 图）。
 */
export async function shoot(deps, { bvid, num, at, p } = {}) {
  const { call, log, framesDir, UA, REFERER } = deps
  const ffmpeg = deps.ffmpeg ?? findFfmpeg({ ffmpegPath: deps.ffmpegPath, home: deps.home })   // 有 ffmpeg 才谈高清帧；没有就走故事板格子（调用方必须把这点说清）
    let ffmpegState = ffmpeg ? ffmpeg : 'absent'
  if (!bvid) throw new Error('要传 bvid')
  const v = await call({ path: '/x/web-interface/view', params: { bvid } })
  if (!v.ok) throw new Error(`视频信息读不到：code=${v.code} ${v.message}`)
  const pagesRaw = Array.isArray(v.data?.pages) && v.data.pages.length ? v.data.pages : [{ cid: v.data?.cid, page: 1, part: v.data?.title, duration: Number(v.data?.duration) || 0 }]
  const pages = pagesRaw.map((pg, i) => ({
    index: Number(pg.page) || i + 1, cid: Number(pg.cid), part: String(pg.part || pg.sub_title || ''), duration: Number(pg.duration) || 0,
    partStart: pagesRaw.slice(0, i).reduce((s, q) => s + (Number(q.duration) || 0), 0),
  }))
  // 没指定 P 又给了秒数 ⇒ 自动挑装得下这些秒的那一段
  let partIndex = Number(p) || 0
  if (!partIndex) {
    if (Array.isArray(at) && at.length) {
      const maxSec = Math.max(...at.map(Number))
      const hit = pages.find((pg) => maxSec < pg.duration)
      partIndex = hit ? hit.index : pages[0].index
      if (hit && pages.length > 1) log(`没指定 p：按最晚的 ${maxSec}s 自动选了 P${hit.index}（${hit.part}，${hit.duration}s）`)
    } else partIndex = pages[0].index
  }
  const pg = pages.find((q) => q.index === partIndex) || pages[0]
  if (!pg.cid) throw new Error(`P${pg.index} 的 cid 拿不到`)
  const snap = await call({ path: '/x/player/videoshot', params: { bvid, cid: pg.cid, p: pg.index } })
  const grid = gridOf(snap.data)
  if (!grid.sheets.length) {
    return {
      ok: false, message: `这条视频没有故事板帧（videoshot 回 code=${snap.code} ${snap.message}）—— 只有封面可用`,
      cover: v.data?.pic, aid: v.data?.aid, cid: pg.cid, duration: v.data?.duration, part: pg.part, partDuration: pg.duration, pages,
    }
  }
  fs.mkdirSync(framesDir, { recursive: true })
  const picksOne = async (urlRaw) => {
    const url = String(urlRaw).startsWith('http') ? String(urlRaw) : `https:${urlRaw}`
    const r = await fetch(`${url}${url.includes('?') ? '&' : '?'}referer=${encodeURIComponent(REFERER)}`, { headers: { 'user-agent': UA, referer: REFERER }, signal: AbortSignal.timeout(deps.timeoutMs || 20000) }).catch((e) => { log(`取图失败：${String(e?.message || e).slice(0, 120)}`); return null })
    if (!r || !r.ok) return null
    return { buf: Buffer.from(await r.arrayBuffer()), url, ext: /\.webp/i.test(url) ? 'webp' : /\.png/i.test(url) ? 'png' : 'jpg' }
  }
  const frames = []
  let smap = null, decodedSheets = 0, tiledMode = false

  // 第一张：先判断是「一格一图」还是「整页拼图」
  const first = await picksOne(grid.sheets[0])
  if (!first) return { ok: false, message: '故事板地址拿到了，但图下载不下来', cover: v.data?.pic, pages, cid: pg.cid }
  let img = null
  const looksLikeSheet = grid.cols > 0 && grid.rows > 0 && grid.tileW > 0 && grid.tileH > 0
  if (first.ext === 'jpg' && looksLikeSheet) {
    try { img = decodeJPEG(first.buf) } catch (e) { log(`拼图解码失败（退回整张保存）：${String(e?.message || e).slice(0, 140)}`); img = null }
  }
  if (img && Math.abs(img.width - grid.cols * grid.tileW) <= grid.tileW && Math.abs(img.height - grid.rows * grid.tileH) <= grid.tileH) {
    decodedSheets++
    const contentTiles = contentTileCount(img, grid)
    smap = secondsMapOf({ partDuration: pg.duration, contentTiles, grid, ts: grid.ts })
    for (const pick of pickTiles({ num, at, smap })) {
      const tile = pick.tile
      const sheetNo = Math.floor(tile / grid.tilesPerSheet)
      let useImg = img, useBox = { x: (tile % grid.cols) * grid.tileW, y: Math.floor(tile / grid.cols) * grid.tileH, w: grid.tileW, h: grid.tileH }   // 行 = tile/cols、列 = tile%cols（原先写成 (tile%cols)*tileH 再乘一次，纵向落位全错）
      if (sheetNo > 0) {
        const nx = grid.sheets[sheetNo] ? await picksOne(grid.sheets[sheetNo]) : null
        if (!nx) continue
        try { useImg = decodeJPEG(nx.buf) } catch { continue }
        decodedSheets++
        useBox = { x: (tile % grid.tilesPerSheet % grid.cols) * grid.tileW, y: Math.floor((tile % grid.tilesPerSheet) / grid.cols) * grid.tileH, w: grid.tileW, h: grid.tileH }
      }
      const box = { x: Math.min(useBox.x, useImg.width - 1), y: Math.min(useBox.y, useImg.height - 1), w: Math.min(grid.tileW, useImg.width - Math.min(useBox.x, useImg.width - 1)), h: Math.min(grid.tileH, useImg.height - Math.min(useBox.y, useImg.height - 1)) }
      const rgb = cropToRGB(useImg, box.x, box.y, box.w, box.h)
      const out = encodeJPEG(rgb, box.w, box.h, 90)
      const range = smap.secRangeOfTile(tile)
      const file = path.join(framesDir, frameFileName(bvid, pg.index, tile, range.from, 'jpg', false))
      fs.writeFileSync(file, out)
      const lumOf = (buf) => { let s = 0; for (const v of buf) s += v; return Math.round(s / buf.length) }
                  frames.push({ at: range.from, atTo: range.to, tile, sheet: sheetNo, p: pg.index, cid: pg.cid, partStart: pg.partStart, path: file, bytes: out.length, width: box.w, height: box.h, lum: lumOf(rgb) })
    }
  } else {
    // 一格一图的老形状（或这张图解不开）：按接口给的 ts[] 直接存原图
    tiledMode = true
    const urls = grid.sheets
    smap = secondsMapOf({ partDuration: pg.duration, contentTiles: grid.ts && grid.ts.length ? grid.ts.length : urls.length, grid, ts: grid.ts })
    const order = pickTiles({ num, at, smap })
    for (const pick of order) {
      const one = urls[pick.tile] ? (pick.tile === 0 ? first : await picksOne(urls[pick.tile])) : first
      if (!one) continue
      const file = path.join(framesDir, frameFileName(bvid, pg.index, pick.tile, smap.secOfTile(pick.tile), one.ext, false))
      fs.writeFileSync(file, one.buf)
      frames.push({ at: smap.secOfTile(pick.tile), tile: pick.tile, p: pg.index, cid: pg.cid, partStart: pg.partStart, path: file, bytes: one.buf.length, width: null, height: null, lum: (() => { const ti = decodeJPEG(one.buf); const tr = cropToRGB(ti, 0, 0, ti.width, ti.height); let s2 = 0; for (const v of tr) s2 += v; return Math.round(s2 / tr.length) })() })
    }
  }
  if (deps.hd && !ffmpeg) {   // 说好「抽不动不许静默降级」：机器上没 ffmpeg 也要在每一帧和顶层都留下话
    for (const f of frames) f.hd_error = 'no-ffmpeg'
    log('要高清但没找到 ffmpeg（config.ffmpegPath / DSH_BILI_FFMPEG / PATH / 家目录旁与工作区旁的 .dsh/.build-tools/ffmpeg/ffmpeg.exe 都试过）⇒ 这批只能回故事板格子帧')
  }
  if (deps.hd && ffmpeg && frames.length) {
    for (const f of frames) {
      const hd = await hdFrame({ call, log, framesDir, UA, REFERER, ffmpeg, timeoutMs: deps.timeoutMs }, { bvid, cid: pg.cid, sec: f.at, index: pg.index })
      if (hd.ok) { f.hd = hd; f.width = hd.width ?? f.width; f.height = hd.height ?? f.height }
      else f.hd_error = hd.why || hd.message
    }
  }
  log(`取帧 ${frames.length} 张（${bvid} P${pg.index} cid ${pg.cid}，${grid.cols}x${grid.rows} 格、每格约 ${smap ? smap.interval : '?'}s，${tiledMode ? '一格一图' : `从拼图裁出单帧，解了 ${decodedSheets} 张拼图`}）`)
  return {
    ok: frames.length > 0,
    title: v.data?.title, up: v.data?.owner?.name, cover: v.data?.pic, aid: v.data?.aid, cid: pg.cid,
    duration: Number(v.data?.duration) || 0, part: pg.part, partIndex: pg.index, partDuration: pg.duration, partStart: pg.partStart, pages,
    grid: { cols: grid.cols, rows: grid.rows, tileW: grid.tileW, tileH: grid.tileH, sheets: grid.sheets.length },
    intervalSec: smap ? smap.interval : null, intervalBasis: smap ? smap.basis : null, tiledMode, frames,
    ffmpeg: ffmpegState,
    hd_note: deps.hd ? (ffmpeg ? '高清帧由外部 ffmpeg 解视频流抽得（method=ffmpeg-keyframe：按关键帧定位，不是逐帧精确）。' : '要高清但没找到 ffmpeg ⇒ 这批全是故事板格子帧，每帧都带 hd_error=no-ffmpeg。') : null,
    note: tiledMode ? '这条接口本来就是一格一图，直接存的原图。' : '每格都从拼图里裁成**单独一帧**（480x270 这种），不是整页缩略矩阵；at 是该格区间起点（秒，相对 P' + pg.index + '），atTo 是终点。',
  }
}

