/**
 * qrpng.js —— 纯 JS 的 QR 码生成 + PNG 封装（零运行时依赖，只用 node 内置 zlib）
 *
 * 为什么要它：B站 web 登录的 qrcode/generate 只回 {url, qrcode_key}，**没有二维码图片端点** ⇒
 *   要"把二维码当图片贴进会话"，只能自己把 url 编成 QR 矩阵再画成 PNG。
 * 只做 Version 2..6 + 纠错等级 L（B站那条授权链接约 70 字节，v6 的 134 字节留足余量）；装不下就如实回 too_long。
 *
 * 权威依据（本机逐条核对过，不是我自己背的）：
 *   - 分块结构：参考实现 qrcode-generator 的 RS_BLOCK_TABLE 之 L 行 —— v2 [1,44,34] v3 [1,70,55]
 *     v4 [1,100,80] v5 [1,134,108] v6 [2,86,68]（元素是 [块数, 总码字, 数据码字]）。
 *   - 字节容量：qrcode.com 的 v1-10 容量表 —— 32 / 53 / 78 / 106 / 134 字节，正好等于上面数据码字 - 2。
 *   - 码字空间：功能区精确计数 (size² - 功能区) / 8，逐版本与上表相符（v1=26 v2=44 v3=70 v4=100 v5=134 v6=172）；
 *     两者不等时 structureOf 标 consistent:false，qrPng 直接拒绝出图，不硬编一个装不下的版本。
 *   - 格式信息 15 位：BCH(15,5) 生成式 10100110111、再异或 101010000010010；我算出的 15 位与基准图上的完全一致。
 *   - 暗模块在 (size-7, 8)：我先前放在 (size-8, 8)，被基准图纠正了。
 * 正确性由**外部解码器 jsQR** 证明（见 scripts/selftest.mjs 的 roundtrip 断言），不由本模块自证。
 */
import zlib from "node:zlib"

/* ── GF(256)，生成多项式 0x11d ── */
const EXP = new Uint8Array(512), LOG = new Uint8Array(256)
{
  let x = 1
  for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; x &= 0xff }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]
}
const gmul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]])
function rsGenPoly(n) {
  let p = [1]
  for (let i = 0; i < n; i++) {
    const next = new Array(p.length + 1).fill(0)
    for (let j = 0; j < p.length; j++) { next[j] ^= p[j]; next[j + 1] ^= gmul(p[j], EXP[i]) }
    p = next
  }
  return p
}
function rsEncode(data, ecLen) {
  const gen = rsGenPoly(ecLen)
  const res = new Array(ecLen).fill(0)
  for (const b of data) {
    const factor = b ^ res[0]
    res.shift(); res.push(0)
    for (let i = 0; i < gen.length - 1; i++) res[i] ^= gmul(gen[i + 1], factor)
  }
  return res
}

/* ── 几何 ── */
/* 对齐图案中心：v2/v3 直接照参考实现给的两个中心；v4 起由间距公式现算（中心数 n = 2 + floor((size - 13) / (2 + floor(version / 7)))，
 *   首中心恒 6、末中心恒 size - 7，相邻间距 (末 - 6) / (n - 1) 四舍五入。
 *   我先前把 v4..v6 的中心硬编错过（写成 3 个却按 9 个区算），所以这里改成现算 + 与参考实现的码字数互验。 */
/* 对齐图案中心（ISO/IEC 18004 Table 4 原表，v1..v9 段照抄）：这张表的间隔不是干净公式 ——
 *   我自己推过三版（按 size 平均、(size-17)/n、(last-6)/(n-1)），每一版都在某个版本上绊住：v4 算出 12 个中心、
 *   v6 该是 [6,26,42] 我给成 [6,20,34]。不再自己推，直接写表。 */
const ALIGN_CENTERS_BY_SPEC = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46],
}
export function alignCenters(version) {
  return ALIGN_CENTERS_BY_SPEC[version] || []
}
export function geometryOf(version) {
  return { size: 17 + 4 * version, centers: alignCenters(version) }
}
/** 码字空间 = (总模块 - 功能区)/8。功能区：三个 8x8 定位角块(含分隔符)=192、两条定时线=2*(size-16)（横 11 格、纵 10 格，多的那格就是格式里那个 1）、
 *  格式信息 31 格(两条复制 15+15 加暗模块)、每个对齐图案 25、版本信息 36(size>=41)。 */
