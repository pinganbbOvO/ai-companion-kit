# ai-companion · 让 AI 有个"人样"

> 决定一个陪聊像不像人的，不是模型，是**三件小事**：
> **记不记得你**、**打字像不像人**、**知不知道自己该不该说话**。
>
> 这个包只做这三件事。它不绑定平台，不绑定模型，不绑定 QQ。

```bash
npm install ai-companion
```

```js
import { Memory, Humanizer, Waker } from 'ai-companion';

const mem = new Memory({ dir: './data' });      // 记忆：按「人」存
const human = new Humanizer();                   // 说话：像人打字
const waker = new Waker({ names: ['小鱼'] });     // 场合：该不该理
```

---

## 先说三个真实的失败

大部分"AI 陪聊"项目栽在三个地方，跟模型强弱无关：

### ① 记忆按「会话」存 → 换个地方就不认识你了

```
私聊里：  "我叫老王，养了只猫"
（切到群里）
群里问：  "我叫什么？"
AI：      "抱歉，我不知道你的名字呢"
```

因为记忆挂在**会话**上。私聊一个桶，群 A 一个桶，群 B 一个桶。
同一个人换了桶，AI 就失忆。

**这个包的做法**：记忆挂在**人**身上（用账号 id 当 key）。
不管他在私聊还是哪个群，读写的都是同一本账。

### ② 回复"唰"一下全出来 → 一眼假

```
[对方] 在吗
[你]   在的！有什么可以帮您的吗？我随时都在哦～
                    ↑ 0.2 秒内一次性出现
```

真人不是这样的。真人会：
先"正在输入…"一两秒，然后**一句一句**发出来，中间还停顿。

**这个包的做法**：`Humanizer` 负责打字时长（跟字数相关 + 抖动 + 深夜变慢）、
自动分条、条间随机停顿、偶尔来个"长停顿"（像被什么事打断了）。

### ③ 什么时候都说话 → 很快被踢出群

```
[群友A] 中午吃啥
[AI]    我觉得可以吃麻辣烫！麻辣烫的好处有：1. …
[群友A] …
[群友B] 周末去哪玩
[AI]    推荐几个好去处：1. …
                    ↑ 五分钟后被移出群聊
```

**这个包的做法**：`Waker` 把"要不要醒"拆成独立条件——
被 @、被叫名字、被提问、被拍一拍、指定的人发言、关键词、随机概率。
任何一个命中才醒，否则**一个字都不说**。

---

## 安装

```bash
npm install ai-companion
# 想接 QQ 的话，还需要一个 OneBot 实现（下面讲）
```

---

## 三分钟上手

### 只要「像人打字」

```js
import { Humanizer } from 'ai-companion';

const human = new Humanizer({ msPerChar: 85 });

await human.say('在呢，咋了', {
  setTyping: (on) => platform.setTyping(chatId, on),   // 可选：显示"正在输入"
  send: (text) => platform.send(chatId, text),
});
```

它会自动：等 1.2 秒 → 发出去。
如果内容是 `'行\n你慢点'`，它会拆成两条，中间停 0.7~2.6 秒。

### 只要「记得住人」

```js
import { Memory } from 'ai-companion';

const mem = new Memory({ dir: './data' });

// 记一笔（不管他在哪个会话，都记到"这个人"头上）
mem.remember('10001', { name: '老王', trait: '常熬夜', fact: '养了只猫' });

// 唤醒时取出来，塞进 system prompt
console.log(mem.renderPerson('10001'));
// 【关于 老王（10001）的一本账】
// 你了解他：常熬夜
// 他告诉过你：养了只猫
// 你们互动过 1 次
```

### 只要「该不该说话」

