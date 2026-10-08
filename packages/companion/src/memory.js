/**
 * 记忆账本 · 按「人」存，而不是按「会话」存
 * ─────────────────────────────────────────────────────────────
 * 大多数聊天机器人把记忆按会话存：私聊一份、群聊一份、不同群各一份。
 * 结果就是同一个人换了地方，AI 就"不认识"他了。
 *
 * 这里换一种做法：**所有记忆都挂在人身上**（用 QQ 号当 key）。
 * 不管他出现在私聊、群 A 还是群 B，读写的都是同一本账。
 *
 * 账本里存什么：
 *   traits        你了解他的性格/习惯     "常熬夜" "嘴上嫌我笨其实一直给我加功能"
 *   facts         他告诉过你的事实         "他的 QQ 是 123456"
 *   topics        你们聊过的话题（滚动）   "凌晨他说通了"
 *   pending       他心里还没说出口的事
 *   interactions  互动过多少次
 *   firstSeenAt / lastSeenAt
 *
 * 另外还有一个「共享对话流」：把各个场合的真实一来一回按时间排成一条线。
 * 唤醒时把最近 N 条喂给模型，它就知道"刚才在别处发生了什么"。
 */
import fs from 'node:fs';
import path from 'node:path';

export class Memory {
  /**
   * @param {object} opts
   * @param {string} opts.dir            数据目录
   * @param {number} [opts.maxTopics]    每人最多留多少条话题
   * @param {number} [opts.maxTurns]     共享对话流最多留多少条
   */
  constructor({ dir, maxTopics = 20, maxTurns = 400 } = {}) {
    this.dir = dir;
    this.peopleFile = path.join(dir, 'people.json');
    this.turnsFile = path.join(dir, 'turns.jsonl');
    this.maxTopics = maxTopics;
    this.maxTurns = maxTurns;
    fs.mkdirSync(dir, { recursive: true });
  }