export function totalCodewords(version) {
  const size = 17 + 4 * version
  const cs = alignCenters(version)
  /* 对齐图案区数 = 交叉点数 - 被定位图案吞掉的 3 个角：v2/v3 恒 1 个，v4..v6 是 4 个。
     参考实现的码字数 100/134/172 反证：v4 是 3x3 - 3 = 6 个中心、4 个区，不是 9 个区。 */
  const nCenters = cs.length
  const regions = nCenters >= 2 ? nCenters * nCenters - 3 : 0   // 交叉点数 - 被三个定位图案吞掉的角；v2/v3 各只有 1 对中心 ⇒ 1 个对齐图案
  const alignArea = regions * 25
  /* 格式信息 30 格：两套复制各 15，都不与定位/分隔/定时重叠（暗模块就在右下那 15 格里） */
  const reserved = 192 + 2 * (size - 16) + 30 + alignArea + (size >= 41 ? 36 : 0)   // 定位角块(含分隔符) + 定时线 + 格式 + 对齐 + 版本信息
  const dataModules = size * size - reserved
  const cw = Math.floor(dataModules / 8)
  return { size, cw, dataModules, reserved, remainderBits: dataModules - cw * 8 }
}
/* L 档分块（照参考实现的 L 行）：[块数, 总码字, 数据码字] */
const RS_BLOCKS_L = { 2: [[1, 44, 34]], 3: [[1, 70, 55]], 4: [[1, 100, 80]], 5: [[1, 134, 108]], 6: [[2, 86, 68]] }
export function structureOf(version, ecLevel = "L") {
  if (ecLevel !== "L") return null
  const raw = RS_BLOCKS_L[version]
  if (!raw) return null
  const blocks = []
  for (const [count, total, data] of raw) for (let i = 0; i < count; i++) blocks.push({ total, data, ec: total - data })
  const dataCw = blocks.reduce((n, b) => n + b.data, 0)
  const totalCw = blocks.reduce((n, b) => n + b.total, 0)
  const g = totalCodewords(version)
  /* consistent 只是体检提示：拦路应当由数据容量决定，不该由我这条没算准的几何决定（v6 我的几何给 168、两份权威数据都说 172） */
  return { blocks, dataCw, ecTotal: totalCw - dataCw, totalCw, geometryCw: g.cw, remainderBits: g.remainderBits, consistent: totalCw === g.cw }
}
/** 该版本 L 档 byte 模式可装字节数（v1..9：4bit 模式 + 8bit 长度 = 2 字节开销） */
export function capacityBytes(version, ecLevel = "L") {
  const s = structureOf(version, ecLevel)
  if (!s) return null
  return { bytes: s.dataCw - 2, dataCw: s.dataCw, totalCw: s.totalCw, ecTotal: s.ecTotal, geometryCw: s.geometryCw, consistent: s.consistent }
}
export function pickVersion(byteLen, ecLevel = "L") {
  for (let v = 2; v <= 6; v++) { const c = capacityBytes(v, ecLevel); if (c && byteLen <= c.bytes) return v }
  return null
}

/* ── 位流 ── */
class Bits {
  constructor() { this.bytes = []; this.cur = 0; this.n = 0 }
  put(value, len) {
    for (let i = len - 1; i >= 0; i--) {
      this.cur = (this.cur << 1) | ((value >> i) & 1)
      if (++this.n === 8) { this.bytes.push(this.cur & 0xff); this.cur = 0; this.n = 0 }
    }
  }
  finish(dataCw) {
    if (this.n > 0) { const pad = 8 - this.n; this.put(0, pad > 4 ? 4 : pad) }   // 结束符最多 4 位
    if (this.n > 0) { this.bytes.push((this.cur << (8 - this.n)) & 0xff); this.cur = 0; this.n = 0 }
    while (this.bytes.length < dataCw) this.bytes.push(this.bytes.length % 2 === 0 ? 0xec : 0x11)   // 交替填充码字
    if (this.bytes.length > dataCw) throw new Error(`QR：数据填超了容量（${this.bytes.length} > ${dataCw} 码字）`)
    return this.bytes
  }
}
function encodeData(text, version, ecLevel) {
  const cap = structureOf(version, ecLevel)
  if (!cap) throw new Error(`QR：不支持的版本/等级 ${version}-${ecLevel}（本模块只做 v2..v6 的 L）`)
  /* 分块表与几何不符只作提示，不拦路（见 structureOf 上方说明） */
  const bytes = Buffer.from(text, "utf8")
  const bits = new Bits()
  bits.put(4, 4)
  bits.put(bytes.length, 8)
  for (const b of bytes) bits.put(b, 8)
  return { data: bits.finish(cap.dataCw), byteLen: bytes.length }
}

