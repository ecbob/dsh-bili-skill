/**
 * qrvendor.js —— 用 vendored 的 qrcode-generator（MIT）出二维码图
 *
 * 为什么还留着这个文件：自研 qrpng.js 已修通（jsQR 逐字验通 v2..v6/L），登录路径默认走自研；
 *   这份 vendored 参考实现（覆盖 v1..v40、含非 byte 模式）留作**兜底与对照裁判** —— 链接超长或超出我范围时回落。
 * 两份都在包里：qrpng.js 是我继续修的那份（由 selftest 里 jsQR 的 roundtrip 断言盯着），qrvendor.js 是当前能用的那份。
 * 出图参数：模块放大 8 倍、四周静区 4 模块（8x8 像素点）—— 这是本机实测能被解码器接受的最小安全形状。
 * 依赖：只读同目录的 vendor/qrcode-generator-1.4.4.js（打进 npm 包），运行时不联网、不读包外目录。
 */
import { createRequire } from "node:module"
import { matrixToPng } from "./qrpng.js"

const require = createRequire(import.meta.url)
/* 文件名必须是 .cjs：本包 package.json 里 "type": "module"，包内 .js 会被 Node 当 ESM 加载，
   那份 UMD 的 module.exports = factory() 在 ESM 语境里根本不存在 ⇒ require 回来的导出是**空 object**（本机实测：typeof=object、ownKeys=[]，报 "makeQR is not a function"）。
   改名 .cjs 后 Node 无论包类型都按 CommonJS 加载，导出就是工厂函数本身。 */
const mod = require("./vendor/qrcode-generator-1.4.4.cjs")
const makeQR = mod   // .cjs 之后 module.exports 就是工厂函数本身（工具函数 stringToBytes 等挂在它身上）


/** @returns {{ok:boolean, png?:Buffer, dim?:number, version?:number, size?:number, why?:string, message?:string}} */
export function qrPngVendor(text, opts = {}) {
  const scale = opts.scale ?? 8, quiet = opts.quiet ?? 4
  let q
  try {
    q = makeQR(opts.version || 0, "L")
    q.addData(String(text))
    q.make()
  } catch (e) { return { ok: false, why: "encode_failed", message: "参考实现也没编出来：" + String(e?.message || e) } }
  const size = q.getModuleCount()
  const dim = (size + quiet * 2) * scale
  const px = Buffer.alloc(dim * dim, 255)
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) {
    if (!q.isDark(r, c)) continue
    const y0 = (r + quiet) * scale, x0 = (c + quiet) * scale
    for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) px[(y0 + dy) * dim + (x0 + dx)] = 0
  }
  /* version 由模块数反推：库里的 typeNumber 字段在这个上下文读不到（本机实测回 undefined），别再往外报假数 */
  return { ok: true, png: matrixToPng(px, dim), dim, version: Math.round((size - 17) / 4), size }
}
