---
name: bili-watch-frames
description: 看这条视频讲了什么：读字幕原文，或直接取画面帧（从 B站 故事板拼图里裁成单独一帧，作为图片附件回到会话里，取到就看见）。
whenToUse: 需要判断一条视频的实际内容（而不只是标题简介）、或要看/留下某一秒的画面时。
---

## 先字幕，后画面

**字幕是"说什么"，帧是"拍了什么"**，两者互补：字幕逐字、便宜、能全读；帧能看界面与构图，但精度受制于 B站 预生成的故事板格子。

1. 拿 cid 与基本信息：`bili_api {path:"/x/web-interface/view", params:{bvid}}`。分 P 视频 `data.pages[]` 每段一个 `cid`；顺带回 `title / owner / duration / stat / pic`。它那份 `data.subtitle.list[]` 里的 `subtitle_url` 常是空串，**别据此判定"没字幕"**，要走下一条。
2. 字幕列表：`bili_api {path:"/x/player/wbi/v2", params:{bvid,cid}, sign:true}` → `data.subtitle.subtitles[]`，取里面的 `subtitle_url`。空数组就是真没字幕（那就只能看帧或封面，或由带转写的插件补一份）。
3. 字幕正文：`subtitle_url` 形如 `//aisubtitle.hdslb.com/bfs/ai_subtitle/…?auth_key=…` —— 字幕挂在 **hdslb** 这个 CDN 上，底座已经放行，直接 `bili_api {path:"<整条 URL>"}`（`//` 开头会自动补 `https:`）。这条响应**没有 `{code,message,data}` 信封**，正文就在 `body[]` 里，元素是 `{from, to, content}`，`from/to` 单位是**秒**。`auth_key` 有时效，过期回第 2 步重新拿一条 URL。

## 取画面帧：`bili_shot`

```
bili_shot {bvid, num?, at?:[秒,…], p?:第几P}
```

它做四件事：`view` 拿各 P 的 cid → `/x/player/videoshot?bvid&cid&p` 拿故事板 → 下载那张**整页拼图** → **按格子裁成单独一帧**再重编码（纯 JS 解 JPEG，见同包 `jpgcrop.js`，不用 ffmpeg）。

- **每帧直接当图片附件回给会话**：接得住图片的模型取到就等于看见，不必再叫第二个分析工具。
- 返回值里要看这几样，别说错口径：`grid`（`cols x rows`、`tileW x tileH`、拼图张数）、`intervalSec`（**每格多少秒**）、`intervalBasis`（这个秒数是凭什么定的）、`partIndex/partDuration/partStart`、以及每帧的 `{at, atTo, tile, path, bytes, width, height}`。
- 本机实测的格子语义（2026-10-26，BV1VpjW6YE4o 四个 P 逐个验过）：**每个 P 有自己的 cid 和自己的故事板**；格子按 **约 5 秒一格** 从**该 P 的 0 秒**起铺（P1 215s → 用到第 42 格；P2 170s → 33；P3/P4 171s → 33）；`10x10=100` 格 ≈ 500 秒上限，**尾部补的是纯黑格**（不是"视频里这段没画面"）。
- ⇒ 所以 `at` 的秒数是**相对那个 P 的起点**，不是整条视频的绝对秒；要绝对秒就自己按 `partStart` 累加换算。跨 P 时把 `p` 传对，或不传 `p` 让工具按秒自动选段（会在日志里说明选了哪段）。
- **想要某一格就直接给 `tiles:[格号]`**（0 起，和返回值里每帧的 `tile` 一一对应）：本机真栽过 —— `at:[4]` 在 interval 4.43s 时曾被贴到第 0 格（一整格白场），我以为取到了封面、其实取了废帧。贴格按**格起点**算（`floor(sec / intervalSec)`），所以 `at` 里写整数秒经常落进前一格 —— 这不是 bug，是 `at` 的语义；**要哪一格就给 `tiles:[N]` 最省事也最不容易错**（`tiles` 优先于 `at`）。
- `intervalSec` 优先由"接口给的 `ts[]` 差值"或"实测内容格数除该 P 时长"推出，`intervalBasis` 写清了是哪种；两者都拿不到才退回 5 秒/格。**别把 interval 当成精确值**：贴到某一秒最多精确到那一格（≈ ±interval/2）。
- 拿不到故事板（`videoshot` 空）时工具回 `ok:false` + `cover`，此时只有封面可看 ⇒ 结论必须标"没看画面"。
- 若哪天接口改成"一格一图"，工具会自动走另一条支路（直接存原图），`tiledMode:true` 就是这种情况。

