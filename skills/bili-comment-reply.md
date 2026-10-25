---
name: bili-comment-reply
description: 回复某条评论（楼中楼）：root/parent/dialog 怎么填、回信怎么读回来、以及 12022 这类"目标已不在"该怎么判。
whenToUse: 要回某人身下的那条评论、或复核自己发的评论/回复到底在不在时。
---

## 先拿到"回哪一条"的 rpid

回复的对象必须是**读到的** rpid，不是记忆里的：

```
GET /x/v2/reply/main    params:{type:1, oid:<aid>, mode:3, next:1}      ← 热门/顶层
GET /x/v2/reply         params:{type:1, oid:<aid>, sort:2, pn:1, ps:20} ← 按时间
GET /x/v2/reply/reply   params:{type:1, oid:<aid>, root:<顶层rpid>, pn:1, ps:10}  ← 某一楼的楼中楼
```

- ⚠️ **自己的新评论/回复常常在前两个里读不到，却在 `reply/reply` 里读得到**（本机 2026-10-26 实测：`reply/main?mode=3` 与 `reply?sort=2` 都回空、`stat.reply` 也还是 0，但用 `reply/reply?root=<顶层rpid>` 立刻看到顶层本体 + `replies[0]` = 我刚发的那条，正文逐字一致）。**复核自己发的东西一律走 `reply/reply`**。
- 顶层在不在看 `data.root`（有就是还在），回复数看 `data.root.rcount` 与 `data.root.reply_control.sub_reply_entry_text`（例如「共1条回复」）。

## 发回复

跟发评论同一个端点，只是 `root` / `parent` 要填对：

```
POST /x/v2/reply/add
params(query)：csrf + 四个 dm_* 反爬参数 + sign:true   （同 bili-comment，缺 csrf 回 -111）
body: {oid:<aid>, type:1, message:"<正文>", plat:1, statistics:'{"appId":100,"platform":5}',
       root:<这栋楼的顶层 rpid>, parent:<被回的那条 rpid>, csrf}
```

- 回**顶层评论**：`root` = `parent` = 那条的 rpid（本机实测这样填最干净）。
- 回**楼中楼里的某一条**：`parent` = 被回那条的 rpid，`root` = 它所在楼的顶层 rpid（不是 parent 的 parent）。
- 正文键名照旧是 **`message`**（写成 `msg` 会 12066）。
- 成功回执要核这三样：`data.rpid`（记账用 `rpid_str` 字符串那份）、`data.root` / `data.parent` 是否等于你填的、以及 **`data.dialog`** —— B站 会给这条回复分配 `dialog`（本机实测 `dialog` 就等于本次新 rpid，那是这一楼里对话串的锚）。

## ⚠️ 回信前先看目标还在不在（这几个码都撞到过）

| 码 | 含义 | 该怎么办 |
|---|---|---|
| `12022` | **被回的那条已经被删除了**（本机实测：回昨天那条 `rpid 318192981489` 直接回这个）—— 新号发的评论常在几十分钟内被系统清掉，别默认它还在 | 停手。要么改回还在的那条，要么走私信（`bili-dm-send`）。**别重试**，重试不会让它回来 |
| `-111` | 缺 csrf | query 与 body 各带一份 `csrf=bili_jct` |
| `12066` | 正文空白（字段名写成 `msg` 了） | 改用 `message` |
| `160006` 类 / `12001` | 目标评论不存在 / 内容重复度过高 | 如实报告，别换端点硬试 |

**状态字段怎么看**：`reply/reply` 里每条带 `state` 与 `attr`。本机实测刚发的两条都是 **`state:17`**（进库但未完全公开），`attr:6422528`。所以「发出去了」与「别人看得见」之间有一段窗口，别把前者当后者报。

## 口径（使用者可改本文件）

- 一次回信只回一条；同一楼里连回两条以上就是刷屏，除非使用者明说。
- 回信正文比首评更短：一句判断 + 一句只有看过才说得出的补充。**别在回复里自我辩解**（「我上一条说错了」可以，「我是插件所以……」不必）。
- 楼中楼里 @ 人同样不会自动变成可点的 @（同 `bili-comment` 的实测结论），要叫人就走私信。
- 回完记账（**表还是 `comment`，用 `root` 字段区分楼**）：

```
bili_ledger {action:"append", table:"comment", key:"rpid",
  rows:[{rpid, bvid, aid, root, parent, dialog, direction:"reply", body, state, visibility:"已读到"|"没查到"|"已被删"}]}
```

复核动作与结果都必须写进行：**查不到就写「没查到」，被删就写「已被删」（`12022` 就是硬证据），绝不写"没发出去"。**

## 回复也吃同一个 Gaia 指纹上报

回复走的是同一个 `reply/add`，所以 `bili-comment` 里那条结论对回复同样成立：**`Referer` 必须写成 `https://www.bilibili.com`（不带尾斜杠）**，带斜杠会被判 `state:17 attr:6422528`。Gaia 上报底座已自动化，但它不是这次降级的决定因素（逐变量隔离过）。
base 已自动处理，不用你手动拼。另外回执里的 `state` 与 `attr` **不能当结论用**（本机实测：刚发时回执都是 `state:0`，读回来才知道是 17）——判在不在一律按上面那节用 `reply/reply?root=<顶层rpid>` 读。