```js
import { Waker } from 'ai-companion';

const waker = new Waker({
  names: ['小鱼'],
  ownerIds: ['10001'],          // 主人说话必醒
  probability: 0.05,            // 别人闲聊 5% 概率插一句
});
waker.setConfig('group:555', {
  atMention: true,
  nameMention: false,           // 群里只被 @ 才醒
  probability: 0,
});

const d = waker.shouldWake({
  key: 'group:555', userId: '20002', name: '小李',
  text: '@小鱼 在吗', isAtMe: true,
});
// { wake: true, reason: 'atMention' }
```

### 全都要（跑一个完整的）

```bash
cp config.example.json config.json     # 填 key、填你的 QQ 号
cp role.example.md role.md             # 改角色卡

npm run check     # 体检角色卡
npm run dry       # 干跑（不真发消息，只打印）
npm start         # 真跑
```

---

## 完整架构

```
                    ┌───────────────────────────────┐
   你的 QQ ─────────▶│  OneBot 实现                  │
                    │  NapCat / Lagrange / SnowLuma │
                    └───────────┬───────────────────┘
                                │ WebSocket (事件)
                    ┌───────────▼───────────────────┐
                    │  transport-onebot.js          │
                    │  翻译成统一消息格式            │
                    └───────────┬───────────────────┘
                                │
                    ┌───────────▼───────────────────┐
                    │  Waker · 该不该说话            │
                    │  @/名字/提问/拍/关键词/概率     │
                    └───────────┬───────────────────┘
                          醒了  │
                    ┌───────────▼───────────────────┐
                    │  Brain · 生成回复              │
                    │  ┌─────────────────────────┐  │
                    │  │ Role   角色卡 → 提示词   │  │
                    │  │ Memory 账本 + 最近对话   │  │
                    │  │ LLM    调模型            │  │
                    │  └─────────────────────────┘  │
                    └───────────┬───────────────────┘
                                │ 文本
                    ┌───────────▼───────────────────┐
                    │  Humanizer · 怎么发            │
                    │  打字时长 → 分条 → 停顿        │
                    └───────────┬───────────────────┘
                                │
                    ┌───────────▼───────────────────┐
                    │  OneBot → 你的 QQ             │
                    └───────────────────────────────┘
```

每一层都能单独用，也能换掉。比如你想接 Telegram，
只要照着 `transport-onebot.js` 的接口再写一个，其它三样原样能用。

---

## 五个模块

| 模块 | 干什么 | 单独用 |
|---|---|---|
| `Memory` | 记忆账本 + 跨场合对话流 | ✅ |
| `Role` | 读角色卡 → 拼 system prompt + 体检 | ✅ |
| `Brain` | 拼上下文 → 调模型 → 写回记忆 | ✅ |
| `Humanizer` | 打字时长 / 分条 / 停顿 | ✅ |
| `Waker` | 该不该说话 / 潜水管理 | ✅ |
| `OneBot` | QQ（OneBot v11）适配 | 可替换 |

### Memory · 记忆怎么存的

两个文件，都是纯文本，随便看随便改：

**`data/people.json`** —— 按人存的账本

```json
{
  "10001": {
    "name": "老王",
    "traits": ["常熬夜", "嘴上嫌我笨其实一直给我加功能"],
    "facts": ["养了只叫豆豆的猫"],
    "topics": ["他说下周要出差"],
    "pending": ["想问他那只猫叫什么来着"],
    "interactions": 37,
    "firstSeenAt": 1791407913658,
    "lastSeenAt": 1791412928131
  }
}
```

**`data/turns.jsonl`** —— 跨场合的对话流（一行一条）

```jsonl
{"t":1791409879392,"where":"private:10001","who":"老王","text":"今天加班到两点","reply":"又熬，你这身体不要了"}
{"t":1791409879393,"where":"group:555","who":"老王","text":"我回来了","reply":"哟，出差回来啦"}
```

唤醒时，把「这个人的账」+「最近 20 轮对话」一起塞进提示词。
所以它既知道**长期的事**（常熬夜、养猫），也知道**刚才发生了什么**。

