# dsh-bili-skill

B站 能力的**底座**插件：纯 JS、零运行时依赖（只用 node 内置 + 全局 fetch）。它提供**原子能力** —— 扫码登录与凭证、昵称↔UID、一条自动带 Cookie/CSRF/WBI 签名的通用 API 通道、故事板取画面帧（并把整页拼图裁成单独一帧）、JSONL 记账。常驻的工具声明只有 5 只，七份能力说明书按需加载。

它**不做**这些事：没有定时器、没有值班轮、没有日报、没有专用 profile；不会自己决定发不发评论或私信（那是拿使用者的号在公开场合说话）；不代管别人的家目录。

## 现在有的能力

| 能力 | 怎么提供 | 判据 |
|---|---|---|
| 扫码登录 | `bili_auth {action:"start"}` 出二维码（自研引擎出图、直接当**图片附件**回会话）→ `{action:"poll", key}` 换凭证；`86090 已扫未确认 / 86038 已失效 / 86101 未扫` 三种中间态如实分开，只认 `data.code` | 登录成功后补跟一次 crossDomain（让 cookie 撒到各子域），`{action:"status"}` 现查 |
| 凭证管理 | 四个 cookie 字段落 `bili_credential.json`；`credential-source.json` 记这份凭证是 `scan` 来的还是 `import` 抄的；`{action:"import"}` 从别处抄一份省一次扫码；`{action:"clear"}` 只删本机凭证 | 出图引擎与回落写在回包的 `qr_png.engine` / `fellback_from` |
| 身份 | `{action:"uid", name:"<昵称>"}` 把昵称换成 UID，带家目录缓存（TTL 默认 7 天） | 走 WBI 签名的用户搜索接口 |
| 通用 API 通道 | `bili_api` 一只工具是唯一的网络出口：自动带 Cookie（首字母大写与小写两种拼写一起发）、POST 自动补 `csrf`/`csrf_token`、`sign:true` 时做 WBI 签名、撞风控（`-412`/`-352`/只回 `v_voucher`）时现取指纹上报一次并**原样重试一次**（只一次） | 回 `{ok, code, message, data}`；没有 `code` 信封的裸响应整份回在 `data` 里（字幕正文就是这种），超长按 `maxBytes` 截断 |
| 画面帧 | `bili_shot` 用 `x/player/videoshot` 故事板定位、把那一个格子从整页拼图里**裁成单独一帧**（纯 JS 解/编 baseline JPEG，不依赖 ffmpeg），帧作为图片附件直接回会话并在 `frames/` 留一份；`hd:true` 另叫外部 ffmpeg 解视频流抽同一秒的高清帧 | 每帧带 `tile/at/atTo/width/height/bytes/lum`，顶层带 `intervalSec` 与它的依据 `intervalBasis`、`partIndex/partStart/partDuration` |
| 帧管家 | `bili_frames {action:"keep"}` 把选中的格长期留在 `frames/keep/`（文件名带时间戳、同一格重复留不互相覆盖）并**自动往 `ledger/frame` 记一行**；`clear` 默认只删临时帧、不动 `keep/`；`list` 报数量与字节 | 账本行的去重键是 `file` |
| 记账 | `bili_ledger {tables｜read｜append｜delete}`，一表一个 `<表名>.jsonl`，append 可按字段去重（`key:"bvid"` 这种），脏行不炸（原样带出来），写之前把目录补出来 | `read` 默认回最后 50 行，每行自动补 `at` |
| 看现场 | 家目录 `status.json` 快照（挂载即写、每问即刷）+ `GET /api/dsh-bili-skill/status` | 见「看现场」 |

## 架构

```
base（5 只常驻工具）                     七份 SKILL.md（按需加载，讲怎么用这 5 只）
  bili_auth    登录 / 凭证 / 昵称↔UID  ←   bili-search        搜索、筛选、落账口径
  bili_api     通用端点（Cookie/CSRF/WBI）← bili-watch-frames  读字幕原文 / 取画面帧
  bili_shot    故事板定位 + 裁单帧      ←   bili-comment       发评论 / @ 的写法 / 风控
  bili_frames  keep / clear / list      ←   bili-comment-reply 楼中楼：root/parent/dialog、12022
  bili_ledger  JSONL 记账（key 去重）   ←   bili-dm-read       未读 / 会话 / 某人完整往来
                                           bili-dm-send       发私信 / 回复 / 怎么算送到了
                                           bili-ledger        记什么、什么时候记、怎么去重
```

设计取向（面向本地模型）：**声明要少，说明书按需取**。加一项能力只要往 `SKILL_NAMES` 里添个名字 + 写一份 md，不用加工具；改判入口径、端点顺序、红线只要改 markdown，不用动代码。

## 工具签名