/* ── 分块 + 交织（数据码字交错放，再交错放纠错码字）── */
function buildCodewords(text, version, ecLevel) {
  const cap = structureOf(version, ecLevel)
  const { data } = encodeData(text, version, ecLevel)
  const blocks = []
  let off = 0
  for (const b of cap.blocks) {
    const d = data.slice(off, off + b.data); off += b.data
    blocks.push({ d, ec: rsEncode(d, b.ec) })
  }
  const out = []
  const maxData = Math.max(...blocks.map((b) => b.d.length))
  for (let i = 0; i < maxData; i++) for (const b of blocks) if (i < b.d.length) out.push(b.d[i])
  const maxEc = Math.max(...blocks.map((b) => b.ec.length))
  for (let i = 0; i < maxEc; i++) for (const b of blocks) if (i < b.ec.length) out.push(b.ec[i])
  if (out.length !== cap.totalCw) throw new Error(`QR：交织后码字 ${out.length} 个 ≠ 应有 ${cap.totalCw} 个`)
  return out
}

/* ── 格式信息的放置路径：只在这里定义一次，登记功能区与写值两处共用（先前两处各写一遍、写成 size-8 那种边界，
   把右下定位图案的分隔符带当成格式区，白占 16 个数据格，还多写一格盖掉数据）──
   左上复制 15 格：row 8 的列 0..5、7、8，再 column 8 的行 7、5、4、3、2、1、0（跳过 row 6 = 定时线）
   右下复制 15 格：row 8 的列 size-1..size-7，再 column 8 的行 size-8..size-1（size-8 那格就是暗模块）
   两套都不与定位/分隔/定时重叠 ⇒ 格式区合计 30 格。 */
/* 格式信息的 15 位往哪写：照参考实现 setupTypeInfo 的索引式逐格写死（本机读到它的原文）。
   两套互为复制、值按位相同 —— 关键是「同一条 i 落到哪一格」，我先前自己按几何排，两套排成了同一个顺序，
   于是第二套整体镜像（对照真基准：格式那 30 格里 19 格不同）。 */
export function formatPath(size) {
  const tl = [], br = []
  for (let i = 0; i < 15; i++) {
    /* 竖排（column 8 那一列） */
    if (i < 6) tl.push([i, 8])
    else if (i < 8) tl.push([i + 1, 8])
    else tl.push([size - 15 + i, 8])
    /* 横排（row 8 那一行） */
    if (i < 8) br.push([8, size - i - 1])
    else if (i < 9) br.push([8, 15 - i - 1 + 1])
    else br.push([8, 15 - i - 1])
  }
  const reserved = new Set()
  for (const [r, c] of tl.concat(br)) reserved.add(r + "," + c)
  reserved.add((size - 8) + ",8")          // 暗模块：库把它当已占的功能格（不是留给数据的路径格）
  const reservedCells = [...reserved].map((k) => k.split(",").map(Number))
  return { tl, br, all: tl.concat(br), dark: [size - 8, 8], reserved: reservedCells }
}

/* ── 矩阵放置：功能图形写真实亮/黑值，另用 isFunc 标出"掩码不许翻"的格 ── */
function buildMatrix(text, version, ecLevel) {
  const size = 17 + 4 * version
  const M = Array.from({ length: size }, () => new Int8Array(size).fill(-1))   // -1 空，0 亮，1 黑
  const isFunc = Array.from({ length: size }, () => new Uint8Array(size))
  const set = (r, c, v, func) => { M[r][c] = v; if (func) isFunc[r][c] = 1 }
  const finder = (r0, c0) => {
    for (let r = -1; r <= 7; r++) for (let c = -1; c <= 7; c++) {
      const rr = r0 + r, cc = c0 + c
      if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue
      const ring = r >= 0 && r <= 6 && (c === 0 || c === 6) || c >= 0 && c <= 6 && (r === 0 || r === 6)
      const core = r >= 2 && r <= 4 && c >= 2 && c <= 4
      set(rr, cc, ring || core ? 1 : 0, true)
    }
  }
  finder(0, 0); finder(0, size - 7); finder(size - 7, 0)
  for (let i = 8; i < size - 8; i++) { set(6, i, i % 2 === 0 ? 1 : 0, true); set(i, 6, i % 2 === 0 ? 1 : 0, true) }
  const cs = alignCenters(version)
  const last = cs.length ? cs[cs.length - 1] : -1
  for (const r of cs) for (const c of cs) {
    if ((r === 6 && c === 6) || (r === 6 && c === last) || (r === last && c === 6)) continue
    for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) set(r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1 ? 1 : 0, true)
  }
  set(size - 7, 8, 1, true)                                   // 暗模块（标准位置，不是 size-8）
  /* 格式信息先登记成功能格（值等选定掩码后再写），免得被数据占掉 */
  const FP = formatPath(size)
  for (const [r, c] of FP.reserved) { isFunc[r][c] = 1; M[r][c] = 0 }   // 值等选定掩码后由 placeFormat 写；先占位并一律标亮。注意暗模块那格不在这里（它是数据格）
  const cws = buildCodewords(text, version, ecLevel)
  const bits = []
  for (const cw of cws) for (let b = 7; b >= 0; b--) bits.push((cw >> b) & 1)
  let bi = 0, up = true
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5                                  // 跨过竖直定时线那一列
    for (let vert = 0; vert < size; vert++) {
      const row = up ? size - 1 - vert : vert
      for (let j = 0; j < 2; j++) {
        const col = right - j
        if (col < 0 || col >= size || isFunc[row][col]) continue
        M[row][col] = bi < bits.length ? bits[bi] : 0
        bi++
      }
    }
    up = !up
  }
  return { M, isFunc, size, codewords: cws.length, bitsPlaced: bi, bitsTotal: bits.length }
}

