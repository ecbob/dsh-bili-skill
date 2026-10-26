/**
 * jpgcrop.js —— dsh-bili-skill 自带的纯 JS baseline JPEG 解码/裁切/重编码（零运行时依赖，不用 ffmpeg / sharp）。
 *
 * 为什么需要它：B站 的 x/player/videoshot 经常把整条视频拼成**一张**缩略矩阵（本机实测：
 * img_x_len:10 / img_y_len:10 / img_x_size:480 / img_y_size:270 / image:[一张 4800x2700 的 .jpg]），
 * 想要"某一秒的单帧"就必须从这张拼图里裁出那一格 —— 而 270 不是 8 的倍数，格的上下边界跨 8x8 块，
 * 所以做不了无损的 MCU 对齐裁剪，只能真解码成像素、裁、再重编码。
 *
 * 只支持 baseline（SOF0/SOF1）与灰度/4:4:4/4:2:2/4:2:0；progressive（SOF2）直接抛错，不假装能解。
 */

const ZIGZAG = [0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63]

// ZIGZAG[k] = 第 k 个被扫描的系数的自然位置（行*8+列）；INVZIGZAG 是它的反向表
const INVZIGZAG = new Int32Array(64)
for (let k = 0; k < 64; k++) INVZIGZAG[ZIGZAG[k]] = k

const COS = new Float64Array(64)
for (let x = 0; x < 8; x++) for (let u = 0; u < 8; u++) COS[x * 8 + u] = Math.cos(((2 * x + 1) * u * Math.PI) / 16)
const ALPHA = new Float64Array(8)
for (let u = 0; u < 8; u++) ALPHA[u] = u === 0 ? 1 / Math.SQRT2 : 1

/* ───────────────────────── 解码 ───────────────────────── */

class Bits {
  constructor(buf, pos) { this.b = buf; this.p = pos; this.bit = 0; this.cur = 0 }
  // 读一比特，处理 0xFF00 填充与 RST 标记（返回 true 表示遇到了 RSTn，调用方应重置 DC 预测器）
  readBit() {
    if (this.bit === 0) {
      let byte = this.b[this.p++]
      if (byte === 0xff) {
        const next = this.b[this.p]
        if (next === 0x00) this.p++
        else if (next >= 0xd0 && next <= 0xd7) { this.p++; this.bit = 8; return 'rst' }
        else if (next === 0xd9) { this.bit = 8; return 'eoi' }
      }
      this.cur = byte
      this.bit = 8
    }
    this.bit--
    return (this.cur >> this.bit) & 1
  }
  read(n) {
    let v = 0
    for (let i = 0; i < n; i++) {
      const r = this.readBit()
      if (r === 'rst') { this.bit = 0; v = -1; break }
      if (r === 'eoi') { this.bit = 0; break }
      v = (v << 1) | r
    }
    return v
  }
  align() { this.bit = 0 }
}

function extend(v, len) { return v < (1 << (len - 1)) ? v - (1 << len) + 1 : v }function buildHuff(counts, symbols) {
  // 规范 Huffman：(长度→符号) 表，用 16 位键 (len<<16)|code 存进 Map，避免建 2^16 数组
  const map = new Map()
  let code = 0, k = 0
  for (let len = 1; len <= 16; len++) {
    for (let i = 0; i < counts[len]; i++) { map.set((len << 16) | code, symbols[k++]); code++ }
    code <<= 1
  }
  return map
}
function decodeSymbol(bits, map, what) {
  let code = 0, len = 0
  while (len < 16) {
    const r = bits.readBit()
    if (r === 'rst') return { sym: null, rst: true }
    if (r === 'eoi') return { sym: null, eoi: true }
    code = (code << 1) | r; len++
    const hit = map.get((len << 16) | code)
    if (hit !== undefined) return { sym: hit }
  }
  throw new Error('Huffman 读不出符号：表=' + (what || '?') + ' 走到 ' + len + ' 位（码 0x' + code.toString(16) + '）@字节 ' + (bits.p - 1) + '，最后一字节 0x' + String(bits.b.length > bits.p - 1 ? bits.b[bits.p - 1].toString(16) : '?') + '，该表共 ' + map.size + ' 个码')
}