- `bili_auth {action: status|start|poll|import|clear|uid|cfgdiag, key?, name?}`
- `bili_api {path, method?, params?, body?, sign?, headers?, cookies?}` —— `path` 以 `/` 开头即 `api.bilibili.com` 下的路径，也给整条 URL（只认 `bilibili.com / hdslb.com / bilivideo.com`）；`headers`/`cookies` 是排查风控时自己试 UA、referer、accept 的入口
- `bili_shot {bvid, num?, at?|tiles?, p?, hd?}` —— `tiles` 是按格号直取（比换算秒准），`at` 是相对所选分 P 起点的秒
- `bili_frames {action: keep|clear|list, bvid?, at?|tiles?, p?, reason?, scope?, olderThanDays?, keepLast?, hd?}`
- `bili_ledger {action: tables|read|append|delete, table, rows?, key?, removeKey?, limit?}`

## 家目录

一切数据都在 `$DSH_HOME/dsh-bili-skill/` 这一个目录里（`config.home` 可换地方；删掉这目录 = 彻底回滚）：

| 文件 | 内容 |
|---|---|
| `bili_credential.json` | `sessdata` / `bili_jct` / `buvid3` / `dedeuserid` 四个 cookie 字段 |
| `credential-source.json` | 这份凭证是 `scan`（自己扫的码）还是 `import`（从别处抄的） |
| `config.json` | 运行时配置：**用的时候现读**，优先于 patch config（改完不必重启） |
| `uid-cache.json` | 昵称 → UID，带时间戳 |
| `gaia-state.json` | 现取指纹上报后的 `buvid3/buvid4`（默认不报，只有撞风控自愈时才写） |
| `ledger/<表名>.jsonl` | 记账，建议表名 `seen` / `comment` / `dm` / `note` / `frame` |
| `frames/<bvid>-…jpg` | 临时取帧（`clear` 默认范围就是这些） |
| `frames/keep/<bvid>-…jpg` | 长期留下的单独一帧（`clear` 默认不碰） |
| `skills/<name>.md` | 使用者写的覆盖版说明书，同名即顶掉包内那份，升级不冲 |
| `tmp-qr/` | 二维码图，每次 `start` 只留最新一张 |
| `status.json` | 状态快照（挂载即写、每问即刷） |
| `base.log` | 插件日志：这次签了 wbi 没有、用的哪份凭证、撞风控有没有重试、有没有搬家 |

家目录段名跟着包名走。若同层还留着**旧名字的目录**，首次启动按「由近到远」逐个搬：只把新家缺的文件补进来（已有的不覆盖）、搬运标记不进新家、旧目录改名成 `<旧名>.migrated-<UTC>` 留档；整目录改名不动（被别的进程攥着）就把内容逐项挪进归档、旧壳只留标记。带 `.migrated-to-*` 标记的壳永不重搬 —— 绝不静默丢数据。手动把 `config.home` 钉在旧名目录上算使用者意愿，不搬。

## 配置

内置默认值，优先级 `家目录 config.json` > `patch config` > 默认（空值不覆盖）：

| 键 | 默认 | 作用 |
|---|---|---|
| `home` | 空 = `$DSH_HOME/dsh-bili-skill` | 数据全在这个目录 |
| `requestTimeoutMs` | 12000 | 单次 HTTP 超时 |
| `maxBytes` | 262144 | 响应截断上限（字符） |
| `framesDefault` | 3 | `bili_shot` 默认取几帧（1-12） |
| `autoImportCredential` | true | 没有有效凭证时先试着从 `../bili-duty` 抄一份（省一次扫码；抄完两边各自独立） |
| `uidTtlDays` | 7 | 昵称→UID 缓存天数 |
| `watchSkills` | false | 开 true 才监视说明书目录变化并喊宿主失效（默认零后台） |
| `gaia` | false | 指纹上报开不开（开着时 POST 前先报一次；关着也能撞风控自愈） |
| `ffmpegPath` | 空 = 自动找 | 高清取帧用的外部 ffmpeg：`ffmpegPath` → `DSH_BILI_FFMPEG` → PATH → 家目录旁 `.dsh/.build-tools/ffmpeg/ffmpeg.exe` → 工作区旁 |

## 装

```bash
dsh plugin --profile <profile> add "<这颗 tgz 的绝对路径>"
```

- 装完必须核对 profile `package.json` 的 `dsh.profile.bundles` 里有 `dsh-bili-skill` 这一行（装工具只保证 `dependencies` 与 `node_modules`）。
- 新实例**要重启宿主才挂载**；当前会话的工具目录是会话开始时装配的，新工具/新 skill 要下一个会话才进声明。说明书正文每次现读磁盘，改 md 立刻生效。
- 同一版本号重打包后（还没发布就改了内容），`pnpm` 不会自己换掉已解包的那份：要先删 `node_modules\dsh-bili-skill`、核实它物理消失、再装，然后逐文件复算摘要。
- 依赖：DSH `>=0.2.0-rc.2`、Node `>=22`；`@deepseek-ai/dsh-tools` 与 `dsh-skill` 是可选 peer（拿不到时插件自己退化成等价的工具声明装配）。

离线自检：`node scripts/selftest.mjs` —— 纯假 ctx + 假 fetch + 临时家目录，不联网、不写真实家目录，**172 项**（含真造目录跑搬家、状态口路由本身、帧裁切与落位、外部基准图盯解码）。

## 看现场（两条路，别只认一条）

