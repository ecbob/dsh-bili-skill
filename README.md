# dsh-bili-skill

B站 能力的**底座**插件：纯 JS、零运行时依赖（只用 node 内置 + 全局 fetch）。与 `c1overzz/dsh-bili-scroll` **并存** —— 它管"每天替你刷一轮 + 日报 + 定时器"，本插件只管**原子能力**，不抢它的值班轮、家目录与配置。

> 名字沿革：`dsh-bili-base`（≤0.6.6）→ `bili-skill`（0.7.x）→ **`dsh-bili-skill`**（0.8.0）。改的只是包名 / 插件 id / 家目录默认段 / 状态口前缀；5 只工具名 `bili_*` 与 7 份说明书名 `bili-*` 一直没动。旧家目录在首次启动时自动搬（见「家目录」）。

## 架构

```
base（5 只常驻工具）
  bili_auth    登录 / 凭证 / 昵称↔UID   ←   bili-search        搜索、筛选、落账口径
  bili_api     通用端点（Cookie/CSRF/WBI）←  bili-watch-frames  取帧 → 交给 read_image / 视觉插件
  bili_shot  B站 故事板取帧            ←   bili-comment       发评论 / @ 的写法 / 风控
  bili_frames  keep / clear / list 管帧 ←   bili-comment-reply 楼中楼：root/parent/dialog、12022
  bili_ledger  JSONL 记账（key 去重）    ←   bili-dm-read       未读 / 会话 / 聊天记录
                                               bili-dm-send       发私信 / 回复 / 回执才算送到
                                               bili-ledger        记什么、什么时候记、怎么去重
```

设计取向（本地模型）：**工具声明要少，说明书按需取**。六项能力拆成 7 份 markdown，你可以直接改它来换判入口径、端点顺序、红线，不用动代码、不用加工具。

## 家目录

全部在 `$DSH_HOME/dsh-bili-skill/`（可用 patch config 的 `home` 换地方；删掉这目录 = 彻底回滚）：

| 文件 | 内容 |
|---|---|
| `bili_credential.json` | `sessdata` / `bili_jct` / `buvid3` / `dedeuserid`（字段名与 dsh-bili-scroll 一致，可互抄） |
| `config.json` | 运行时配置（优先于 patch config，且用的时候现读） |
| `uid-cache.json` | 昵称 → UID，带时间戳，TTL 默认 7 天 |
| `ledger/<表名>.jsonl` | 记账。建议表名：`seen` / `comment` / `dm` / `note` / `frame` |
| `frames/<bvid>-…jpg` | 临时取帧（`bili_frames {action:"clear"}` 默认删这些） |
| `frames/keep/<bvid>-…jpg` | **裁成单独一帧、决定长期留下的**（配合 `ledger/frame` 记为什么留） |
| `skills/<name>.md` | **你写的覆盖版说明书**：放同名文件就优先用它，插件升级不冲（provider 每次现读磁盘） |
| `tmp-qr/` | 扫码登录的二维码图，每次 `start` 只留最新一张 |
| `base.log` | 本插件日志（写明每次是否签了 wbi、用的哪份凭证） |

**改名字带的搬家**：插件改名后家目录默认段也跟着改，首次启动按「由近到远」（`bili-skill` → `bili-base`）把还活着的旧名目录**补进**新家（已有的不覆盖、标记文件不搬），再把旧目录改名成 `<旧名>.migrated-<UTC>` 留档；改名不成（目录被别的进程攥着）就把内容逐项挪进归档、旧壳只留标记。旧壳里的 `.migrated-to-*` 标记认任何去向，搬过的壳永不重搬，绝不静默丢数据。搬家在 `apply()` 入口就做，不等挂载（本机栽过：新实例迟迟不挂载，期间直接用工具写账就已经分家）。把 `config.home` 手动钉在旧名目录上 = 使用者的选择，不搬。

## 工具