/**
 * 解一张 baseline JPEG。
 * @returns {{width:number,height:number,planes:Array<{data:Uint8Array,downX:number,downY:number,pw:number,ph:number,id:number}>}}
 */
export function decodeJPEG(buf) {
  let p = 0
  if (buf[p] !== 0xff || buf[p + 1] !== 0xd8) throw new Error('不是 JPEG（缺 SOI）')
  p = 2
  const dqt = new Map()
  const dth = { dc: new Map(), ac: new Map() }
  let sof = null, mcuRows = 0, restart = 0
  while (p < buf.length) {
    if (buf[p] !== 0xff) break
    const m = buf[p + 1]
    if (m === 0xd8) { p += 2; continue }
    if (m === 0xd9) break
    if (m >= 0xd0 && m <= 0xd7) { p += 2; continue }
    if (m === 0xdd) { const l = buf.readUInt16BE(p + 2); restart = buf.readUInt16BE(p + 4); p += 2 + l; continue }
    const len = buf.readUInt16BE(p + 2)
    const body = p + 4
    const end = p + 2 + len
    if (m === 0xdb) {
      let q = body
      while (q < end) {
        const pq = buf[q] >> 4, id = buf[q] & 15
        const size = pq === 0 ? 8 : 16
        const tbl = new Int32Array(64)
        for (let i = 0; i < 64; i++) tbl[ZIGZAG[i]] = size === 8 ? buf[q + 1 + i] : buf.readUInt16BE(q + 1 + i * 2)
        dqt.set(id, { tbl, size })
        q += 1 + 64 * size
      }
    } else if (m === 0xc4) {
      let q = body
      while (q < end) {
        const tc = buf[q] >> 4, th = buf[q] & 15
        const counts = new Uint8Array(17)
        for (let i = 1; i <= 16; i++) counts[i] = buf[q + i]
        let total = 0; for (let i = 1; i <= 16; i++) total += counts[i]
        const symbols = buf.subarray(q + 17, q + 17 + total)
        const map = buildHuff(counts, symbols)
        ;(tc === 0 ? dth.dc : dth.ac).set(th, map)
        q += 17 + total
      }
    } else if (m === 0xc0 || m === 0xc1 || m === 0xc3) {
      const prec = buf[body]
      const h = buf.readUInt16BE(body + 1), w = buf.readUInt16BE(body + 3)
      const nf = buf[body + 5]
      const comps = []
      for (let i = 0; i < nf; i++) {
        const o = body + 6 + i * 3
        comps.push({ id: buf[o], h: buf[o + 1] >> 4, v: buf[o + 1] & 15, qid: buf[o + 2] })
      }
      sof = { prec, width: w, height: h, comps }
    } else if (m === 0xc2) {
      throw new Error('这是 progressive JPEG（SOF2），本模块只支持 baseline —— 别硬解，如实报告')
    }
    if (m === 0xda) {
      if (!sof) throw new Error('SOS 之前没有 SOF，文件异常')
      const sc = buf[body]
      const scan = []
      for (let i = 0; i < sc; i++) { const o = body + 1 + i * 2; scan.push({ id: buf[o], tdth: buf[o + 1] }) }
      const ss = buf[body + 1 + sc * 2], se = buf[body + 2 + sc * 2], ah = buf[body + 3 + sc * 2]
      if (ss !== 0 || se !== 63 || ah !== 0) throw new Error('不是单帧完整扫描（spectral/Successive 不支持）')
      p = end
      return finishDecode(buf, p, sof, scan, dqt, dth, restart, m)
    }
    if (m === 0xda) break
    p = end
  }
  if (!sof) throw new Error('没找到 SOF 段，不是我能解的 JPEG')
  throw new Error('没找到 SOS 段')
  void mcuRows
}

