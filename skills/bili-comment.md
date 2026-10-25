---
name: bili-comment
description: 在这条视频下公开发评论（含 @ 某人）：端点、csrf 口径、@ 怎么写、什么不能发。
whenToUse: 要替使用者在某条视频下留言、回复某条评论、或按 @ 的方式叫人时。
---

## 发之前必须知道的三件事

1. **这是拿使用者的号在公开场合说话。** 内容要过"他本人会不会这么说"这一关：不复述视频、不吹自己、不替别人表态。
2. **想 @ 谁就把昵称写进正文**（`mentionName` 在本插件里不是配置项）；拿不准昵称先 `bili_auth {action:"uid", name:"<昵称>"}` 换成 UID。⚠️ 但**别以为写了 `@昵称` 就 @ 到了人**：本机 2026-10-26 实测，`reply/add` 回 `code:0`、拿到 rpid，可回执里 `content.members` 是**空数组** —— 明文 `@ EC君゛` 只是文本，没变成可点的 @；`bilibili_api` 的接口定义里也没有任何 `at_*` 字段。要叫人请走私信（`bili-dm-send`），或让使用者自己去 App 里看。
3. **回执成功 ≠ 公开可见**：接口回 `code:0` 只代表收了；新号/风控会压审，那时连 @ 通知都不推。所以发完要做两件事：记账 + 事后复核（见最后一段）。

## 端点

发评论（POST 会自动补 `csrf=bili_jct`）：

```
POST /x/v2/reply/add
params(query): {csrf, dm_img_list:"[]", dm_img_str:"<两位随机字符>", dm_cover_img_str:"<两位随机字符>", dm_img_inter:'{"ds":[],"wh":[0,0,0],"of":[0,0,0]}'}，并加 `sign: true`
body: {oid:<aid>, type:1, message:"<正文>", plat:1, statistics:'{"appId":100,"platform":5}', root:0, parent:0, csrf}
```
- ⚠️ 正文的键名是 **`message`**，不是 `msg`：写 `msg` 会被判 **`12066 不可发送空白内容`**（本机 2026-10-26 撞实过）。
- ⚠️ `/x/v2/reply` 是**读**列表的路径，往它 POST 回 **`405 Method Not Allowed`**；发评论只打 `/x/v2/reply/add`。
- 这条接口还要 `sign:true`（WBI）+ 上面那四个 `dm_*` 反爬参数 + `plat`/`statistics`；`csrf` 在 query 和 body 里各带一份（缺了就 `-111 CSRF 校验失败`）。
- 成功判据：`code:0` + `data.rpid`（同时回 `rpid_str` —— **记账存字符串那份**）+ `data.success_toast`。
- `oid` 是 **aid**（数字），不是 bvid —— 先 `GET /x/web-interface/view?bvid=` 换 `data.aid`。
- 回复某条评论：`root` = 那条评论的顶层 rpid，`parent` = 被回的那条的 rpid（回楼中楼时 `parent` 填对方 rpid，`root` 填它所在楼）。
- 正文长度上限按 2000 字符对待；`type=1` 是视频，别改。

读评论（复核与判断都用它）：

```
GET /x/v2/reply/main   params:{type:1, oid:<aid>, mode:3, next:<页码>}
```
不通就试 `/x/v2/reply/wbi/main`（加 `sign:true`），再不通退回 `/x/v2/reply?type=1&oid=<aid>&sort=2&pn=1&ps=20`。

## 口径（使用者可改本文件）

- 一条视频**一天最多一条**评论，别在同一栋楼里刷第二遍。
- 内容结构：一个自己的判断 + 一个只有真看过的人说得出的细节。**别引用评论区的话当事实**。
- 争议场子（评论区已经在骂人 / 站队）→ 慎发：宁可不发或改私信（见 `bili-dm-send`），别在别人楼里替谁站台。
- 不要 @ 陌生人凑数；@ 只在"这事与他有关"时用。

## 发完

