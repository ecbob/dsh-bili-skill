---
name: bili-watch-frames
description: 看一条视频的实际内容：读字幕原文，或取画面帧（故事板裁成单帧；要高清就解视频流），帧作为图片附件回会话，取到就看见。
whenToUse: 需要判断一条视频到底讲了什么（而不只是标题简介）、或要看/留下某一秒的画面时。
---

## 先字幕，后画面

**字幕是"说什么"，帧是"拍了什么"**：字幕逐字、便宜、能全读；帧能看界面与构图，但受取帧方式限制。

1. 拿 cid 与基本信息：`bili_api {path:"/x/web-interface/view", params:{bvid}}`。分 P 视频 `data.pages[]` 每段一个 `cid`；顺带回 `title / owner / duration / stat / pic`。它那份 `data.subtitle.list[]` 里的 `subtitle_url` 常是空串，**别据此判定"没字幕"**，走下一条。
2. 字幕列表：`bili_api {path:"/x/player/wbi/v2", params:{bvid,cid}, sign:true}` → `data.subtitle.subtitles[]` 里的 `subtitle_url`。空数组就是**没有字幕轨**（但画面里仍可能有硬字幕，只能靠帧看）。
3. 字幕正文：`subtitle_url` 形如 `//aisubtitle.hdslb.com/bfs/ai_subtitle/…?auth_key=…`，挂在 **hdslb** CDN 上，底座已放行，直接 `bili_api {path:"<整条 URL>"}`（`//` 开头自动补 `https:`）。这条响应**没有 `{code,message,data}` 信封**，正文在 `body[]` 里，元素 `{from,to,content}`，`from/to` 单位是**秒**。`auth_key` 有时效，过期回第 2 步重新拿。

## 取画面帧：`bili_shot`

```
bili_shot {bvid, num?, at?:[秒,…], tiles?:[格号,…], p?:第几P, hd?:true}
```

它做的事：`view` 拿各 P 的 cid → `/x/player/videoshot?bvid&cid&p` 拿故事板 → 下载整页拼图 → **按格裁成单独一帧**再重编码（纯 JS 解 JPEG，见同包 `jpgcrop.js`）；`hd:true` 时再多走一步（见下节）。

- **每帧直接当图片附件回给会话**：接得住图片的模型取到就等于看见。
- 要看清口径的返回字段：`grid`（`cols x rows`、`tileW x tileH`、拼图张数）、`intervalSec`（每格多少秒）、`intervalBasis`（这个秒数凭什么定的）、`partIndex/partDuration/partStart`、每帧的 `{at, atTo, tile, path, bytes, width, height, lum}`；开 hd 时另有 `ffmpeg / hd_note`，每帧可能带 `hd{path,bytes,width,height,method,codec,stream}` 或 `hd_error`。
- 格子语义（本机逐 P 实测）：**每个 P 有自己的 cid 和自己的故事板**；格子从**该 P 的 0 秒**起按固定秒数一格铺，**尾部补纯黑**（不是"这段没画面"）；`10x10=100` 格 ≈ 500 秒上限。
- `at` 是**相对那个 P 起点的秒**，不是整条视频的绝对秒；要绝对秒就按 `partStart` 换算。跨 P 时把 `p` 传对，或不传让工具按秒自动选段（日志会说明选了哪段）。
- **贴格按格起点算**（`floor(sec / intervalSec)`），所以 `at` 里写整数秒常落进前一格 ⇒ **要哪一格就直接给 `tiles:[格号]`**（0 起，与返回里每帧的 `tile` 一一对应，`tiles` 优先于 `at`）。
- `intervalSec` 优先用接口给的 `ts[]` 差值或"实测内容格数除该 P 时长"推，`intervalBasis` 写明是哪种；都拿不到才退回 5 秒/格。**别把 interval 当精确值**：按秒定位最多精确到那一格（≈ ±interval/2）。
- 每帧的 `lum` 是格内平均亮度 0~255：**lum≈0 就是黑场/淡出**，别当成"这段没画面"下结论，也别把关键内容留在一格 lum≈0 的帧上。
- 拿不到故事板时工具回 `ok:false` + `cover` ⇒ 只有封面可看，结论必须标"没看画面"。若接口改成"一格一图"，工具自动走另一支路，`tiledMode:true` 就是那种情况。

## 想要高清帧：`hd:true`（依赖外部 ffmpeg）

故事板格子只有 480×270（`videoshot` 的 `quality` 参数会被忽略；`archive/screencast` 已 404；dash 响应里**没有按毫秒取帧的缩略图字段**；封面高清但不能按秒取）⇒ 要某一秒的高清静帧只能**解视频流**。