### Waker · 潜水是怎么实现的

- `setConfig(key, {...})` 给每个会话单独配规则
- `shouldWake(msg)` 返回 `{wake, reason}`，日志里能看到因为什么醒的
- `wake(key)` / `dive(key, ms)` 管理"刚说过话 → 安静一会儿"

群里推荐配置（不被烦）：

```js
waker.setConfig('group:555', {
  mode: 'diving',          // 潜水
  infinite: true,          // 无限期，直到再次命中条件
  atMention: true,         // 被 @ 就醒
  nameMention: false,      // 叫名字不醒
  question: false,         // 被提问不醒
  poke: true,              // 被拍一拍醒
  probability: 0,          // 闲聊一律不理
  speakerIds: ['10001'],   // 但主人说话必醒
});
```

---

## 角色卡怎么写

见 `role.example.md`。要点就三条：

1. **写清"怎么说话"** —— 长度、语气、口头禅、明确禁止什么（别说 Markdown、别每条都关心人）
2. **给边界** —— 什么不做、什么必须做
3. **别写太长** —— 超过 `roleMaxChars` 会被截断，而且模型对超长提示词的注意力会衰减

`Role.lint()` 会体检：

```js
const role = new Role({ cardPath: './role.md' });
console.log(role.lint());
// { ok: false, warn: ['没写「不做什么」——没有边界的角色容易跑偏'] }
```

---

## 接 QQ 要准备什么

你只需要一个 **OneBot v11 实现**（负责登录 QQ、收发消息）：

| 实现 | 说明 |
|---|---|
| [NapCat](https://github.com/NapNeko/NapCatQQ) | 基于 QQ NT，跨平台，活跃 |
| [Lagrange.Core](https://github.com/LagrangeDev/Lagrange.Core) | C# 实现，无需装 QQ |
| [LLOneBot](https://github.com/LLOneBot/LLOneBot) | QQ NT 插件形式 |
| SnowLuma | 同类实现，本项目的 OneBot 适配按它的行为调过 |

配好之后在它的设置里开启：
- **正向 WebSocket** → 记下端口（默认 3001），填进 `config.json` 的 `onebot.wsUrl`
- **HTTP API** → 记下端口（默认 3000），填进 `onebot.httpUrl`

然后 `npm start`。

> ⚠️ 先 `npm run dry` 干跑一遍。它会把模型生成的回复**打印出来但不真发**，
> 确认语气对了再开真发。

---

## 常见问题

**Q: 它一次发好几条，会不会显得刷屏？**
`humanize.burstMax` 控制一次最多几条（默认 4）。
超出的会自动合并到最后一条。觉得吵就调小，或者加大 `gapRange`。

**Q: 群里它一句话都不说？**
默认 `groupAtOnly: true`，只被 @ 才醒。想活跃点就：
```json
"wake": { "groupAtOnly": false, "probability": 0.1 }
```

**Q: 记忆会不会越存越大？**
`topics` 留最近 20 条，`traits` 40 条，`facts` 60 条，对话流 400 轮。
都是自动裁剪的。想留更久就传 `new Memory({ maxTopics: 100, maxTurns: 5000 })`。

**Q: 能接别的模型吗？**
`config.json` 里改 `baseUrl` 和 `model` 就行，只要那个接口是 OpenAI 格式。
DeepSeek / Kimi / 通义 / 本地 Ollama 都行。

**Q: 能接微信 / Telegram 吗？**
能。照着 `transport-onebot.js` 实现三个方法：
`send(key, text)`、`setTyping(key, on)`、消息进来时调 `onMessage(msg)`。
其它四层原样不动。

---

## 跑一下 demo

完全离线，不需要 key，不需要 QQ：

```bash
node examples/demo.js
```

会打印出记忆账本长什么样、一次拟人化发送的真实时间轴、以及六种场景下
它选择"醒"还是"装死"。

---

## License

MIT
