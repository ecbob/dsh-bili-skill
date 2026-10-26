---
name: bili-dm-read
description: 读 B站 消息：未读有多少、有哪些会话、某一个人跟我的完整往来。
whenToUse: 要看有没有人私信我、或要把某条私信的往来看清楚时。
---

## 第一步永远是拿自己的 UID

`bili_auth {action:"status"}` → `uid`（也写在凭证文件的 `dedeuserid`）。私信类端点要的 `talker_id` / `receiver_id` 是**对方**的 UID，"我"从 status 这条出发，别反过来填。

## 未读看哪个数：两个口径会不一致

```
GET /x/msgfeed/unread        params 可空（或带 csrf）
```

- `data` 里就是各类未读数：`chat`（私信）、`reply`、`at`、`like` 等。**先看数字再决定要不要拉正文** —— 一次拉取就是一次往返加一堆文本进上下文。
- ⚠️ **`chat` 会漏**：本机实测对面刚发进私信 6 分钟，`msgfeed/unread` 的 `chat` 一直是 `0`，而 `session_detail` 里同一会话 `unread_count:1`、`ack_seqno` 还停在旧位置 ⇒ **判断"有没有未读私信"认会话级的 `unread_count`，别只看 `chat`**。
- ⚠️ 老的 `x/msgun/num` 现在直接 404 回 HTML（路径已不存在，别再当首选）。
- **会话级真值（本机新验通，比 `get_sessions` 省得多）**：`GET https://api.vc.bilibili.com/session_svr/v1/session_svr/session_detail` `params:{talker_id:<对方UID>, session_type:1, csrf}` → `unread_count` / `ack_seqno` / `max_seqno` / `last_msg{...}`。**"有没有堆着未读"就认这里的 `unread_count`**。
- 怎么标已读：**本机未验通** —— `POST session_svr/update_ack` 两种形状（字段进 body、进 query + `sign:true`）都回 `code:0` 且 `data:{}`，但 `ack_seqno` 没动 ⇒ 形状不对，**别当能力用**，也别反复打（每次都是写请求）。参考实现的 `session.json` 里没有 ack 端点，App 包也搜不到 `update_ack`（走内部协议），没有依据就别瞎猜。

## 有哪些会话

```
GET https://api.vc.bilibili.com/session_svr/v1/session_svr/get_sessions
params:{session_type:1, group_fold:1, unfollow_fold:0, sort_rule:2, build:0, mobi_app:web, csrf}
```

- `data.session_list[]` 一人一条：`talker_id`（对方 UID）、`is_follow`、`unread_count`、`ack_seqno`、`session_ts`，外加 **`last_msg{sender_uid, msg_type, content, msg_seqno, timestamp, msg_key, msg_status, notify_code}`** —— 只想瞄一眼"最近那条是谁说的、说了什么"，这条就够，不必再拉历史。
- 代价：它**一次把所有会话倒出来**（本机 11 个会话约 10 KB），信箱大时别反复调；盯着一个人看就用下一节。
- 系统通知（如「社区中心」的登录提醒）也混在列表里：`msg_type` 不是 1、`content` 是另一套 JSON（`title/text/modules/jump_uri`）—— 如实写"非文本消息 N 条"，别编内容。

## 某一个人的完整往来（本机已实测跑通）

```
GET https://api.vc.bilibili.com/svr_sync/v1/svr_sync/fetch_session_msgs
params:{talker_id:<对方UID>, session_type:1, size:5, csrf}   且 sign:true
```

- ⚠️ **`size` 必须给**：不给时它回 `code:0` 却 `messages:null`、`max_seqno:0`、`min_seqno` 是个 1.8e19 的哨兵值 —— 看着像"这个会话没消息"，其实是端点没返回（本机第一次就栽在这儿，误判成端点坏了）。
- 每条消息的字段：`sender_uid`（**判是谁发的只看这个**，别靠语气猜）、`receiver_id`、`msg_type`（1=文本）、`content`（**本身是个 JSON 字符串**，文本在 `{"content":"…"}` 里，可能带 `\\uXXXX` 转义）、`msg_seqno`、`timestamp`（秒，**服务端自己盖**）、`msg_key`、`msg_status`、`notify_code`、`msg_source`。
- 顺序是**新→旧**。往更早翻：把 `begin_seqno` 填成上一次返回里的 `min_seqno`；`has_more:1` 才继续。`size` 从 3~5 起步，别一次要 100 条。
- `max_seqno` 就是最新一条的 seqno —— 记账与"发完读回核对"都用它。

## 这些路本机没验通（别再当备选）

| 端点 | 实测结果 |
|---|---|
| `im.bilibili.com/x/conversation/chat` | **fetch failed**（这台机器连不通） |
| `/x/msg/chat?talker_id=…` | 旧地址，未验通（大概与 `msgun/num` 一路货） |
| `/x/msg/session` | 未验通（我原先把它写在会话列表那节，属未经证实） |

## 口径

- **读到私信不等于要回**：底座没有自动回信（不轮询、无定时器），回不回由使用者在会话里明说；要回走 `bili-dm-send`。
- 谁可以当"主人"：用 `bili_auth {action:"uid", name}` 或已知 UID 核对；**别拿昵称长得像就当本人**（同名不同人是常事）。
- 读过就记：`bili_ledger {action:"append", table:"dm", key:"msg_key", rows:[{msg_key, peer_uid, direction:"in", seqno, excerpt}]}`。`excerpt` **只写一句摘要**，别把整段对话抄进账本 —— 那是使用者的私事，而且账本会被下次会话整个读进上下文。
- 想数清"是谁发的"时：`sender_uid` 是唯一依据。本机就被这事误导过一次——自动化替小号发出的回复，看上去就像"对方回的"。