- `hd:true`：按格定位那一秒后，用**外部 ffmpeg** 解流抽帧（`playurl?fnval=16` 挑最高可用的 H.264 轨；本机这条能到 1920×1080@30fps，源即便是 3840×2160 也给到 1080p 轨）。
- ffmpeg 从哪来（按序）：`config.ffmpegPath`（**用的时候现读，改完不必重启**）→ 环境变量 `DSH_BILI_FFMPEG` → PATH → 家目录旁 `.dsh/.build-tools/ffmpeg/ffmpeg.exe` → 工作区 `.dsh/.build-tools/ffmpeg/ffmpeg.exe`。它是**外部程序、不属于包内依赖**。
- **精度要说清**：`-ss` 放在 `-i` 之前是**按关键帧定位**，高清帧可能是那一秒之前最近的关键帧，不逐帧精确 ⇒ 账本 `method` 写 `ffmpeg-keyframe`（格子帧写 `videoshot-crop`），`marked` 里也会写明留的是哪一种。
- 找不到 ffmpeg 或抽不动（权限/地址时效/缺解码器）时**不静默降级**：每帧带 `hd_error`，顶层回 `ffmpeg:"absent"` 或 `hd_note`，工具照样回故事板格子帧。纯 JS 解 H.264 做不到，别宣称不依赖外部程序。

## 留下值得的那几帧：`bili_frames`

```
bili_frames {action:"keep", bvid, at:[秒,…] 或 tiles:[格号,…], p?, reason, hd?}   # 存进 frames/keep/，clear 默认范围不碰
bili_frames {action:"list"}                                                       # frames/ 与 frames/keep/ 各有什么、多少字节
bili_frames {action:"clear", scope?:'temp'|'keep'|'all', olderThanDays?, keepLast?}
```

- **值不值得留由你判断**：默认取帧落的是临时帧，看完就该 `clear` 收掉；只有"以后还要用这张"的才 `keep`，并在 `reason` 里写清为什么（例：`P1 第 40 格：结算面板血量数字可读`）。
- `clear` 默认 `scope:"temp"` —— **只删临时取帧，`keep/` 一律不动**；要连留下的一起删就明说 `scope:"all"`；可用 `olderThanDays` 只清旧的、`keepLast` 保住最新几个。
- **`keep` 与记账联动**：每留一帧工具**自己**往 `ledger/frame` 追加一行（去重键 `file`），字段 `file/bvid/p/tile/at/atTo/lum/width/height/bytes/method/pixels/hd_stream/hd_error/cid/marked/reason`；`marked` 写的是"这一格被判定了什么"，`reason` 是你为什么留它。
- 留下的文件名带**年月日时分秒**：`keep/<bvid>-p<P>-<格号>-<秒>s-<YYYYMMDD-HHMMSS>.jpg` ⇒ 同一格重复留不会互相覆盖，账本每行都指得到一个具体文件。
- 别只在会话里口头说"我留了"：`list` 核对文件真在、`bili_ledger {action:"read", table:"frame"}` 核对账真记了。

## 怎么确认自己真在看图、而不是在编

换一张内容完全不同的图再跑一次做对照：本机测过 GVG 视频封面读出 `虚空之剑` / `血量 2900/2900` / `124/120FPS`，而另一条插件演示视频的第 0 秒帧读出 `可用余额` / `042.17` —— 两套文字互不相干 ⇒ 图确实进了模型；两张完全不同的图给出几乎一样的结论，就是没吃到图。
定位与解码是否对得上，看能不能**区分两种黑**：真出现过的黑帧（该格 lum≈0 且邻格有内容）与尾部补位纯黑（该 P 用不到的格子）。

## 什么都没看时的规矩

只有封面 + 标题 + 简介就下结论时，**必须明说「没看画面」**，并把账本 `evidence` 记成 `"标题+简介"`。绝不把猜测写成「视频里出现了 X」。说"看不清"就如实说，别替糊掉的小字敲定数字。

## 成本口径（本地模型）

- 字幕动辄几万字：**先决定要不要读**（用 `view` 的时长/播放/简介先筛），既然读了就别只读一半就下结论。
- 帧按需：扫一眼 3 张够判题材；要核对界面细节才 `tiles:[…]` 单点取。帧比字幕贵（每张都过一次视觉输入）。
- 临时帧是耗材：用完 `bili_frames {action:"clear"}` 收掉，别让 `frames/` 堆成几百 MB。
- 看过就落账：`bili_ledger {action:"append", table:"seen", key:"bvid", rows:[{bvid, verdict:"挑了"|"跳过", evidence:"字幕"|"帧"|"标题+简介", reason:"一句话"}]}` —— `evidence` 就是将来复盘"这条当时怎么定的"的依据。