  // ── 底层读写 ────────────────────────────────────────────────
  #readAll() {
    try { return JSON.parse(fs.readFileSync(this.peopleFile, 'utf8')); } catch { return {}; }
  }
  #writeAll(j) {
    fs.writeFileSync(this.peopleFile, JSON.stringify(j, null, 2), 'utf8');
  }

  /** 取某个人的账（不存在就建） */
  person(id, { name } = {}) {
    const all = this.#readAll();
    const key = String(id);
    if (!all[key]) {
      all[key] = {
        name: name || key,
        traits: [], facts: [], topics: [], pending: [],
        interactions: 0,
        firstSeenAt: Date.now(),
        lastSeenAt: Date.now(),
      };
      this.#writeAll(all);
    }
    const p = all[key];
    // 补字段（老数据兼容）
    for (const k of ['traits', 'facts', 'topics', 'pending']) if (!Array.isArray(p[k])) p[k] = [];
    if (name && p.name !== name) { p.name = name; this.#writeAll(all); }
    return p;
  }

  /** 往某人账上写一条 */
  remember(id, { trait, fact, topic, pending, name } = {}) {
    const all = this.#readAll();
    const key = String(id);
    if (!all[key]) {
      all[key] = { name: name || key, traits: [], facts: [], topics: [], pending: [], interactions: 0, firstSeenAt: Date.now(), lastSeenAt: Date.now() };
    }
    const p = all[key];
    for (const k of ['traits', 'facts', 'topics', 'pending']) if (!Array.isArray(p[k])) p[k] = [];
    if (name) p.name = String(name).slice(0, 40);

    const put = (arr, v) => {
      const s = String(v || '').replace(/\s+/g, ' ').trim().slice(0, 160);
      if (!s) return;
      const i = arr.indexOf(s);
      if (i >= 0) arr.splice(i, 1);      // 提过的挪到最新
      arr.push(s);
    };

    if (trait) put(p.traits, trait);
    if (fact) put(p.facts, fact);
    if (topic) put(p.topics, topic);
    if (pending) put(p.pending, pending);

    while (p.topics.length > this.maxTopics) p.topics.shift();
    while (p.traits.length > 40) p.traits.shift();
    while (p.facts.length > 60) p.facts.shift();
    while (p.pending.length > 12) p.pending.shift();

    p.lastSeenAt = Date.now();
    p.interactions = (Number(p.interactions) || 0) + 1;
    this.#writeAll(all);
    return p;
  }

  /** 记一次互动（不加内容，只涨计数） */
  touch(id, { name } = {}) {
    const all = this.#readAll();
    const key = String(id);
    if (!all[key]) return this.remember(key, { name });
    all[key].lastSeenAt = Date.now();
    all[key].interactions = (Number(all[key].interactions) || 0) + 1;
    if (name) all[key].name = String(name).slice(0, 40);
    this.#writeAll(all);
  }

  // ── 共享对话流 ──────────────────────────────────────────────
  /**
   * 记一轮对话。where 用来说明发生在哪（'private' / 'group:123' / 任意标记）
   */
  logTurn({ where, who, text, reply }) {
    const rec = {
      t: Date.now(),
      where: String(where || ''),
      who: String(who || '').slice(0, 30),
      text: String(text || '').replace(/\s+/g, ' ').trim().slice(0, 300),
      reply: String(reply || '').replace(/\s+/g, ' ').trim().slice(0, 300),
    };
    if (!rec.text && !rec.reply) return;
    try {
      fs.appendFileSync(this.turnsFile, JSON.stringify(rec) + '\n', 'utf8');
      // 太长就裁
      const lines = fs.readFileSync(this.turnsFile, 'utf8').trim().split('\n');
      if (lines.length > this.maxTurns) {
        fs.writeFileSync(this.turnsFile, lines.slice(-this.maxTurns).join('\n') + '\n', 'utf8');
      }
    } catch { /* 写失败不影响主流程 */ }
  }

  /** 取最近 n 轮（可按来源过滤） */
  recentTurns(n = 20, { excludeWhere, sinceMs } = {}) {
    let rows = [];
    try {
      rows = fs.readFileSync(this.turnsFile, 'utf8').trim().split('\n')
        .map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .filter(Boolean);
    } catch { return []; }
    if (sinceMs) rows = rows.filter((r) => Date.now() - r.t < sinceMs);
    if (excludeWhere) rows = rows.filter((r) => !String(r.where || '').startsWith(excludeWhere));
    return rows.slice(-n);
  }

  // ── 给提示词用 ──────────────────────────────────────────────
  /** 把某人的账渲染成一段可注入的文字 */
  renderPerson(id) {
    const p = this.#readAll()[String(id)];
    if (!p) return '';
    const L = [];
    if (p.traits?.length) L.push('你了解他：' + p.traits.slice(-12).join('；'));
    if (p.facts?.length) L.push('他告诉过你：' + p.facts.slice(-12).join('；'));
    if (p.topics?.length) L.push('你们聊过：' + p.topics.slice(-8).join('；'));
    if (p.pending?.length) L.push('⚠️ 你心里还记着没说出口的事：' + p.pending.slice(-4).join('；'));
    if (p.interactions) L.push('你们互动过 ' + p.interactions + ' 次');
    if (!L.length) return '';
    return '【关于 ' + (p.name || id) + '（' + id + '）的一本账】\n' + L.join('\n') + '\n';
  }

  /** 把最近对话渲染成一段可注入的文字 */
  renderRecent(n = 20, opts = {}) {
    const rows = this.recentTurns(n, opts);
    if (!rows.length) return '';
    const lines = rows.map((r) => {
      const when = new Date(r.t).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
      const place = r.where.startsWith('group') ? '群里' : '私聊';
      const parts = [];
      if (r.text) parts.push(r.who + '（' + place + '）：' + r.text);
      if (r.reply) parts.push('你：' + r.reply);
      return '  ' + when + '  ' + parts.join('\n        ');
    });
    return '【最近的真实对话（跨场合合在一起）】\n' + lines.join('\n')
      + '\n（这些是真说过的，别装作不知道，也别生硬复述）\n';
  }

  /** 导出（调试/备份用） */
  dump() {
    return { people: this.#readAll(), turns: this.recentTurns(1e9) };
  }
}
