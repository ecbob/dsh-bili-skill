---
name: bili-search
description: 按关键词在 B站 搜索并筛选视频：用哪个端点、时间戳口径、怎么判值不值得、结果怎么落账。
whenToUse: 要按关键词找/刷 B站 视频、或把一堆搜索结果筛成候选时。
---

## 只走 bili_api，别猜

1. `bili_auth {action:"status"}` —— 先确认有凭证；没有就 `start` + `poll` 扫一次码（没登录也能搜，但结果与翻页会差）。
2. 搜索（这类端点吃 WBI 签名；本机实测**不签也通**，但仍建议给 `sign:true`）：

```
GET /x/web-interface/wbi/search/type
params: {search_type:"video", keyword:"<词>", page:1, page_size:20, order:"pubdate"}
sign: true
```

- `order` 可选：`pubdate`(最新) / `click`(播放量) / `dm`(弹幕) / `stow`(收藏) / `scores` / `totalrank`(综合)。
- 结果在 `data.result[]`，每行有 `bvid` / `aid` / `title`（**带 `<em>` 高亮标签，用前先剥掉**）/ `play` / `danmaku` / `reply` / `pubdate` / `ctime` / `duration` / `owner.name` / `description`。
- ⚠️ 时间戳全是**秒**。近 N 天就自己按 `pubdate >= 现在秒数 - N*86400` 筛，别指望接口只回新的。
- 翻页用 `page`，分页参数名是 **`page_size`**（写成 `ps` 会被静默忽略、照样回 20 条；`/x/space/wbi/arc/search` 那边才是 `ps`）。够用就取第一页前几行，别多翻 —— 每翻一页都是一次往返。

## 判"值不值得"的次序（省 token 的关键）

1. `GET /x/web-interface/view  params:{bvid}` —— 这条**不要**签名，且信息最全：`title` / `desc` / `stat.view|reply|danmaku|coin|favorite|share` / `duration` / `pubdate` / `owner` / `videos`（分 P 数）/ `cid`。
2. 只有还想不通的才去读材料：字幕（见 `bili-watch-frames` 后面的字幕端点）或画面帧。**别看评论来判断内容**（评论是风向，不是内容）。
3. 默认筛除口径（使用者可改本文件）：
   - 播放 < 30 **且** 评论 < 3 的新投稿 → 除非标题正中使用者明确关注的点，否则跳；
   - 纯 BGM / 简介自标"无旁白"的 → 跳（没有可判断的文本）；
   - 同题材教程一次出现 5~6 条 → 只留信息增量最大那条，其余记跳过；
   - 拿不准 = **记跳过**，不要反复权衡（同一次会话里反复权衡最费 token）。

## 记完要落账

```
bili_ledger {action:"append", table:"seen", key:"bvid", rows:[{bvid,title,up,play,verdict:"挑了"|"跳过",reason}]}
```
`key:"bvid"` 会自动跳过已有行 ⇒ 想重判同一条就先 `delete`。开刷之前先 `bili_ledger {action:"read", table:"seen", limit:200}`，**已经记过的 bvid 不再重复挑**。

## 直接按 UID 取某个人的投稿（本机已实测通）

不想绕关键词，就用人的 UID 直接拿他发了什么：

```
GET /x/space/wbi/arc/search
params: {mid:<UID>, pn:1, ps:10, order:"pubdate", sub_order:0, tid:0}
sign: true
```

- 结果在 `data.list.vlist[]`：`bvid` / `aid` / `title` / `author` / `mid` / `created`（**秒**）/ `length`（`"mm:ss"` 字符串）/ `play` / `comment` / `review` / `description`。
- `data.page.count` 是总数（决定要不要翻页）。`data.is_risk` / `gaia_res_type` / `gaia_data` 是这类端点**自带的风控旗标**：`is_risk:true`、`gaia_res_type` 非 0、`gaia_data` 非空都说明这一页被拦过 ⇒ 歇会儿再来，**别连着轰**（越轰越严）。注意 `is_risk:true` **不会**触发底座的自动重试（只有 `-412` / `-352` / 只回 `v_voucher` 才会），所以看见它就该停手，而不是再打一次。
- 签名更稳但不必需：本机 2026-10-26 实测，不带签名、cookie 里连 `buvid3` 都没有，照样回了完整列表且 `is_risk:false`。也别把 `-412` 直接归因到没签名上。
- 顺手查这个人本身：`GET /x/web-interface/card  params:{ctr:<UID>}`（**不用**签名）→ `data.card.name / sign / level / fans`。
- 典型链条：`bili_auth {action:"uid", name:"昵称"}` 换 UID → 本端点取他的投稿 → `/x/web-interface/view` 逐条核实 → 落账。

## 端点不通时的换法

- 回 `code:-412` / `-352`、或 `code:0` 却只回 `v_voucher` ⇒ 底座**已经**会自动现取 spi、上报一次指纹、再原样重试一次（只一次，日志写「撞风控…重试」）。重试还不通就是真风控：歇够再来，**别循环轰炸**，也别再指望「补 buvid3」能救 —— 本机实测不带 buvid 也能通。
- `/x/web-interface/wbi/search/type` 不行就试 `/x/web-interface/search/type`（同一套参数，不带 wbi 前缀）。
- 都不行 → 退到不需要签名的入口：`/x/web-interface/popular`（综合热门）、`/x/web-interface/ranking/v2?rid=0&type=all`（排行榜）、`/x/series/recArchivesByKeywords?keywords=<词>`（相关合集）。这些**不看关键词时间线**，只能当兜底，并在回报里说明用的是哪条。