## 留下值得的那几帧：`bili_frames`

```
bili_frames {action:"keep", bvid, at:[秒,…], p?, reason}     # 裁成单帧存进 frames/keep/，不会被 clear 默认范围删
bili_frames {action:"list"}                                   # frames/ 与 frames/keep/ 各有什么、多少字节
bili_frames {action:"clear", scope?:'temp'|'keep'|'all', olderThanDays?, keepLast?}
```

- **值不值得留由你判断**：默认取帧（`bili_shot`）落的是临时帧，看完就该 `clear` 收掉；只有"以后还要用这张"的才 `keep`，并在 `reason` 里写清为什么（例如"P1 第 40 格：结算面板血量数字可读"）。
- `clear` 默认 `scope:"temp"` —— **只删临时取帧，`keep/` 里的一律不动**；要连留下的一起删就明说 `scope:"all"`。可以 `olderThanDays` 只清旧的、`keepLast` 保住最新几个。
- **`keep` 与记账是联动的**：每留一帧，工具**自己**往 `ledger/frame` 追加一行（去重键 `file`），字段有 `file/bvid/p/tile/at/atTo/lum/width/height/bytes/cid/reason/marked` —— 其中 `marked` 写的是"这一格被判定了什么"（例：`第 0 格（P1 0~4.06s，格内平均亮度 82.9）`），`reason` 是你为什么留它。,- 留下的文件名带**年月日时分秒**：`keep/<bvid>-p<P>-<格号>-<秒>s-<YYYYMMDD-HHMMSS>.jpg` ⇒ 同一格重复留也不会互相覆盖，账本里每一行都指得到一个具体文件。,- 别只在会话里口头说"我留了"：`list` 能核对文件真在、`bili_ledger {action:"read", table:"frame"}` 能核对账真记了。
- 说"看不清"就如实说：格子只有 480x270，小字糊就别替它把数字敲定。,- 每帧带 `lum`（格内平均亮度 0~255）：**黑场/淡出就是 lum≈0**，别把它当"这段没画面"下结论，也别把重要东西留在一格 lum≈0 的帧上。

## 怎么判断它真在看图、而不是在编

换一张内容完全不同的图再跑一次做对照。本机这么测过：GVG 那条视频的封面读出 `虚空之剑` / `晓` / 血量 `2900/2900` / `124/121FPS`，而余额插件那条视频的第 0 秒帧读出 `可用余额` / `042.17` —— 两套文字互不相干 ⇒ 图确实进了模型。反过来，两张完全不同的图给出几乎一样的结论，就是没吃到图，别信。

裁出来的帧是否真的对应那一秒，本机是这么验的（不用凭感觉）：同一张拼图分别按 `intervalSec` 算出的格子和按"整页当一格"的老算法对比，P1 里第 26、39 格本来就接近纯黑（视频里真出现过黑帧），而 43 格以后是补位纯黑 —— **能区分这两种黑**，就说明定位与解码都对。

## 什么都没看时的规矩

只有封面（`bili_shot` 顺带回 `cover`）+ 标题 + 简介就下结论时，**必须在结论里明说「没看画面」**，并把账本里的 `evidence` 记成 `"标题+简介"`。绝不把猜测写成「视频里出现了 X」。

## 成本口径（本地模型）