function finishDecode(buf, p, sof, scan, dqt, dth, restart) {
  const { width, height, comps } = sof
  const byId = new Map(comps.map((c) => [c.id, c]))
  // c.h/c.v 是「一个 MCU 里这个分量占几块」，不是降采样倍数：真正的降采样倍数 = 最大因子 / 本分量因子
  // （4:2:0 时 Y 是 2x2 块 ⇒ downX=1 全分辨率；Cb/Cr 是 1x1 块 ⇒ downX=2 半分辨率）
  const maxH = Math.max(...comps.map((c) => c.h)), maxV = Math.max(...comps.map((c) => c.v))
  for (const c of comps) {
    c.downX = maxH / c.h; c.downY = maxV / c.v
    c.pw = Math.ceil(width / c.downX); c.ph = Math.ceil(height / c.downY)
    c.plane = new Uint8Array(c.pw * c.ph)
    c.dcPred = 0
  }
  const mw = 8 * maxH, mh = 8 * maxV
  const mcusX = Math.ceil(width / mw), mcusY = Math.ceil(height / mh)
  const bits = new Bits(buf, p)
  const comp = scan.map((s) => {
    const c = byId.get(s.id)
    if (!c) throw new Error('SOS 里的分量在 SOF 里没有：' + s.id)
    const td = s.tdth >> 4, ta = s.tdth & 15   // SOS 这个字节：高半字节 = DC 表号，低半字节 = AC 表号（两个独立 namespace）
    const dm = dth.dc.get(td), am = dth.ac.get(ta)   // dc/ac 是两套 map，键都是低半字节（DHT 解析那边就这么存的）
    if (!dm || !am) throw new Error('缺 Huffman 表：td=' + td + ' ta=' + ta + '；已定义 dc=[' + [...dth.dc.keys()].join(' ') + '] ac=[' + [...dth.ac.keys()].join(' ') + ']')
    const q = dqt.get(c.qid)
    if (!q) throw new Error('缺量化表 (qid=' + c.qid + ')')
    c.coef = new Int32Array(64)
    return { c, dm, am, q, td, ta, h: c.h, v: c.v }
  })
  const coef = new Int32Array(64)
  const blk = new Float64Array(64)
  let mcuNo = 0
  outer:
  for (let my = 0; my < mcusY; my++) {
    for (let mx = 0; mx < mcusX; mx++) {
      for (const { c, dm, am, q, td, ta } of comp) {
        for (let by = 0; by < c.v; by++) {
          for (let bx = 0; bx < c.h; bx++) {
            coef.fill(0)
            // DC
            let s = decodeSymbol(bits, dm, 'DC#' + td)
            if (s.rst || s.eoi) { c.dcPred = 0; if (s.eoi) break outer }
            const t = s.sym
            if (t > 0) {
              const diff = extend(bits.read(t), t)
              c.dcPred += diff
            }
            coef[0] = c.dcPred * q.tbl[0]
            // AC
            let k = 1
while (k <= 63) {   // 63 支 AC 都要解（原来 k<63 会漏掉最后一支）
              const a = decodeSymbol(bits, am, 'AC#' + ta)
              if (a.rst) { if (k === 1) { /* EOB 前遇 RST ⇒ 本块剩余为 0 */ } break }
              if (a.eoi) break outer
              let rs = a.sym
              if (rs === null) break
              const rr = rs >> 4, si = rs & 15
              if (si === 0) { if (rr === 15) { k += 16; continue } else break }  // EOB
              k += rr
              if (k > 63) break
coef[ZIGZAG[k]] = extend(bits.read(si), si) * q.tbl[ZIGZAG[k]]   // tbl 是按 raster 位存的（DQT 解析时 tbl[ZIGZAG[i]] = 文件第 i 个），所以这里必须换到同一个坐标系
              k++
            }
            // 反变换
            for (let x = 0; x < 8; x++) {
              for (let u = 0; u < 8; u++) {
                let sum = 0
                for (let v = 0; v < 8; v++) sum += ALPHA[v] * coef[x + v * 8] * COS[u * 8 + v]   // COS[空间*8+频率]：这里空间是 u、频率是 v（原来两轴写反 ⇒ DC-only 都会变成渐变）
                blk[u * 8 + x] = sum * 0.5
              }
            }
            const ox = (mx * c.h + bx) * 8, oy = (my * c.v + by) * 8
            for (let y = 0; y < 8; y++) {
              for (let x = 0; x < 8; x++) {
                let sum = 0
                for (let u = 0; u < 8; u++) sum += ALPHA[u] * blk[y * 8 + u] * COS[x * 8 + u]   // 同理：空间是 x、频率是 u
                const val = Math.round(sum * 0.5 + 128)
                const px = ox + x, py = oy + y
                if (px < c.pw && py < c.ph) c.plane[py * c.pw + px] = val < 0 ? 0 : val > 255 ? 255 : val
              }
            }
            void blk
          }
        }
      }
      mcuNo++
      if (restart && mcuNo % restart === 0) {
        bits.bit = 0
        // 跳过一个字节边界上的 RSTn（上面 readBit 已处理，这里只清 DC 预测器）
        for (const c of comps) c.dcPred = 0
      }
    }
  }
  return { width, height, planes: comps.map((c) => ({ data: c.plane, id: c.id, downX: c.downX, downY: c.downY, pw: c.pw, ph: c.ph, h: c.h, v: c.v })) }
}