```
bili_ledger {action:"append", table:"comment", key:"rpid", rows:[{rpid,bvid,aid,body,at_name:"<被@的昵称>",uid:<被@的UID或0>}]
```
`data.rpid` 就在回执里，**必须记**。之后复核：用上面的读评论端点翻一层，看这条 rpid 在不在 —— 在就写「公开可见」，不在就写「**没查到**」（翻页/热度排序都会漏），**绝不写"没发出去"**。

## ⚠️ 决定评论会不会被 AI 审核吞掉的，是 Referer 的那个尾斜杠（本机逐变量实测）

同一个 `/x/v2/reply/add`、同一份凭证、同一台机器、同一个视频，待遇取决于请求形状：

| 谁发的 | 结果 |
|---|---|
| 官方 App（9.15.0）、参考实现 bilibili-api-python（9.x 的 HEADERS） | `state:0 attr:0` 正常公开 |
| 我原先的形状（`Referer: https://www.bilibili.com/` 带斜杠） | `state:17 attr:6422528`（=0x620000）—— 只自己可见，**30 分钟后仍是 17**，更早那条还被删了（回它时 `12022 已经被删除了`，读它时 `12006 没有该评论`） |
| 只把 Referer 去掉尾斜杠（`https://www.bilibili.com`，跟参考实现一致） | `state:0 attr:0` ✓ |

逐变量隔离都做过了，**这些都不是原因**：正文说法（换过三套）、`gaia_source` 有无、`statistics` 的引号写法、`accept` 是 `*/*` 还是 `application/json,…`、UA 是 Mac/Edge131 还是我这台 Win/Chrome126、cookie 里带不带 `ac_time_value`/`opus-goback`、以及**用登录时那对旧 buvid 还是 spi 现取的那对** —— 全都拿到 `attr:0`。唯一的分水岭就是 Referer 有没有那个 `/`。

结论与口径：
- **`Referer` 一律写成 `https://www.bilibili.com`（不带斜杠）**，别自己加 `/`、也别塞完整视频页地址当 referer 去"更像浏览器"。
- 回执里的 `state`/`attr` **别当结论**（带斜杠那阵子是：回执 `state:0`、读回来 17）；要用 `reply/reply?root=<自己的 rpid>` 读回来核对（读法见 `bili-comment-reply`）。判据：`state:0 attr:0` = 正常；`state:17 attr:6422528` = 被标记/只自己可见；读不到且回它回 12022 = 已被删。
- **Gaia 指纹上报（`finger/spi` → `internal/gaia-gateway/ExClimbWuzhi` → 改用现取的 buvid）默认是关的。** 本机做过干净的 2×2：上报开 × referer 带斜杠 → 被标记；上报开 × 不带斜杠 → 干净；上报关 × 带斜杠 → 被标记；上报关 × 不带斜杠 → 干净。**只有 Referer 起作用，上报开不开没有任何差别** ⇒ 为了少两次网络往返把它关掉，`config` 里写 `gaia: true` 可以打开（参考实现每次都做它，理论上能少挨 `-412`/`v_voucher`，但本机没验出收益）。
- 发出去被标记了也别急着改内容重发：**先查 Referer**，再看是不是新号本来就低信任；连着重发只会让号更容易进风控。

## 删自己发的评论（本机已实测）

```
POST /x/v2/reply/del
body: {oid:<aid>, type:1, rpid:<rpid>}
```

- **可以批量**：`oid` 与 `rpid` 都用逗号分隔、一一对应（本机一次删了 16 条，回 `code:0`）。
- ⚠️ 这条的回执是 `code:0` 且 **`data:null`**，没有任何可核对的细节 ⇒ **删完必须读回**：`reply/reply?root=<那条 rpid>` 回 **`12006 没有该评论`** 才算真删（我按这条判据核过：删前读得到 `state:17`，删后同样参数读回 12006）。
- 只能删 `mid` 是自己 UID 的（别人的评论删不掉）；删除是不可逆的公开动作，删了只能重发。
- 删掉之后把账本里那行也删掉，别留一条已经不存在的评论：`bili_ledger {action:"delete", table:"comment", key:"rpid", removeKey:"<rpid>"}`。