- 字幕动辄几万字：**先决定要不要读**（用 `view` 的时长 / 播放 / 简介先筛），既然读了就别只读一半就下结论。
- 帧按需：扫一眼 3 张就够判断题材；要核对界面细节才 `at:[…]` 单点取。帧比字幕贵（每张都要过一次视觉输入）。
- 临时帧是耗材：用完 `bili_frames {action:"clear"}` 收掉，别让 `frames/` 堆成几百 MB（`list` 就是给你先看一眼有多少的）。
- 看过就落账：`bili_ledger {action:"append", table:"seen", key:"bvid", rows:[{bvid, verdict:"挑了"|"跳过", evidence:"字幕"|"帧"|"标题+简介", reason:"一句话"}]}` —— `evidence` 这个字段就是将来复盘「这条我当时是怎么定的」的依据。

## 底座（dsh-bili-base v0.6.0）

**说明书只是指令，本身不带记忆。** 常驻工具 5 只：`bili_auth`（登录/身份/凭证）、`bili_api`（通用端点，自动 Cookie/CSRF/WBI）、`bili_shot`（故事板定位 + 裁成单帧，帧作为图片附件回会话）、`bili_frames`（keep / clear / list 管 frames 目录）、`bili_ledger`（记账：tables/read/append/delete，按 key 去重）。

**记忆在这儿**：家目录 `C:\Users\ECBob\.dsh\bili-base`
- 账本 `ledger/`：seen / comment / dm / note / frame（新）
- 凭证文件在。但"登录与否"要用 `bili_auth {action:"status"}` 现查
- 配置 `bili-base\config.json`；日志 `bili-base\base.log`；帧 `bili-base\frames\`（留下的在 `frames\keep\`）

**缓存边界**：正文每次现读磁盘 ⇒ 改 md 的正文立刻生效；目录也每次现扫，但宿主那份目录缓存没有 TTL、只有提供方喊 invalidate 才清，而默认我**不监视**文件（config 里 `watchSkills:true` 才监视）⇒ 新增/改名/换描述的说明书要等宿主重组才进目录，改正文不用。

**要改这份说明书**：编辑 `C:\Users\ECBob\.dsh\profiles\desktop\node_modules\dsh-bili-base\skills\bili-watch-frames.md`（家目录放同名文件就顶掉包内那份，升级不冲）。

## 想要"高清原帧"？当前做不到（本轮实测过所有已知来源）

| 来源 | 实测结果 |
|---|---|
| `x/player/videoshot` 的格子 | **480×270 就是上限**；我试过加 `quality=2`，返回的 `img_x_size/img_y_size` 一个数都没变（参数被忽略） |
| `x/web-interface/archive/screencast` | **404 回 HTML**（老的故事帧列表，已死） |
| `x/player/playurl?fnval=16`（dash） | 有 `1920x1080/30fps` 的 **H.264** 轨（`avc1.640033`），但响应里**没有任何"按毫秒取帧"的缩略图字段**；`fnval=1` 那份也没有 `durl[].preview` ⇒ 想拿某一秒的高清静帧只能**解视频流** |
| 封面 `data.pic` | 是高清的，但只有"封面那一帧"，不能按秒取 |

**当前口径（已补上 ffmpeg）**：`bili_shot {…, hd:true}` 会先按格子定位那一秒，再用**外部 ffmpeg 解视频流**抽帧（`playurl?fnval=16` 挑最高可用的 H.264 轨 ⇒ 本机这条能到 1920×1080@30fps）。ffmpeg 从哪来：`config.ffmpegPath` → 环境变量 `DSH_BILI_FFMPEG` → PATH → 家目录旁边的 `.dsh/.build-tools/ffmpeg/ffmpeg.exe`（本机这颗是 gyan.dev 的 `ffmpeg 9.0.2-essentials_build`，100.5MB，不属于 npm 依赖）。
- **精度要说清**：`-ss` 放在 `-i` 之前是**按关键帧定位**，所以高清帧可能是那一秒之前最近的关键帧，不是逐帧精确 ⇒ 账本里的 `method` 会写 `ffmpeg-keyframe`（格子帧则写 `videoshot-crop`），`marked` 里也会写明留的是哪一种。
- 抽不动（权限/地址时效/缺解码器）时**不会静默降级**：帧上带 `hd_error`，工具照样回故事板格子帧。纯 JS 解 H.264 仍然做不到，别宣称不依赖外部程序。

