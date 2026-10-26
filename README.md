# bili-skill

B站 能力的**底座**插件：纯 JS、零运行时依赖（只用 node 内置 + 全局 fetch）。与 `c1overzz/dsh-bili-scroll` **并存** —— 它管"每天替你刷一轮 + 日报 + 定时器"，本插件只管**原子能力**，不抢它的值班轮、家目录与配置。

## 架构

```
base（5 只常驻工具）
  bili_auth    登录 / 凭证 / 昵称↔UID   ←   bili-search        搜索、筛选、落账口径
  bili_api     通用端点（Cookie/CSRF/WBI）←  bili-watch-frames  取帧 → 交给 read_image / 视觉插件
  bili_shot  B站 故事板取帧            ←   bili-comment       发评论 / @ 的写法 / 风控
  bili_ledger  JSONL 记账（key 去重）    ←   bili-dm-read       未读 / 会话 / 聊天记录
                                              bili-dm-send       发私信 / 回复 / 回执才算送到
                                              bili-ledger        记什么、什么时候记、怎么去重
```

设计取向（本地模型）：**工具声明要少，说明书按需取**。六项能力各是一份 markdown，你可以直接改它来换判入口径、端点顺序、红线，不用动代码、不用加工具。

## 家目录

全部在 `$DSH_HOME/bili-skill/`（可用 patch config 的 `home` 换地方；删掉这目录 = 彻底回滚）：

| 文件 | 内容 |
|---|---|
| `bili_credential.json` | `sessdata` / `bili_jct` / `buvid3` / `dedeuserid`（字段名与 dsh-bili-scroll 一致，可互抄） |
| `config.json` | 运行时配置（优先于 patch config） |
| `uid-cache.json` | 昵称 → UID，带时间戳，TTL 默认 7 天 |
| `ledger/<表名>.jsonl` | 记账。建议表名：`seen` / `comment` / `dm` / `note` |
| `frames/<bvid>-…jpg` | 临时取帧（`bili_frames {action:"clear"}` 默认删这些） |
| `frames/keep/<bvid>-…jpg` | **裁成单独一帧、决定长期留下的**（配合 `ledger/frame` 记为什么留） |
| `skills/<name>.md` | **你写的覆盖版说明书**：放同名文件就优先用它，插件升级不冲（provider 每次现读磁盘） |
| `base.log` | 本插件日志（写明每次是否签了 wbi、用的哪份凭证） |

## 工具