- `bili_auth {action: status|start|poll|import|clear|uid|cfgdiag, key?, name?}` —— 扫码登录两步（`start` 拿 url+key → `poll`）；`import` 从 `bili-duty/` 抄一份凭证省一次扫码；`uid` 把昵称换成 UID（带缓存）；`cfgdiag` 现读配置自检。
- `bili_api {path, method?, params?, body?, sign?}` —— 唯一的网络出口。自动带 Cookie；POST 自动补 `csrf=bili_jct`；`sign:true` 时做 WBI 签名（`wts` + `w_rid`，`web_location` 默认 1550101）。`path` 可以是 `/x/...`（打 `api.bilibili.com`）或整条 `https://im.bilibili.com/...`。回 `{ok, code, message, data}`，超长截断。
- `bili_shot {bvid, num?, at?|tiles?, p?, hd?}` —— 故事板定位 + **从整页拼图里裁成单独一帧**（纯 JS 解/编 JPEG，见 `jpgcrop.js`，不用 ffmpeg）；裁好的帧当**图片附件直接回会话**（接图片的模型当场看见），同时在 `frames/` 落一份文件。`hd:true` 再叫外部 ffmpeg 解视频流抽同一秒的高清帧。
- `bili_frames {action: keep|clear|list, bvid?, at?|tiles?, p?, reason?, scope?, olderThanDays?, keepLast?, hd?}` —— `keep` 把某几秒裁成单帧长期留在 `frames/keep/`（值不值得留由你判断，理由记进 `ledger/frame`）；`clear` 默认只删临时取帧、**不动 keep/**；`list` 报有多少、占多少字节。
- `bili_ledger {action: tables|read|append|delete, table, rows?, key?, removeKey?, limit?}` —— append 可按某字段去重（例 `key:"bvid"`），每表一个 jsonl。

## 装

```bash
dsh plugin --profile <profile> add "<这个 tgz 的绝对路径>"   # 或 add dsh-bili-skill（发上 npm 之后）
```
装完 `dsh plugin` 会自动把它选进 `dsh.profile.bundles`（因为包声明了 `dsh.bundle.patch`）——**这行必须自己核对**，插件 id 变了尤其容易只剩 `dependencies` 而没进 bundles。换了 id 的新实例不会被已挂上的宿主热替换，**要重启才挂载**；当前会话的工具目录也是会话开始时装配的，新工具/新 skill 要下一个会话才进声明。

自检：`node scripts/selftest.mjs`（离线、假 ctx、临时家目录、不联网、不碰真实 `dsh-bili-skill/`）。

### 动 profile 的 `cordis.patch.yml` 之前（本机踩过的坑，收口成三条）

- 那份文件是**整个 profile 共享的层**（UI 设置、`provider: strata`、agent preset 组合、compaction 比例、各插件的 config 覆盖都在同一份里）：**别整份覆盖**，要加就在**末尾**追加一整条 `- id: dsh-bili-skill` 的覆盖；先备份，写完用 `.dsh\.build-tools\patch-guard.mjs doctor` 核关键段。
- **插件 id 改名后旧 id 的覆盖行不吃**：profile 里写着的 `- id: bili-skill` / `- id: dsh-bili-base` 要改成新 id，否则你的 config 覆盖静默失效。
- **删旧 tgz 前先把两边对齐**：`pnpm` 会拿着旧 `package.json`/`pnpm-lock.yaml` 去找已消失的 tarball ⇒ `ENOENT ... <包名>-<版本>.tgz`、插件装不进去（`node_modules\<包名>` 直接没了）。同名同版本的 `file:` 依赖即使 `pnpm install --force` 也不重新解包，要先删 `node_modules\<包名>`。命令输出**别过筛选**（失败行会被吞）：`Out-String` 全量落地再读。

## 拓展点（按便宜程度）

1. 改 `skills/*.md`（口径、端点顺序、红线）
2. 在家目录放 `skills/<name>.md` 覆盖包内那份（升级不冲）
3. 加能力：`SKILL_NAMES` 里加名字 + 写一份 md，**不用加新工具**
4. 加原子操作：`index.js` 里再 `ctx.tools.register(...)`
5. 状态口：`GET /api/dsh-bili-skill/status`（版本/登录状态/家目录/skill 来源/生效配置）—— 以后要给它做设置页就用这条路

## 二维码（bili_auth start）

- 出图引擎：**自研 `qrpng.js` 优先**，它不成才回落 `qrvendor.js`（vendored `qrcode-generator 1.4.4`，MIT，覆盖 v1..v40）；回包里 `qr_png.engine` 会写明用的哪个、有没有 `fellback_from`。
- 自研覆盖：**v2..v10 × L/M/Q/H 四档**、byte 模式；正确性由**外部解码器 jsQR** 逐字验（活体 `.dsh\.tmp-src\qr-check.mjs` + 插件自检）。做到 v10 是因为真登录链接有余量需求（v6/L 只装 134 字节，实测链接 145 字节）。
- 没做的：数字/混合模式编码、v11 及以上。超出范围不会瞎画 —— 回 `too_long` 并交给回落链。
- 图落在家目录 `tmp-qr/`（不放 `frames/`：那里是画面帧的管家目录，有 keep/clear 那套管），每次 `start` 只留最新一张。

## 已知边界

- WBI 签名的 query 编码规则各家实现略有差异；`bili_api` 的 `sign` 只负责**加上**签名，端点到底吃不吃由返回值说话（`code=-412/-403` 时 mixin key 会自动作废重取）。每份 skill 里都写了"这个端点不通就换哪个"。
- 只认 `*.bilibili.com`（外加 hdslb / bilivideo）；不是万能 HTTP 客户端。
- 取帧只能贴到故事板格子：本机实测**每格约 5 秒、按每个分 P 从 0 秒起铺、尾部补纯黑**（10x10=100 格 ≈ 500 秒上限），所以 `at` 是相对该 P 的秒、精度 ≈ ±interval/2；想要精确某一格就用 `tiles` 直取。返回值里的 `intervalSec` / `intervalBasis` 会说清这个秒数是凭什么算的（`ts[]` > 实测内容格数 > 兜底 5s）。
- 单帧是从拼图里**裁出来重编码**的（每格高 270 不是 8 的倍数，格边界跨 8x8 块 ⇒ 做不了无损 MCU 裁剪，必须解码再编）；解码/编码在同包 `jpgcrop.js`，只支持 baseline（SOF2 progressive 直接抛错不硬解），色度放大用最邻近（.NET 用平滑，比对时差 1~2 属正常）。
- `fixtures/ref-*.jpg` 是 Windows `System.Drawing`（独立编码器、标准 Annex K 码表）写的，自检拿它们当**外部基准**盯解码与落位 —— 早先我把 IDCT 的空间/频率下标写反、把行列表公式写错，都是这几张一跑就现形的。
- 评论/私信是**拿你的号说话**：本插件只提供通道与口径，不会自己决定发不发（没有任何定时器 / 自动轮）。

## 两条实测出来的硬口径（别改回去）

- **`Referer` 必须是 `https://www.bilibili.com`，不能带尾斜杠。** 本机用同一个视频、同一份凭证逐变量隔离：带 `/` 时写出去的评论是 `state:17 attr:6422528`（=0x620000，被 AI 审核标记、只自己可见，更早那条还被删了）；把 `/` 去掉立刻变回 `state:0 attr:0`。正文说法、`gaia_source`、`statistics` 的引号写法、`accept`、UA（Win/Chrome126 对 Mac/Edge131）、cookie 里带不带 `ac_time_value`/`opus-goback`、用旧的还是 spi 现取的 `buvid3/buvid4` —— 这些都单独试过，**都不是原因**。
- **Gaia 上报默认关**：本机 2×2 实测（上报开/关 × Referer 带/不带斜杠）只有 Referer 起作用 —— 带斜杠一律被标记成 `attr 6422528`，不带斜杠一律 `attr 0`，上报开不开无差别 ⇒ 默认省掉这两次请求，`gaia: true` 可开。关着也能自愈：请求撞 `-412`/`-352`/只回 `v_voucher` 时会自动现取 spi 上报一次并原样重试一次（**只重试一次**）。判断"发出去的东西到底可不可见"：别信回执里的 `state`（刚发时都显示 0），用 `reply/reply?root=<自己的 rpid>` 读回来核对，或直接看 `view` 的 `stat.reply` 有没有加。