/* ───────────────────────── 裁切 + 上色 ───────────────────────── */

/** 从解出来的平面里裁一块，直接输出 RGB（色度按最近邻放大，缩略图够用了）。 */
export function cropToRGB(img, x0, y0, w, h) {
  const { width, height, planes } = img
  const yP = planes.find((p) => p.id === 1) || planes[0]
  const cbP = planes.find((p) => p.id === 2)
  const crP = planes.find((p) => p.id === 3)
  const out = Buffer.alloc(w * h * 3)
  const gray = !cbP && !crP
  for (let row = 0; row < h; row++) {
    const sy = y0 + row
    if (sy >= height) break
    for (let col = 0; col < w; col++) {
      const sx = x0 + col
      if (sx >= width) break
      const Y = yP.data[Math.floor(sy / yP.downY) * yP.pw + Math.floor(sx / yP.downX)]
      let o = (row * w + col) * 3
      if (gray) { out[o] = out[o + 1] = out[o + 2] = Y; continue }
      const Cb = cbP.data[Math.floor(sy / cbP.downY) * cbP.pw + Math.floor(sx / cbP.downX)] - 128
      const Cr = crP.data[Math.floor(sy / crP.downY) * crP.pw + Math.floor(sx / crP.downX)] - 128
      const r = Y + 1.402 * Cr, g = Y - 0.344136 * Cb - 0.71454 * Cr, b = Y + 1.772 * Cb
      out[o] = r < 0 ? 0 : r > 255 ? 255 : r | 0
      out[o + 1] = g < 0 ? 0 : g > 255 ? 255 : g | 0
      out[o + 2] = b < 0 ? 0 : b > 255 ? 255 : b | 0
    }
  }
  return out
}

/* ───────────────────────── 编码（baseline；码表按这张图自己的统计生成，不抄 Annex K） ───────────────────────── */

// 一组常用的 baseline 量化表（zigzag 序）。数值是我按常见配置写的、**没有逐位核对 Annex K** ——
// 它只影响画质不影响正确性（DQT 段与编码用的是同一份，任何解码器都能自洽解出）
const STD_LUMA_Q = [16, 11, 12, 12, 15, 18, 20, 23, 18, 17, 17, 20, 26, 28, 25, 23, 21, 21, 26, 34, 30, 29, 29, 32, 36, 44, 41, 41, 43, 36, 31, 35, 50, 56, 52, 50, 55, 41, 48, 60, 57, 60, 60, 65, 67, 67, 69, 63, 62, 69, 75, 71, 73, 73, 84, 93, 93, 93, 93, 93, 93, 93, 93, 93, 93]
const STD_CHROMA_Q = [17, 19, 21, 25, 29, 36, 44, 54, 21, 25, 29, 35, 43, 54, 67, 84, 30, 37, 47, 59, 72, 90, 98, 98, 48, 55, 71, 89, 99, 110, 110, 110, 77, 85, 104, 113, 113, 113, 113, 113, 113, 113, 113, 113, 113, 113, 113, 113, 113, 113, 113, 113, 113, 113, 113, 113, 113, 113, 113, 113, 113, 113, 113, 113, 113]

function scaleQ(base, quality) {
  let s = Math.max(1, Math.min(100, quality))
  s = s < 50 ? 200 - s * 4 : 2 * (100 - s)
  const out = new Int32Array(64)
  for (let i = 0; i < 64; i++) out[i] = Math.max(1, Math.min(255, Math.floor((base[i] * s + 50) / 100)))
  return out
}

/**
 * 码长：先按理想长度 ceil(-log2(p))，再做 Kraft 修正 ⇒ 结果一定是 ≤16 位的合法前缀码。
 * 不抄标准表（我抄过两次都抄砸了），只要求"编解码两端用同一套规范码规则"。
 */
