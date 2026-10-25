# dsh-bili-base

B站 能力的**底座**插件：纯 JS、零运行时依赖（只用 node 内置 + 全局 fetch）。与 `c1overzz/dsh-bili-scroll` **并存** —— 它管"每天替你刷一轮 + 日报 + 定时器"，本插件只管**原子能力**，不抢它的值班轮、家目录与配置。

## 架构

```
base（4 只常驻工具）                       skills（7 份 SKILL.md，按需加载）
  bili_auth    登录 / 凭证 / 昵称↔UID   ←   bili-search        搜索、筛选、落账口径
  bili_api     通用端点（Cookie/CSRF/WBI）←  bili-watch-frames  取帧 → 交给 read_image / 视觉插件
  bili_shot  B站 故事板取帧            ←   bili-comment       发评论 / @ 的写法 / 风控
  bili_ledger  JSONL 记账（key 去重）    ←   bili-dm-read       未读 / 会话 / 聊天记录
                                              bili-dm-send       发私信 / 回复 / 回执才算送到
                                              bili-ledger        记什么、什么时候记、怎么去重
```

设计取向（本地模型）：**工具声明要少，说明书按需取**。六项能力各是一份 markdown，你可以直接改它来换判入口径、端点顺序、红线，不用动代码、不用加工具。

## 家目录

全部在 `$DSH_HOME/bili-base/`（可用 patch config 的 `home` 换地方；删掉这目录 = 彻底回滚）：

| 文件 | 内容 |
|---|---|
| `bili_credential.json` | `sessdata` / `bili_jct` / `buvid3` / `dedeuserid`（字段名与 dsh-bili-scroll 一致，可互抄） |
| `config.json` | 运行时配置（优先于 patch config） |
| `uid-cache.json` | 昵称 → UID，带时间戳，TTL 默认 7 天 |
| `ledger/<表名>.jsonl` | 记账。建议表名：`seen` / `comment` / `dm` / `note` |
| `frames/<bvid>-…jpg` | 取到的画面帧（给 `read_image` 或视觉类插件吃） |
| `skills/<name>.md` | **你写的覆盖版说明书**：放同名文件就优先用它，插件升级不冲（provider 每次现读磁盘） |
| `base.log` | 本插件日志（写明每次是否签了 wbi、用的哪份凭证） |

## 工具

- `bili_auth {action: status|start|poll|import|clear|uid, key?, name?}` —— 扫码登录两步（`start` 拿 url+key → `poll`）；`import` 从 `bili-duty/` 抄一份凭证省一次扫码；`uid` 把昵称换成 UID（带缓存）。
- `bili_api {path, method?, params?, body?, sign?}` —— 唯一的网络出口。自动带 Cookie；POST 自动补 `csrf=bili_jct`；`sign:true` 时做 WBI 签名（`wts` + `w_rid`，`web_location` 默认 1550101）。`path` 可以是 `/x/...`（打 `api.bilibili.com`）或整条 `https://im.bilibili.com/...`。回 `{ok, code, message, data}`，超长截断。
- `bili_shot {bvid, num?, at?}` —— 用 B站 自带故事板 `x/player/videoshot` 取帧，**不解码视频、不用 ffmpeg**；帧落成文件并回路径。
- `bili_ledger {action: tables|read|append|delete, table, rows?, key?, removeKey?, limit?}` —— append 可按某字段去重（例 `key:"bvid"`），每表一个 jsonl。

## 装

```bash
dsh plugin --profile <profile> add "<这个 tgz 的绝对路径>"   # 或 add dsh-bili-base（发上 npm 之后）
```
装完 `dsh plugin` 会自动把它选进 `dsh.profile.bundles`（因为包声明了 `dsh.bundle.patch`）。**新工具/新 skill 要下一个会话才进声明**（本机会话里已经挂上的宿主会当场装载 bundle，但当前会话的工具目录是会话开始时装配的）。

自检：`node scripts/selftest.mjs`（离线、假 ctx、临时家目录，不联网、不碰真实 `bili-base/`）。

## 拓展点（按便宜程度）

1. 改 `skills/*.md`（口径、端点顺序、红线）
2. 在家目录放 `skills/<name>.md` 覆盖包内那份（升级不冲）
3. 加能力：`SKILL_NAMES` 里加名字 + 写一份 md，**不用加新工具**
4. 加原子操作：`index.js` 里再 `ctx.tools.register(...)`
5. 状态口：`GET /api/bili-base/status`（版本/登录状态/家目录/skill 来源/生效配置）—— 以后要给它做设置页就用这条路

## 已知边界

- WBI 签名的 query 编码规则各家实现略有差异；`bili_api` 的 `sign` 只负责**加上**签名，端点到底吃不吃由返回值说话（`code=-412/-403` 时 mixin key 会自动作废重取）。每份 skill 里都写了"这个端点不通就换哪个"。
- 只认 `*.bilibili.com`；不是万能 HTTP 客户端。
- 取帧只有故事板帧（B站 预生成的那些），**不能**任意时刻精确截图；要真解码得另找工具（ffmpeg 类插件）。
- 评论/私信是**拿你的号说话**：本插件只提供通道与口径，不会自己决定发不发（没有任何定时器 / 自动轮）。

## 两条实测出来的硬口径（别改回去）

- **`Referer` 必须是 `https://www.bilibili.com`，不能带尾斜杠。** 本机用同一个视频、同一份凭证逐变量隔离：带 `/` 时写出去的评论是 `state:17 attr:6422528`（=0x620000，被 AI 审核标记、只自己可见，更早那条还被删了）；把 `/` 去掉立刻变回 `state:0 attr:0`。正文说法、`gaia_source`、`statistics` 的引号写法、`accept`、UA（Win/Chrome126 对 Mac/Edge131）、cookie 里带不带 `ac_time_value`/`opus-goback`、用旧的还是 spi 现取的 `buvid3/buvid4` —— 这些都单独试过，**都不是原因**。
- **Gaia 上报默认关**：本机 2×2 实测（上报开/关 × Referer 带/不带斜杠）只有 Referer 起作用 —— 带斜杠一律被标记成 `attr 6422528`，不带斜杠一律 `attr 0`，上报开不开无差别 ⇒ 默认省掉这两次请求，`gaia: true` 可开。 关着也能自愈：请求撞 `-412`/`-352`/只回 `v_voucher` 时会自动现取 spi 上报一次并原样重试一次（只重试一次）。- 判断"发出去的东西到底可不可见"：别信回执里的 `state`（刚发时都显示 0），用 `reply/reply?root=<自己的 rpid>` 读回来核对，或直接看 `view` 的 `stat.reply` 有没有加。
