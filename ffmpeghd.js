/**
 * ffmpeghd.js —— 用外部 ffmpeg 解视频流，取某一秒的**高清帧**（本机实测：这条视频最高有 1920x1080 的 H.264 轨）。
 *
 * 为什么需要它：B站 故事板格子只有 480x270（`videoshot` 的 quality 参数会被忽略），
 * 想要高清原帧就必须解视频流 —— 纯 JS 不引运行时依赖做不到，所以这里调**外部 ffmpeg 可执行文件**。
 * 找不到 ffmpeg 时 hdFrame 回 {ok:false, why:'no-ffmpeg'}，调用方必须如实说明并回落到格子帧，不许静默换低清。
 *
 * 精度口径（诚实）：`-ss` 放在 `-i` 前面是**按关键帧定位**（快），所以取到的帧可能不是那一秒的精确帧、
 * 而是它前面最近的关键帧 ⇒ method 一律写成 'ffmpeg-keyframe'，别宣称逐帧精确。
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

/** 找 ffmpeg：配置 ffmpegPath → 环境变量 DSH_BILI_FFMPEG → PATH → 家目录旁边的 .dsh/.build-tools/ffmpeg/ffmpeg.exe */
export function findFfmpeg({ ffmpegPath, home, existsSync = (p) => fs.existsSync(p), which = () => null } = {}) {
  const cands = []
  if (ffmpegPath) cands.push(String(ffmpegPath))
  if (process.env.DSH_BILI_FFMPEG) cands.push(process.env.DSH_BILI_FFMPEG)
  const w = which()
  if (w && w.Source) cands.push(String(w.Source))
  if (home) cands.push(path.join(path.dirname(home), '.build-tools', 'ffmpeg', 'ffmpeg.exe'))
  // 本机实测栽过：ffmpeg 在「工作区的 .dsh\.build-tools」而不是 profile 家目录旁边 ⇒ 两种摆法都试
  for (const base of [process.env.DSH_WORKSPACE, process.cwd()]) {
    if (!base) continue
    cands.push(path.join(base, '.dsh', '.build-tools', 'ffmpeg', 'ffmpeg.exe'))
    cands.push(path.join(base, '.build-tools', 'ffmpeg', 'ffmpeg.exe'))
  }
  for (const c of cands) { try { if (c && existsSync(c)) return c } catch { /* 忽略 */ } }
  return null
}

/** 从 playurl 的 dash 里挑码率最高的 H.264 视频轨（AV1/HEVC 排后面：本机 ffmpeg 是 essentials，解 H.264 最稳）。 */
export function pickStream(dashVideo) {
  const list = (Array.isArray(dashVideo) ? dashVideo : []).filter((v) => v && (v.baseUrl || v.base_url))
  if (!list.length) return null
  const scoreOf = (v) => {
    const px = (Number(v.width) || 0) * (Number(v.height) || 0)
    const codecs = String(v.codecs || '')
    const codecBonus = /avc1/.test(codecs) ? 1e9 : /hev|hvc/.test(codecs) ? 5e8 : /av01/.test(codecs) ? 1e8 : 0
    return px + codecBonus + (Number(v.frame_rate) > 30 ? 1 : 0)
  }
  return [...list].sort((a, b) => scoreOf(b) - scoreOf(a))
}

/**
 * 抽一帧。deps: {call, ffmpeg, framesDir, UA, REFERER, log, timeoutMs}
 * 试轨顺序按 pickStream 的高→低，最多 3 条（高档位可能受登录/权限限制，试不动就降级）。
 */
export async function hdFrame(deps, { bvid, cid, sec, index }) {
  const { call, log, REFERER, UA } = deps
  const ffmpeg = deps.ffmpeg
  if (!ffmpeg) return { ok: false, why: 'no-ffmpeg', message: '没找到 ffmpeg 可执行文件（config.ffmpegPath / DSH_BILI_FFMPEG / PATH / .dsh/.build-tools/ffmpeg/ffmpeg.exe 都试过）' }
  const pl = await call({ path: '/x/player/playurl', params: { bvid, cid, fnval: 16, platform: 'pc', pn: Number(index) || 1, request: 0 } })
  const streams = pickStream(pl.data?.dash?.video)
  if (!streams) return { ok: false, why: 'no-stream', message: `playurl 没给出可解码的视频轨（code=${pl.code} ${pl.message}）` }
  const tried = []
  for (const st of streams.slice(0, 3)) {
    const url = st.baseUrl || st.base_url
    const tag = `${st.width}x${st.height}@${st.frame_rate || '?'}fps ${st.codecs || '?'}`
    const out = path.join(deps.framesDir, `hd-${bvid}-p${Number(index) || 1}-${String(Math.round(Number(sec) * 100)).padStart(6, '0')}cs-${Date.now()}.jpg`)
    const args = ['-hide_banner', '-loglevel', 'error', '-user_agent', UA, '-headers', `Referer: ${REFERER}\r\n`, '-ss', String(Number(sec) || 0), '-i', url, '-frames:v', '1', '-q:v', '2', '-y', out]
    const r = spawnSync(ffmpeg, args, { encoding: 'buffer', timeout: deps.timeoutMs || 45000, windowsHide: true })
    const err = String(r.stderr || '').slice(0, 160)
    if (!r.error && r.status === 0 && fs.existsSync(out) && fs.statSync(out).size > 0) {
      const sz = fs.statSync(out)
      log(`高清帧解码成功：${tag}（seek ${sec}s 按关键帧）→ ${path.basename(out)} ${sz.size}B`)
      return { ok: true, path: out, bytes: sz.size, width: Number(st.width) || null, height: Number(st.height) || null, method: 'ffmpeg-keyframe', codec: st.codecs || 'avc1', stream: tag, sec, tried }
    }
    tried.push({ stream: tag, reason: r.error ? String(r.error.message || r.error).slice(0, 80) : `exit=${r.status} ${err}` })
    try { if (fs.existsSync(out)) fs.unlinkSync(out) } catch { /* 清不掉就算了 */ }
    log(`高清帧这一轨没成（${tag}）：${tried[tried.length - 1].reason}`)
  }
  return { ok: false, why: 'decode-failed', message: 'ffmpeg 在，但这些轨都抽帧失败（多半是权限/时效地址过期/解码器缺）', tried }
}