function huffLengths(freq) {
  const MAX = 16, unit = 1 << MAX
  const syms = [...freq.entries()].filter(([, f]) => f > 0).sort((a, b) => a[0] - b[0])
  if (!syms.length) syms.push([0, 1])
  const total = syms.reduce((n, [, f]) => n + f, 0)
  const items = syms.map(([s, f]) => ({ s, len: Math.max(1, Math.min(MAX, Math.ceil(-Math.log2(f / total)))) }))
  const hist = new Int32Array(MAX + 2)
  let sum = 0
  for (const it of items) { hist[it.len]++; sum += unit >> it.len }
  while (sum > unit) {           // 超了就把最长的那批再往深处挪一位（每次挪最少见的那个）
    let L = MAX
    while (L > 1 && hist[L] === 0) L--
    const mv = items.filter((x) => x.len === L).sort((a, b) => freq.get(a.s) - freq.get(b.s))[0]
    hist[L]--; hist[L + 1]++; sum -= (unit >> L) - (unit >> (L + 1)); mv.len = L + 1
  }
  return items.sort((a, b) => a.len - b.len || a.s - b.s)
}

/** 规范码：按（长度升序、符号升序）依次发码 —— 与解码端 buildHuff 是同一套规则，所以两边必然对得上。 */
function canonCodes(lengths, usedFreq) {
  const map = new Map()
  // JPEG 不接受"只有一个符号"的退化表（GDI+ 会报 Bogus Huffman table definition）⇒ 补一个不会出现的占位符号凑成 2 个码
  if (lengths.length === 1) {
    // 只补到 2 个符号（两个 1 位码）：补 3 个就非法（1 位码只有 0/1 两个可用）
    const s0 = lengths[0].s
    const taken = new Set([s0]); let f2 = s0 === 0 ? 1 : 0
    if (usedFreq) for (const k2 of usedFreq.keys()) taken.add(k2)
    while (taken.has(f2) && f2 < 255) f2++
    lengths = [{ s: s0, len: 1 }, { s: f2, len: 1 }]   // 占位符号不会被发出，只是让表合法
  }
  const bits = new Int32Array(17)
  const vals = []
  let code = 0, len = 0
  for (const it of lengths) {
    while (len < it.len) { len++; code <<= 1 }
    map.set(it.s, { code, len: it.len })
    bits[it.len]++; vals.push(it.s); code++
  }
  return { map, dht: { bits: Array.from(bits).slice(1, 17), vals } }
}

function fdctTo(samples, qtab, coef) {
  const tmp = new Float64Array(64)
  for (let y = 0; y < 8; y++) {
    for (let u = 0; u < 8; u++) {
      let s = 0
      for (let x = 0; x < 8; x++) s += (samples[y * 8 + x] - 128) * COS[x * 8 + u]
      tmp[y * 8 + u] = ALPHA[u] * s * 0.5
    }
  }
  for (let x = 0; x < 8; x++) {
    for (let v = 0; v < 8; v++) {
      let s = 0
      for (let y = 0; y < 8; y++) s += tmp[y * 8 + x] * COS[y * 8 + v]
      const si = INVZIGZAG[v * 8 + x]   // 自然位置 → 扫描序号（coef 与 qtab 都按扫描序存）
      coef[si] = Math.round(ALPHA[v] * s * 0.5 / qtab[si])   // C(v) + 量化
    }
  }
  return coef
}

/** 头部段：marker + 长度 + 体，中间不许插 00（只有熵数据里才要做 FF00 填充） */
function seg(type, body) {
  const out = [0xff, type, (body.length + 2) >> 8, (body.length + 2) & 255]
  for (const b of body) out.push(b)
  return out
}