- **家目录 `status.json`** —— 版本、登录与否、家目录、账本每张表几行、skill 目录与来源（bundled/override）、生效配置、写入时间。判"挂没挂、装的是哪版、还剩什么账"不必碰 HTTP，也不受鉴权影响。
- `GET /api/dsh-bili-skill/status` —— 同一份内容（顺带把快照刷新一遍），`content-type: application/json; charset=utf-8`、`cache-control: no-store`；前缀下不认的路径回自己的 `{"ok":false,"error":"no-route"}`。⚠️ 这条路由挂在**宿主的浏览器会话鉴权**后面：宿主只在 `GET /` 与 `GET /connect` 认 query token 并下发 `dsh-auth-<base64url(sha256(authority))>` 这份 HttpOnly cookie，其余路径一律只认 cookie ⇒ 命令行不带它打这条就是 401，**那不代表路由没挂上**；浏览器里同源直接开（设置页那条路）就是 200。

## 边界

- 域名白名单只放 `*.bilibili.com` 外加 `hdslb.com` / `bilivideo.com`；它不是万能 HTTP 客户端。
- WBI 签名的 query 编码各家实现略有差异：`sign:true` 只负责**把签名加上**，端点吃不吃由返回值说话（回 `-403` 时 mixin key 作废、下次重取）。每条能力在它的说明书里都写了"这条不通换哪条"。
- 取帧只能贴到故事板格子：格子按每个分 P 从 0 秒起铺、尾部补纯黑（10×10 = 100 格），`at` 的精度约 ±interval/2；要精确某一格用 `tiles` 直取。`intervalSec` 的依据优先级是接口给的 `ts[]` > 实测内容格数 > 兜底 5 秒，`intervalBasis` 会把用的是哪个说出来。
- 单帧是从拼图里裁出来**重编码**的（每格高不是 8 的倍数 ⇒ 做不了无损 MCU 裁剪）：`jpgcrop.js` 只支持 baseline JPEG（progressive 直接抛错不硬解），色度上采样用最邻近（与 .NET 的平滑差 1~2 属正常）。
- 高清帧依赖外部 ffmpeg；找不到时不静默降级 —— 顶层 `ffmpeg:"absent"` + `hd_note`，每帧 `hd_error`，实际用的定位口径逐帧写在 `hd.method`。
- 私信"送到了"只能到这一步：拿到 `msg_key` 算投递、`fetch_session_msgs` 读回逐字核对算确认；**标已读没做**（`session_svr/update_ack` 在这台机器上没验通，所以不提供），未读一律认会话级 `unread_count`（`msgfeed/unread` 的 `chat` 会漏）。未互关会撞 `21047`，撞到就停手。
- 评论/回复的可见性要读回才知道：别把回执的 `state` 当结论。发评论的形状有一条硬口径见下。
- 想 @ 人：写 `@昵称` 只会留成文本，不会变成可点的 @（`reply/add` 没有可用的 at 字段），要叫人就走私信。

## 两条硬口径（别改回去）

- **`Referer` 必须是 `https://www.bilibili.com`，不能带尾斜杠。** 带 `/` 时写出去的评论会被判 `state:17 attr:6422528`（=0x620000，AI 审核标记、只自己可见，过一会儿还可能被删）；去掉那个 `/` 就是 `state:0 attr:0`。正文说法、`gaia_source`、`statistics` 的引号写法、`accept`、UA、cookie 里带不带 `ac_time_value`、用旧的还是现取的 buvid —— 都逐变量试过，都不是原因，分水岭只有这个尾斜杠。
- **Gaia 指纹上报默认关。** 上报开与关对上面这件事没有差别（只有 Referer 起作用），所以默认省掉 `spi` + `ExClimbWuzhi` 两次往返；`gaia: true` 可打开。关着也能自愈：撞 `-412` / `-352` / 只回 `v_voucher` 时自动现取 spi、上报一次、把原请求重试一次（**只重试一次**，绝不循环）。

## 实现参考

本插件的实现参考 **`c1overzz/dsh-bili-scroll`**（MIT，DSH 上另一路 B站 插件）：登录凭证的字段形状与互抄口径、"把帧存成宿主的图片附件、模型不接图就退化成文字"这条输出契约、以及「家配置优先于 patch 配置、空值不覆盖、用的时候现读」的配置合并方式，都照它的做法定下来；本插件不调用它、不共它的家目录、也不抢它的值班轮。另参考 `bilibili-api-python`（MIT）的 WBI 签名（重排表与 `wts`/`w_rid` 拼法）、`buvid_fp` 的 murmur3_x64_128、`_uuid` 形状与 Gaia 上报三步；二维码以 vendored 的 `qrcode-generator` v1.4.4（MIT, Kazuhiko Arase）作参考实现与对照数据（它不写格式信息，所以那部分以规范表为准），随包文件头保留其原版权声明；JPEG 编解码照 ITU-T T.81 的 Annex K 标准表，基准图由 Windows `System.Drawing` 生成。`jsQR`（MIT）与这些基准图只作**外部裁判**，没有一行代码来自它们、也不进包。归属另见 `LICENSE`。
