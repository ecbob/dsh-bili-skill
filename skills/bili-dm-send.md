---
name: bili-dm-send
description: 给别人发私信或回私信：端点与字段形状、未互关的限制、以及"送到了"要怎么核对。
whenToUse: 要替使用者主动发一条私信、或回复收到的私信时。
---

## 送之前先认收件人

`bili_auth {action:"uid", name:"<昵称>"}` → UID（带缓存）。填错 UID 就等于发给陌生人，别靠猜。

## 发私信（本机实测跑通）

```
POST https://api.vc.bilibili.com/web_im/v1/web_im/send_msg
params(query)：{w_sender_uid:<自己UID>, w_receiver_id:<对方UID>}   且 sign:true（csrf 走 body，`bili_api` 自动补；query 不给也通，本机 2026-10-26 实测）
body（字段名带方括号；msg[content] 的值本身是个 JSON 字符串）：
  msg[sender_uid]=<自己UID>    msg[receiver_id]=<对方UID>    msg[receiver_type]=1
  msg[msg_type]=1（纯文本）     msg[msg_status]=0
  msg[content]={"content":"<正文>"}
  msg[dev_id]="A6716E9A-7CE3-47AF-994B-F0B34178D28D"   msg[new_face_version]=0
  msg[timestamp]=<秒>   from_filework=0   build=0   mobi_app=web   csrf=<bili_jct>
```

- 踩过的坑都有码可查：`POST /x/msg/send` → **404 回 HTML**（这条路径已经不存在）；不带 `csrf` → **`-111 CSRF 校验失败`**；vc 这条同样**要签名**（`sign:true`）。
- ⚠️ `msg[timestamp]` 只是参考值：本机实测我传 `1792962360`、库里落的是 `1792962304` —— **服务端自己盖时间戳**，别拿它当去重键，也别指望它等于你传的那个数。

## 回信怎么回

- **没有「回复某一条」的专用字段**（返回里没见过可照抄的字段名，就不瞎编）：回信 = 同一会话里再发一条，正文引用对方那条的原话或暗号，让对方和你都对得上上下文。
- 想说得准，先读再回：用 `bili-dm-read` 里的 `fetch_session_msgs`（**记得给 `size`**）拿到 `msg_seqno` / `msg_key` / 原文，再决定回什么 —— 别凭记忆回，私信内容是本机外的状态。

## ⚠️ 怎么算"送到了"

1. **拿到 `data.msg_key` 只算投递成功**（⚠️ `msg_key` 是超过 JS 安全整数的大数，底座会自动转成字符串回给你，记账也按字符串存）。
2. **强一档是读回来核对**：发完再用 `fetch_session_msgs?size=3` 拉一次，看那条在不在、`msg_key` 与正文是否逐字对上、`sender_uid` 是不是自己（本机核对过：回执 `msg_key` 与历史里完全一致）。
3. `code:0` 但没有 `msg_key` ⇒ 可能没真送到（对方不收陌生人私信、被风控）。
4. **未互关的硬限制**：**`code:21047`「对方主动回复或关注你前，最多发送 1 条消息」** —— 不是长度问题。撞到就**停手、如实报告**，别换端点重试轰炸（连着发只会把号送进风控）。
5. 其它常见码：`10003`（UID 不存在）、`-410`（请求过多）、`19002`（内容风控／含链接）、`1400` 类（缺 csrf 或未登录）。

## 口径

- 同一次会话里主动私信**最多一条**，除非使用者明说要多发；再发之前先读账本（见 `bili-ledger`），别凭印象。
- 文本要短、要说清来源（哪条视频 / 哪件事），不复述他早就知道的东西。
- 别在私信里发链接堆、别写"如需更详细信息请告诉我"这种客服尾巴。
- 本插件**没有自动回信**：不轮询私信、没有定时器，回不回由使用者在会话里明说。
- 发完记账：`bili_ledger {action:"append", table:"dm", key:"msg_key", rows:[{msg_key, peer_uid, direction:"out", code, seqno, readback, excerpt}]}`。**没拿到 `msg_key` 就记 `msg_key:"none"` 并把 `code` 写进去** —— 下次看账就知道这条不算送到。