/** RGB（w*h*3 的 Buffer）→ baseline JPEG；color='420' 或 '444' */
export function encodeJPEG(rgb, w, h, quality = 88, color = '420') {
  const qY = scaleQ(STD_LUMA_Q, quality), qC = scaleQ(STD_CHROMA_Q, quality)
  const facs = color === '444' ? [[1, 1], [1, 1], [1, 1]] : [[2, 2], [1, 1], [1, 1]]
  const Y = new Float64Array(w * h), Cb = new Float64Array(w * h), Cr = new Float64Array(w * h)
  for (let i = 0; i < w * h; i++) {
    const r = rgb[i * 3], g = rgb[i * 3 + 1], b = rgb[i * 3 + 2]
    Y[i] = 0.299 * r + 0.587 * g + 0.114 * b
    Cb[i] = -0.168936 * r - 0.341364 * g + 0.5 * b + 128
    Cr[i] = 0.5 * r - 0.418688 * g - 0.081312 * b + 128
  }
  const comps = [
    { id: 1, h: facs[0][0], v: facs[0][1], arr: Y, q: qY },
    { id: 2, h: facs[1][0], v: facs[1][1], arr: Cb, q: qC },
    { id: 3, h: facs[2][0], v: facs[2][1], arr: Cr, q: qC },
  ]
  const maxH = Math.max(...comps.map((c) => c.h)), maxV = Math.max(...comps.map((c) => c.v))
  const mcuW = 8 * maxH, mcuH = 8 * maxV
  const mcusX = Math.ceil(w / mcuW), mcusY = Math.ceil(h / mcuH)
  const samples = new Float64Array(64), coef = new Int32Array(64)
  /** 按扫描顺序遍历所有块：cb(分量序号, 量化后的 zigzag 系数) */
  function walk(cb) {
    for (let my = 0; my < mcusY; my++) {
      for (let mx = 0; mx < mcusX; mx++) {
        for (let ci = 0; ci < comps.length; ci++) {
          const c = comps[ci]
          const dX = maxH / c.h, dY = maxV / c.v
          for (let by = 0; by < c.v; by++) {
            for (let bx = 0; bx < c.h; bx++) {
              const ox = (mx * c.h + bx) * 8, oy = (my * c.v + by) * 8
              for (let j = 0; j < 64; j++) {
                const ix = Math.min(w - 1, (ox + (j & 7)) * dX), iy = Math.min(h - 1, (oy + (j >> 3)) * dY)
                samples[j] = c.arr[iy * w + ix]
              }
              cb(ci, fdctTo(samples, c.q, new Int32Array(64)))
            }
          }
        }
      }
    }
  }
  // 第一遍：统计 DC 位长与 AC(run,size) 的出现次数
  const stat = comps.map(() => ({ dc: new Map(), ac: new Map() }))
  const pred0 = [0, 0, 0]
  walk((ci, co) => {
    const st = stat[ci]
    const diff = co[0] - pred0[ci]; pred0[ci] = co[0]
    let sz = 0, t = diff < 0 ? -diff : diff
    while (t) { sz++; t >>= 1 }
    st.dc.set(sz, (st.dc.get(sz) || 0) + 1)
    let run = 0
    for (let k = 1; k < 64; k++) {
      if (co[k] === 0) { run++; continue }
      let s2 = 0, vv = co[k] < 0 ? -co[k] : co[k]
      while (vv) { s2++; vv >>= 1 }
      while (run > 15) { st.ac.set(0xf0, (st.ac.get(0xf0) || 0) + 1); run -= 16 }
      st.ac.set((run << 4) | s2, (st.ac.get((run << 4) | s2) || 0) + 1)
      run = 0
    }
    if (run > 0) st.ac.set(0, (st.ac.get(0) || 0) + 1)
  })
  // 建表（同一个分量序号的 Y 用一套，Cb/Cr 各一套也允许相同 ⇒ 干脆每张都按自己的统计建）
  const tabs = stat.map((st) => ({ dc: canonCodes(huffLengths(st.dc), st.dc), ac: canonCodes(huffLengths(st.ac), st.ac) }))
  const head = []
  head.push([0xff, 0xd8])
  head.push(seg(0xe0, [0x4a, 0x46, 0x49, 0x46, 0x00, 1, 2, 0, 0, 1, 0, 1, 0, 0]))
  head.push(seg(0xdb, [0].concat(Array.from(qY))))
  head.push(seg(0xdb, [1].concat(Array.from(qC))))
  const sof0 = [8, (h >> 8) & 255, h & 255, (w >> 8) & 255, w & 255, 3]
  for (let i = 0; i < 3; i++) sof0.push(comps[i].id, (comps[i].h << 4) | comps[i].v, i === 0 ? 0 : 1)
  head.push(seg(0xc0, sof0))
  for (let ci = 0; ci < 3; ci++) {
    for (const [cls, t] of [[0, tabs[ci].dc], [1, tabs[ci].ac]]) {
      const body = [(cls << 4) | ci]
      for (let l = 1; l <= 16; l++) body.push(t.dht.bits[l - 1] || 0)
      for (const v of t.dht.vals) body.push(v)
      head.push(seg(0xc4, body))
    }
  }
  head.push(seg(0xda, [3, 1, 0x00, 2, 0x11, 3, 0x22, 0, 63, 0]))   // 每分量：(DC表号<<4)|AC表号
  // 第二遍：真发码
  const bitsOut = []
  let bit = 0, cur = 0
  const putByte = (b) => { bitsOut.push(b); if (b === 0xff) bitsOut.push(0) }
  const putBit = (code, len) => {
    for (let i = len - 1; i >= 0; i--) {
      cur = (cur << 1) | ((code >> i) & 1)
      if (++bit === 8) { putByte(cur & 255); bit = 0; cur = 0 }
    }
  }
  const pred = [0, 0, 0]
  walk((ci, co) => {
    const tb = tabs[ci]
    const diff = co[0] - pred[ci]; pred[ci] = co[0]
    let sz = 0, t = diff < 0 ? -diff : diff
    while (t) { sz++; t >>= 1 }
    const cd = tb.dc.map.get(sz)
    putBit(cd.code, cd.len)
    // DC 尾数按 JPEG 规则：负数要加 (2^sz - 1)，不是 two's-complement 掩码（掩码在 |diff| 正好等于 2^(sz-1) 时会让解出来的符号翻掉：灰度 80 的块 DC=-128 被解成 +128 ⇒ 帧从 80 变 176）
    if (sz) putBit(diff < 0 ? (diff + ((1 << sz) - 1)) & ((1 << sz) - 1) : diff & ((1 << sz) - 1), sz)
    let run = 0
    for (let k = 1; k < 64; k++) {
      const v = co[k]
      if (v === 0) { run++; continue }
      while (run > 15) { const c15 = tb.ac.map.get(0xf0); putBit(c15.code, c15.len); run -= 16 }
      let s2 = 0, vv = v < 0 ? -v : v
      while (vv) { s2++; vv >>= 1 }
      const cc = tb.ac.map.get((run << 4) | s2)
      putBit(cc.code, cc.len)
      putBit((v < 0 ? v + (1 << s2) - 1 : v) & ((1 << s2) - 1), s2)
      run = 0
    }
    if (run > 0) { const eob = tb.ac.map.get(0); putBit(eob.code, eob.len) }
  })
  if (bit > 0) putByte((cur << (8 - bit)) | (0xff >> bit))
  const parts = head.map((a) => Buffer.from(a)).concat([Buffer.from(bitsOut), Buffer.from([0xff, 0xd9])])
  return Buffer.concat(parts)
}