/* ── 掩码与选型 ── */
const MASK_FN = [
  (r, c) => (r + c) % 2 === 0, (r) => r % 2 === 0, (r, c) => c % 3 === 0, (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0, (r, c) => (r * c) % 2 + (r * c) % 3 === 0,
  (r, c) => ((r * c) % 2 + (r * c) % 3) % 2 === 0, (r, c) => (((r + c) % 2) + (r * c) % 3) % 2 === 0,
]
const isDark = (M, r, c) => M[r][c] === 1
export function penaltyOf(M, size) {
  let p = 0
  const run = (n) => (n >= 5 ? 50 + 2 * (n - 5) : 0)
  for (let r = 0; r < size; r++) { let k = 1; for (let c = 1; c < size; c++) { if (isDark(M, r, c) === isDark(M, r, c - 1)) k++; else { p += run(k); k = 1 } } p += run(k) }
  for (let c = 0; c < size; c++) { let k = 1; for (let r = 1; r < size; r++) { if (isDark(M, r, c) === isDark(M, r - 1, c)) k++; else { p += run(k); k = 1 } } p += run(k) }
  for (let r = 0; r < size - 1; r++) for (let c = 0; c < size - 1; c++) { const v = isDark(M, r, c); if (isDark(M, r, c + 1) === v && isDark(M, r + 1, c) === v && isDark(M, r + 1, c + 1) === v) p += 30 }
  const pat = [1, 0, 1, 1, 1, 0, 1]
  const hasPat = (line) => { for (let i = 0; i + 7 <= line.length; i++) { let ok = true; for (let j = 0; j < 7; j++) if (line[i + j] !== pat[j]) { ok = false; break } if (ok) return true } return false }
  for (let r = 0; r < size; r++) { const line = []; for (let c = 0; c < size; c++) line.push(isDark(M, r, c) ? 1 : 0); if (hasPat(line)) p += 40 }
  for (let c = 0; c < size; c++) { const line = []; for (let r = 0; r < size; r++) line.push(isDark(M, r, c) ? 1 : 0); if (hasPat(line)) p += 40 }
  let dark = 0
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) if (isDark(M, r, c)) dark++
  p += 10 * Math.floor(Math.abs((dark / (size * size)) * 100 - 50) / 5)
  return p
}
function applyMask(base, size, maskIdx) {
  const grid = base.M || base
  const f = base.isFunc || null
  const M = grid.map((row) => Int8Array.from(row))
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) {
    if (f && f[r][c]) continue
    if (MASK_FN[maskIdx](r, c)) M[r][c] = M[r][c] === 1 ? 0 : 1
  }
  return M
}
/** 格式信息 15 位：返回数组下标 0 = bit14（最高位）。BCH(15,5) 生成式 10100110111，再异或 101010000010010。 */
export function formatBits(ecLevel, mask) {
  const ecBits = { L: 0b01, M: 0b00, Q: 0b11, H: 0b10 }[ecLevel]
  const data5 = (ecBits << 3) | mask
  let v = data5 << 10
  for (let i = 14; i >= 10; i--) if ((v >> i) & 1) v ^= 0b10100110111 << (i - 10)
  const bits15 = ((data5 << 10) | (v & 0x3ff)) ^ 0b101010000010010
  const out = []
  for (let i = 14; i >= 0; i--) out.push((bits15 >> i) & 1)
  return out
}
/** 标准摆放：左上复制 bit14→(8,0) … bit8→(8,8)、bit7→(7,8) … bit0→(0,8)；另一条复制 bit7→(8,size-8) … bit0→(8,size-1)、bit14→(size-1,8) … bit8→(size-7,8)。 */
export function placeFormat(M, size, ecLevel, maskIdx) {
  const bits = formatBits(ecLevel, maskIdx)
  const { tl, br, dark } = formatPath(size)
  for (let i = 0; i < 15; i++) {
    const v = bits[14 - i] === "1" ? 1 : 0   // formatBits 给的是 MSB-first 串（最左 = bit14），库按 (bits>>i)&1 取是 LSB-first ⇒ 必须反着索引（我先前直取 bits[i]，整套镜像）
    M[tl[i][0]][tl[i][1]] = v
    M[br[i][0]][br[i][1]] = v
  }
  M[dark[0]][dark[1]] = 1                    // 暗模块恒黑（参考实现里它是 (!test)，定稿那轮就是 true）
  return M
}

