/**
 * companion · 库入口
 * ─────────────────────────────────────────────────────────────
 * 不跑服务，只想拿零件自己拼的时候用这个。
 *
 *   import { Memory, Role, Brain, Humanizer, Waker } from 'ai-companion';
 *
 *   const memory = new Memory({ dir: './data' });        // 记忆账本
 *   const role   = new Role({ cardPath: './role.md' });  // 角色卡
 *   const brain  = new Brain({ apiKey, role, memory });  // 大脑
 *   const human  = new Humanizer();                      // 拟人化发送
 *   const waker  = new Waker({ names: ['小鱼'] });        // 唤醒判定
 *
 * 也可以只要一样：
 *
 *   // 只想要"像人一样分条发送"
 *   const human = new Humanizer({ msPerChar: 90 });
 *   await human.say('在呢，咋了', {
 *     setTyping: (on) => platform.setTyping(chatId, on),
 *     send: (t) => platform.send(chatId, t),
 *   });
 *
 *   // 只想要"按人存记忆"
 *   const mem = new Memory({ dir: './data' });
 *   mem.remember('123456', { trait: '常熬夜', fact: '他养了只猫' });
 *   console.log(mem.renderPerson('123456'));
 *
 *   // 只想要"该不该说话"
 *   const waker = new Waker();
 *   waker.shouldWake({ key: 'group:1', userId: '9', text: '@小鱼 在吗', isAtMe: true });
 */
export { Memory } from './memory.js';
export { Role } from './role.js';
export { Brain } from './brain.js';
export { Humanizer } from './humanize.js';
export { Waker } from './wake.js';
export { OneBot, segsToText } from './transport-onebot.js';
export { loadConfig, handleTurn } from './index.js';