/* ───────────────────────── 故事板分格换算 ───────────────────────── */

/**
 * 把 videoshot 的响应变成可直接用的裁切表。
 * @returns {{cols:number,rows:number,tileW:number,tileH:number,sheetCount:number,interval:number,box:(i:number)=>{x:number,y:number,w:number,h:number},tileOfSec:(sec:number)=>number}}
 */
export function layoutOf(videoshotData, durationSec) {
  const cols = Number(videoshotData.img_x_len) || 0
  const rows = Number(videoshotData.img_y_len) || 0
  const tileW = Number(videoshotData.img_x_size) || 0
  const tileH = Number(videoshotData.img_y_size) || 0
  const sheets = Array.isArray(videoshotData.image) ? videoshotData.image : []
  const tiles = cols * rows * (sheets.length || 1)
  const dur = Number(durationSec) || 0
  const interval = tiles > 0 && dur > 0 ? dur / tiles : 0
  return {
    cols, rows, tileW, tileH, sheetCount: sheets.length, tiles, interval,
    box: (i) => ({ x: (i % cols) * tileW, y: Math.floor(i / cols) * tileH, w: tileW, h: tileH }),
    tileOfSec: (sec) => (interval > 0 ? Math.max(0, Math.min(tiles - 1, Math.floor(Number(sec) / interval))) : 0),
    secOfTile: (i) => i * interval + interval / 2,
  }
}














