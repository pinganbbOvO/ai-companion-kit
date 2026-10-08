/**
 * 离线 demo · 不连 QQ，不用 API key
 * ─────────────────────────────────────────────────────────────
 * 跑一下就能看到三件事实际是怎么工作的：
 *
 *   node examples/demo.js
 *
 *   1. 记忆账本   —— 按人存，换会话还认识你
 *   2. 拟人化发送 —— 打字时长、分条、条间停顿
 *   3. 唤醒判定   —— 什么该理，什么该装死
 */
import { Memory, Humanizer, Waker } from '../src/lib.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const line = (s) => console.log('\n' + '─'.repeat(64) + '\n' + s + '\n' + '─'.repeat(64));
const ok = (s) => console.log('   ✓ ' + s);
const info = (s) => console.log('     ' + s);

// ═══════════════════════════════════════════════════════════════
line('① 记忆账本 · 按「人」存，不按「会话」存');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-demo-'));
const mem = new Memory({ dir: tmp });

// 模拟：同一个人先在私聊说话，后来又在群里说话
mem.remember('10001', { name: '老王', trait: '常熬夜', fact: '养了只叫豆豆的猫' });
mem.logTurn({ where: 'private:10001', who: '老王', text: '今天加班到两点', reply: '又熬，你这身体不要了' });

mem.remember('10001', { topic: '他说下周要出差' });
mem.logTurn({ where: 'group:555', who: '老王', text: '我回来了', reply: '哟，出差回来啦' });

info('同一个 QQ 号 10001，在私聊和群里各说过话。');
info('账本里是【同一本】：\n');
console.log(mem.renderPerson('10001'));

info('唤醒时把最近对话也带上（跨场合混在一起）：\n');
console.log(mem.renderRecent(10));

ok('换会话还认识他 —— 这就是「按人存」的意义');

// ═══════════════════════════════════════════════════════════════
line('② 拟人化发送 · 打字时长 / 分条 / 停顿');

const human = new Humanizer({ msPerChar: 85, minMs: 800, maxMs: 4000 });

const samples = [
  '在',
  '在呢，咋了',
  '刚在忙，没看手机。你说吧',
  '行，那我等你\n你慢点',
];
for (const s of samples) {
  info('「' + s.replace(/\n/g, ' / ') + '」  →  "正在输入" ' + human.typingMsFor(s) + 'ms');
}

info('');
info('一段长回复会被自动切成几条，条间还有停顿：');
const long = '刚看到消息。你那事我想了一下，感觉不用太急\n明天先问问再说吧\n我先去吃饭了';
const parts = human.split(long);
parts.forEach((p, i) => info('  第 ' + (i + 1) + ' 条：' + p));

info('');
info('实际"发"一次（用假的 clock，瞬间跑完）：');
const clock = [];
let t = 0;
const r = await human.say(long, {
  setTyping: async (on) => clock.push([t, on ? 'typing-on' : 'typing-off']),
  send: async (m) => clock.push([t, 'send: ' + m.slice(0, 16)]),
  sleep: async (ms) => { t += ms; },
});
for (const [at, what] of clock) info('  +' + String(at).padStart(6) + 'ms  ' + what);
ok('发出 ' + r.sent + ' 条，总耗时 ' + t + 'ms —— 不是"唰"一下全出来');

// ═══════════════════════════════════════════════════════════════
line('③ 唤醒判定 · 什么该理，什么该装死');

const waker = new Waker({
  names: ['小鱼', '小鲸鱼'],
  keywords: ['在吗'],
  ownerIds: ['10001'],
});
waker.setConfig('group:555', {
  mode: 'diving',
  atMention: true,
  nameMention: false,     // 群里只被 @ 才醒
  question: false,
  poke: true,
  probability: 0,
});

const cases = [
  { desc: '@ 了她',            msg: { key: 'group:555', userId: '20002', name: '小李', text: '@小鱼 在吗', isAtMe: true } },
  { desc: '叫了名字（群里=不醒）', msg: { key: 'group:555', userId: '20002', name: '小李', text: '小鱼去哪了' } },
  { desc: '主人说话',           msg: { key: 'group:555', userId: '10001', name: '老王', text: '都别吵' } },
  { desc: '别人闲聊',           msg: { key: 'group:555', userId: '20002', name: '小李', text: '今天中午吃啥' } },
  { desc: '别人拍了她',         msg: { key: 'group:555', userId: '20002', name: '小李', text: '[拍一拍]', isPoke: true } },
  { desc: '私聊（默认全理）',    msg: { key: 'private:10001', userId: '10001', name: '老王', text: '睡了吗' } },
];

// 私聊默认活跃
waker.setConfig('private:10001', { mode: 'active', anyMessage: true });

for (const c of cases) {
  const d = waker.shouldWake(c.msg);
  console.log('   ' + (d.wake ? '🔔 醒  ' : '🔇 静音') + '  ' + c.desc.padEnd(22) + (d.wake ? '（因为 ' + d.reason + '）' : ''));
}

ok('该理的时候理，该安静的时候安静 —— 这是"不烦人"的关键');

// ═══════════════════════════════════════════════════════════════
line('跑完了');

info('这个 demo 完全离线，没连 QQ 也没调模型。');
info('要看真效果，把 config.example.json 改成 config.json，填上 key 和 QQ 号就能跑。');
console.log('');

// 清理临时目录
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