- `bili_auth {action: status|start|poll|import|clear|uid, key?, name?}` —— 扫码登录两步（`start` 拿 url+key → `poll`）；`import` 从 `bili-duty/` 抄一份凭证省一次扫码；`uid` 把昵称换成 UID（带缓存）。
- `bili_api {path, method?, params?, body?, sign?}` —— 唯一的网络出口。自动带 Cookie；POST 自动补 `csrf=bili_jct`；`sign:true` 时做 WBI 签名（`wts` + `w_rid`，`web_location` 默认 1550101）。`path` 可以是 `/x/...`（打 `api.bilibili.com`）或整条 `https://im.bilibili.com/...`。回 `{ok, code, message, data}`，超长截断。
- `bili_shot {bvid, num?, at?, p?}` —— 故事板定位 + **从整页拼图里裁成单独一帧**（纯 JS 解/编 JPEG，见 `jpgcrop.js`，不用 ffmpeg）；裁好的帧当**图片附件直接回会话**（接图片的模型当场看见），同时在 `frames/` 落一份文件。
- `bili_frames {action: keep|clear|list, bvid?, at?, p?, reason?, scope?, olderThanDays?, keepLast?}` —— `keep` 把某几秒裁成单帧长期留在 `frames/keep/`（值不值得留由你判断，理由记进 `ledger/frame`）；`clear` 默认只删临时取帧、**不动 keep/**；`list` 报有多少、占多少字节。
- `bili_ledger {action: tables|read|append|delete, table, rows?, key?, removeKey?, limit?}` —— append 可按某字段去重（例 `key:"bvid"`），每表一个 jsonl。

## 装

```bash
dsh plugin --profile <profile> add "<这个 tgz 的绝对路径>"   # 或 add bili-skill（发上 npm 之后）
```
装完 `dsh plugin` 会自动把它选进 `dsh.profile.bundles`（因为包声明了 `dsh.bundle.patch`）。**新工具/新 skill 要下一个会话才进声明**（本机会话里已经挂上的宿主会当场装载 bundle，但当前会话的工具目录是会话开始时装配的）。

自检：`node scripts/selftest.mjs`（离线、假 ctx、临时家目录、不联网、不碰真实 `bili-skill/`）。

### 动 profile 的 `cordis.patch.yml` 之前（两条本机踩过的坑）

- 那份文件是**整个 profile 共享的层**：UI 设置、`agent-default-model` 的 `provider: strata`、agent preset 组合、compaction 比例、各插件的 config 覆盖都在同一份里。**别整份覆盖**（我为写热重组探针整份覆盖过一次，顶段被吞 ⇒ 运行报 `no adapter registered for provider "strata"`）。要加自己的行就在**末尾**追加一整条 `- id: bili-skill` 的 config 覆盖；先备份，写完用 `.dsh\.build-tools\patch-guard.mjs doctor` 核关键段。
- 我删旧 tgz 后 `pnpm` 会拿着旧 `package.json` 去找已消失的 tarball ⇒ `ENOENT ... bili-skill-0.7.5.tgz`，插件装不进去（`node_modules\bili-skill` 直接没了）。这时候核对 profile `package.json` 与 `pnpm-lock.yaml` 各指着哪个版本，把 tgz 放回原位或把两边对齐成同一个版本再 `add`。

## 拓展点（按便宜程度）

1. 改 `skills/*.md`（口径、端点顺序、红线）
2. 在家目录放 `skills/<name>.md` 覆盖包内那份（升级不冲）
3. 加能力：`SKILL_NAMES` 里加名字 + 写一份 md，**不用加新工具**
4. 加原子操作：`index.js` 里再 `ctx.tools.register(...)`
5. 状态口：`GET /api/bili-skill/status`（版本/登录状态/家目录/skill 来源/生效配置）—— 以后要给它做设置页就用这条路

## 二维码（bili_auth start）

- 出图引擎：**自研 `qrpng.js` 优先**，它不成才回落 `qrvendor.js`（vendored `qrcode-generator 1.4.4`，MIT，覆盖 v1..v40）；回包里 `qr_png.engine` 会写明用的哪个、有没有 `fellback_from`。
- 自研的覆盖范围与依据（2026-10-26 实测）：**v2..v7 / L 一档**，byte 模式；正确性由**外部解码器 jsQR** 逐字验（活体 `.dsh\.tmp-src\qr-check.mjs` 22 条全过、插件自检 145 项）。做到 v7 是因为**真登录链接 145 字节，v6/L 上限只有 134 字节**。
- 没做的：M/Q/H 档（请求别的 ecLevel 会被当成 L）；v8 及以上；数字/混合模式编码。超出范围时不会瞎画 —— 回 `too_long` 并交给回落链。
- 图落在家目录 `tmp-qr/`（不放 `frames/`：那里是画面帧的管家目录，有 keep/clear 那套管），每次 `start` 只留最新一张。

## 已知边界

- WBI 签名的 query 编码规则各家实现略有差异；`bili_api` 的 `sign` 只负责**加上**签名，端点到底吃不吃由返回值说话（`code=-412/-403` 时 mixin key 会自动作废重取）。每份 skill 里都写了"这个端点不通就换哪个"。
- 只认 `*.bilibili.com`；不是万能 HTTP 客户端。
- 取帧只能贴到故事板格子：本机实测**每格约 5 秒、按每个分 P 从 0 秒起铺、尾部补纯黑**（10x10=100 格 ≈ 500 秒上限），所以 `at` 是相对该 P 的秒、精度 ≈ ±interval/2；返回值里的 `intervalSec` / `intervalBasis` 会说清这个秒数是凭什么算的（`ts[]` > 实测内容格数 > 兜底 5s）。
- 单帧是从拼图里**裁出来重编码**的（每格高 270 不是 8 的倍数，格边界跨 8x8 块 ⇒ 做不了无损 MCU 裁剪，必须解码再编）；解码/编码在同包 `jpgcrop.js`，只支持 baseline（SOF2 progressive 直接抛错不硬解），色度放大用最邻近（.NET 用平滑，比对时差 1~2 属正常）。
- 这三张 `fixtures/ref-*.jpg` 是 Windows `System.Drawing`（独立编码器、标准 Annex K 码表）写的，自检拿它们当**外部基准**盯解码 —— 早先我把 IDCT 的空间/频率下标写反，DC-only 的块被解成 200→142 的渐变，就是这三张一跑就现形的。
- 评论/私信是**拿你的号说话**：本插件只提供通道与口径，不会自己决定发不发（没有任何定时器 / 自动轮）。

## 两条实测出来的硬口径（别改回去）

- **`Referer` 必须是 `https://www.bilibili.com`，不能带尾斜杠。** 本机用同一个视频、同一份凭证逐变量隔离：带 `/` 时写出去的评论是 `state:17 attr:6422528`（=0x620000，被 AI 审核标记、只自己可见，更早那条还被删了）；把 `/` 去掉立刻变回 `state:0 attr:0`。正文说法、`gaia_source`、`statistics` 的引号写法、`accept`、UA（Win/Chrome126 对 Mac/Edge131）、cookie 里带不带 `ac_time_value`/`opus-goback`、用旧的还是 spi 现取的 `buvid3/buvid4` —— 这些都单独试过，**都不是原因**。
- **Gaia 上报默认关**：本机 2×2 实测（上报开/关 × Referer 带/不带斜杠）只有 Referer 起作用 —— 带斜杠一律被标记成 `attr 6422528`，不带斜杠一律 `attr 0`，上报开不开无差别 ⇒ 默认省掉这两次请求，`gaia: true` 可开。 关着也能自愈：请求撞 `-412`/`-352`/只回 `v_voucher` 时会自动现取 spi 上报一次并原样重试一次（只重试一次）。- 判断"发出去的东西到底可不可见"：别信回执里的 `state`（刚发时都显示 0），用 `reply/reply?root=<自己的 rpid>` 读回来核对，或直接看 `view` 的 `stat.reply` 有没有加。