/* ── 出图 ── */
export function qrPng(text, opts = {}) {
  const ecLevel = opts.ecLevel || "L"
  const bytes = Buffer.from(text, "utf8")
  const version = opts.version || pickVersion(bytes.length, ecLevel)
  if (!version) return { ok: false, why: "too_long", message: `这段文本 ${bytes.length} 字节，v2..v6/L 装不下（上限 134 字节）`, byteLen: bytes.length }
  const st = structureOf(version, ecLevel)
  if (!st) return { ok: false, why: "table_mismatch", message: `v${version}-${ecLevel} 没有分块数据`, table: st }
  const cap = capacityBytes(version, ecLevel)
  if (bytes.length > cap.bytes) return { ok: false, why: "too_long", message: `这段文本 ${bytes.length} 字节超过 v${version}-${ecLevel} 的 ${cap.bytes} 字节容量`, byteLen: bytes.length, version }
  const base = buildMatrix(text, version, ecLevel)
  if (base.bitsPlaced < base.bitsTotal) return { ok: false, why: "overflow", message: `数据区只有 ${base.bitsPlaced} 个位置、需要 ${base.bitsTotal} 位（码字 ${base.codewords} 个）放不下` }
  let best = null
  for (let m = 0; m < 8; m++) {
    const cand = applyMask(base, base.size, m)
    placeFormat(cand, base.size, ecLevel, m)
    const p = penaltyOf(cand, base.size)
    if (!best || p < best.p) best = { M: cand, mask: m, p }
  }
  const quiet = opts.quiet ?? 4, scale = opts.scale ?? 8
  const dim = (base.size + quiet * 2) * scale
  const px = Buffer.alloc(dim * dim, 255)
  for (let r = 0; r < base.size; r++) for (let c = 0; c < base.size; c++) {
    if (best.M[r][c] !== 1) continue
    const y0 = (r + quiet) * scale, x0 = (c + quiet) * scale
    for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) px[(y0 + dy) * dim + (x0 + dx)] = 0
  }
  return { ok: true, png: matrixToPng(px, dim), version, size: base.size, mask: best.mask, penalty: best.p, dim, byteLen: bytes.length, codewords: base.codewords, capacity: cap }
}

/* ── PNG（8bit 灰度、非交织；交给 zlib 现成封装 —— 手搓 stored 块我漏过 adler32 栽过一次）── */
const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0 } return t })()
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0)
  const cd = Buffer.concat([Buffer.from(type, "ascii"), data])
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(cd), 0)
  return Buffer.concat([len, cd, crc])
}
export function matrixToPng(px, dim) {
  const raw = Buffer.alloc(dim * (dim + 1))
  for (let y = 0; y < dim; y++) { raw[y * (dim + 1)] = 0; px.copy(raw, y * (dim + 1) + 1, y * dim, (y + 1) * dim) }
  const idat = zlib.deflateSync(raw, { level: 6 })
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(dim, 0); ihdr.writeUInt32BE(dim, 4); ihdr.writeUInt8(8, 8); ihdr.writeUInt8(0, 9); ihdr.writeUInt8(0, 10); ihdr.writeUInt8(0, 11); ihdr.writeUInt8(0, 12)
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))])
}

/** 测试/诊断用的内部件（不算公共 API）：与参考实现逐格对比时用 */
export const __internals = { buildMatrix, applyMask, buildCodewords, encodeData, MASK_FN }
