/**
 * 主动消息
 *
 * 微信 iLink 的硬限制：发送需要 context_token，而它来自用户发的消息。
 * 实测空 token 也能发出去（服务端会分配 message_id），但这条路上没有
 * 官方保证——所以这里做得保守，并且把"发送窗口"当成一等的概念来处理：
 *
 *   用户说完话之后的几分钟内，主动消息还能发出去；
 *   超过这个窗口，服务端一律返回 ret=-2（prepare failed）。
 *
 * 计时用三个独立的时间戳，绝对不能混用：
 *   lastUserSpokeAt  —— 只由「用户真的说话了」更新。判断静默够不够久、窗口还在不在。
 *   lastProactiveAt  —— 只由「我们成功发出去一条」更新。判断冷却够不够。
 *   nextDueAt        —— 下一次允许发送的时刻（带随机抖动）。
 *
 * 曾经踩过的坑：把发送成功也写进 lastSeenAt，等于每发一条就把"静默计时"清零，
 * 结果实际间隔 = idleBeforeMs + gap，配 5-10 分钟就变成了 10-15 分钟，
 * 看起来像"频率怎么调都很低"。这三个戳分开之后，间隔才真正等于配置值。
 */
import { setTimeout as delay } from 'node:timers/promises';

/** 每个用户的状态 */
const userState = new Map();

function state(userId) {
  const s = userState.get(userId) || {
    lastUserSpokeAt: 0,
    lastProactiveAt: 0,
    nextDueAt: 0,
    silentStreak: 0,
    windowClosed: false,
    failStreak: 0
  };
  userState.set(userId, s);
  return s;
}

/**
 * 记录一次用户活动。
 * @param {string} userId
 * @param {{userSpoke?:boolean, windowMs?:number}} meta
 *   userSpoke=true 时：刷新 lastUserSpokeAt、清零沉默计数、重新打开发送窗口
 */
export function touchUser(userId, meta = {}) {
  const s = state(userId);
  const now = Date.now();

  if (meta.userSpoke) {
    s.lastUserSpokeAt = now;
    s.silentStreak = 0;
    s.windowClosed = false;
    s.failStreak = 0;
    // 用户刚说完话，如果当前没在冷却里，可以很快就开始主动搭话
    if (!s.nextDueAt || s.nextDueAt > now) s.nextDueAt = now;
  } else if (!s.lastUserSpokeAt) {
    // 没有 userSpoke 的调用只用于初始化；不覆盖已有时间戳
    s.lastUserSpokeAt = now;
  }

  userState.set(userId, s);
  return s;
}

/** 主动发了一次，沉默计数 +1（不改 lastUserSpokeAt！） */
export function bumpSilentStreak(userId) {
  const s = state(userId);
  s.silentStreak = (s.silentStreak || 0) + 1;
  return s.silentStreak;
}

/** 标记发送窗口已关闭（服务端拒绝），直到用户再说话才重开 */
export function closeWindow(userId) {
  const s = state(userId);
  s.windowClosed = true;
}

export function getUserState(userId) {
  return userState.get(userId);
}

export function getAllUsers() {
  return [...userState.entries()].map(([id, s]) => ({ userId: id, ...s }));
}

/**
 * 主动消息调度器。
 *
 * 两档：
 *   普通档 —— 用户静默够久、冷却到期，发一条
 *   升级档 —— 连发 burstAfter 次都没回应，一次性连发 burstCount 条
 *
 * 调度用固定短周期轮询（tickEveryMs），不是"睡完一个 gap 再醒"。
 * 原因：gap 是每用户独立的随机值，而且是"上次发送之后"才算的；
 * 用一个全局长睡眠会让精度全部丢失。短周期 + 每用户 nextDueAt 才准。
 *
 * @param opts
 *   - enabled
 *   - minGapMs / maxGapMs: 两次主动消息之间的随机间隔（每用户独立抽）
 *   - idleBeforeMs: 用户静默多久之后才开始搭话
 *   - contextTtlMs: 用户最后一次说话之后多久，发送窗口就当作已关（不再尝试）
 *   - tickEveryMs: 轮询周期，默认 15 秒
 *   - burstAfter / burstCount / burstGapMs
 *   - send: async (userId, text) => boolean
 *   - compose: async (userId, user, info) => string | string[]
 *   - log / warn
 */
export function createProactiveScheduler(opts) {
  const {
    enabled = false,
    minGapMs = 60 * 1000,
    maxGapMs = 180 * 1000,
    idleBeforeMs = 60 * 1000,
    contextTtlMs = 30 * 60 * 1000,
    tickEveryMs = 15 * 1000,
    burstAfter = 3,
    burstAfterIdleMs = 5 * 60 * 1000,
    burstCount = 5,
    burstMinCount = 3,
    burstMaxCount = 5,
    burstGapMs = 2500,
    // 忙碌模式
    busyGapMs = 25 * 60 * 1000,
    busyMinCount = 2,
    busyMaxCount = 3,
    busyBurstGapMs = 1500,
    getBusy = null,
    keepAlive = null,
    recordProbe = null,
    // 发送失败不再一次就判死：真实的窗口比想象的长得多（探针里有 idle 28 分钟仍成功的样本），
    // 一次"prepare failed"更可能是瞬时抖动。连续失败到上限才停手，否则等 retryDelayMs 再试。
    retryDelayMs = 60 * 1000,
    maxFailStreak = 3,
    // 一批消息发完后的收尾钩子（用来补发"她顺手拍的那张图"）。
    afterSend = null,
    // 普通档一次发几条。给 null 时按 1 条（老行为）。
    // 用户要的是"1-3 条为主，偶尔 2-6 条"，所以由 index.js 传一个带权重的取数函数。
    wantCountFn = null,
    send,
    compose,
    log = () => {},
    warn = () => {}
  } = opts;

  let timer = null;
  let stopped = false;
  let running = false;

  function nextGap() {
    const lo = Math.max(1000, minGapMs);
    const hi = Math.max(lo, maxGapMs);
    return Math.round(lo + Math.random() * (hi - lo));
  }

  /** 在 [min, max] 里随机取一个整数 */
  function pickCount(min, max) {
    const lo = Math.max(1, min);
    const hi = Math.max(lo, max);
    return lo + Math.floor(Math.random() * (hi - lo + 1));
  }

  /** 连发条数在 [burstMinCount, burstMaxCount] 里随机取 */
  function pickBurstCount() {
    return pickCount(burstMinCount, burstMaxCount);
  }

  async function tick() {
    if (stopped || running) return;
    running = true;
    try {
      const now = Date.now();

      for (const user of getAllUsers()) {
        const { userId, lastUserSpokeAt = 0, silentStreak = 0, nextDueAt = 0, windowClosed = false } = user;

        if (!lastUserSpokeAt) continue;
        if (userId.includes('test')) continue;          // 跳过自测账号
        if (windowClosed) continue;                      // 发不出去，等用户再说话

        const idleMs = now - lastUserSpokeAt;
        const busy = !!(getBusy && getBusy(userId));

        // ── 忙碌模式 ────────────────────────────────────────────────────────
        //
        // 用户在忙/要离开：改成每 busyGapMs（默认 25 分钟）发 2-3 条，
        // 内容由 compose 侧切成"不打扰型"，并且不再提问。
        //
        // 到期时刻直接由时间戳推导，不用 nextDueAt —— 这样切进忙碌模式时
        // 不需要额外去改调度器内部状态，天然就是"说忙之后 25 分钟发第一条"。
        if (busy) {
          const base = Math.max(lastUserSpokeAt, user.lastProactiveAt || 0);
          if (now - base < busyGapMs) continue;

          const wantBusy = pickCount(busyMinCount, busyMaxCount);

          // 发送前先"续期"一次（默认是 getconfig + 一闪而过的输入状态）。
          // 目的只有一个：试探这个动作能不能延长发送窗口。
          // 成功与否都会记录，攒够样本就能测出真实窗口有多长。
          if (keepAlive) {
            try { await keepAlive(userId); } catch { /* 续期失败不影响发送尝试 */ }
          }

          const rawBusy = await compose(userId, user, {
            streak: silentStreak,
            escalate: false,
            busy: true,
            idleMinutes: Math.round(idleMs / 60000),
            wantCount: wantBusy
          });

          if (!rawBusy) continue;

          const busyTexts = (Array.isArray(rawBusy) ? rawBusy : [rawBusy])
            .map((t) => String(t || '').trim())
            .filter(Boolean)
            .slice(0, wantBusy);

          if (!busyTexts.length) continue;

          let busySent = 0;
          for (let i = 0; i < busyTexts.length; i++) {
            if (i > 0) {
              const j = busyBurstGapMs * 0.2 * (Math.random() * 2 - 1);
              await new Promise((r) => setTimeout(r, Math.max(600, Math.round(busyBurstGapMs + j))));
            }
            const ok = await send(userId, busyTexts[i]);
            if (ok) busySent++;
            else break;
          }

          const idleMinutes = Math.round(idleMs / 60000);
          if (busySent > 0) {
            bumpSilentStreak(userId);
            const s = state(userId);
            s.failStreak = 0;
            userState.set(userId, s);
            log(`[忙碌] 主动消息已发送 → ${userId}（${busySent}/${busyTexts.length} 条，沉默 ${idleMinutes} 分钟）`);
            if (recordProbe) recordProbe({ mode: 'busy', idleMinutes, sent: busySent, total: busyTexts.length, ok: true });
          } else {
            const s = state(userId);
            s.failStreak = (s.failStreak || 0) + 1;
            // 忙碌档不看 nextDueAt，靠 lastProactiveAt 推下一次；这里把它往前提，等于 retryDelayMs 后重试
            s.lastProactiveAt = Date.now() - busyGapMs + Math.min(busyGapMs, retryDelayMs);
            userState.set(userId, s);
            warn(`[忙碌] 主动消息没发出去（连续 ${s.failStreak}/${maxFailStreak} 次），${Math.round(Math.min(busyGapMs, retryDelayMs) / 1000)} 秒后重试`);
            if (recordProbe) recordProbe({ mode: 'busy', idleMinutes, sent: 0, total: busyTexts.length, ok: false });
          }
          continue;
        }

        // ── 普通模式 ────────────────────────────────────────────────────────

        // 用户还在活跃聊天中，别插嘴
        if (now - lastUserSpokeAt < idleBeforeMs) continue;

        // 距用户最后一次说话太久，发送窗口基本已关，别浪费请求
        if (now - lastUserSpokeAt > contextTtlMs) continue;

        // 冷却没到
        if (now < nextDueAt) continue;

        // 两条触发连发的路：
        //   ① 时间：用户沉默超过 burstAfterIdleMs（默认 5 分钟）→ 立刻连发 3-5 条
        //   ② 次数：已经主动找过 burstAfter 次都没回应 → 也连发（越等越急）
        const escalateByIdle = idleMs >= burstAfterIdleMs;
        const escalateByStreak = silentStreak >= burstAfter;
        const escalate = escalateByIdle || escalateByStreak;

        // 连发条数：升级档走 burst 区间；普通档也允许 1-3 条（偶尔 2-6 条），
        // 因为用户要的是"她一口气发好几句"，而不是每条都精确一条。
        const wantCount = escalate ? pickBurstCount() : (wantCountFn ? wantCountFn() : 1);

        const raw = await compose(userId, user, {
          streak: silentStreak,
          escalate,
          escalateByIdle,
          idleMinutes: Math.round(idleMs / 60000),
          wantCount
        });

        if (!raw) {
          // 生成失败：往回退一点，别每 15 秒重试一次烧 token
          const s = state(userId);
          s.nextDueAt = Date.now() + Math.max(30_000, nextGap());
          continue;
        }

        const texts = (Array.isArray(raw) ? raw : [raw])
          .map((t) => String(t || '').trim())
          .filter(Boolean)
          .slice(0, wantCount);

        if (!texts.length) continue;

        let sentCount = 0;
        for (let i = 0; i < texts.length; i++) {
          if (i > 0) {
            const jitter = burstGapMs * 0.3 * (Math.random() * 2 - 1);
            await new Promise((r) => setTimeout(r, Math.max(600, Math.round(burstGapMs + jitter))));
          }
          const ok = await send(userId, texts[i]);
          if (ok) sentCount++;
          else break;
        }

        if (sentCount > 0) {
          const s = state(userId);
          s.lastProactiveAt = Date.now();
          s.nextDueAt = Date.now() + nextGap();
          s.failStreak = 0;
          userState.set(userId, s);
          const streak = bumpSilentStreak(userId);
          log(`主动消息已发送 → ${userId}（${sentCount}/${texts.length} 条，沉默计数 ${streak}${escalate ? '，升级连发' : ''}，下次约 ${Math.round((s.nextDueAt - Date.now()) / 1000)} 秒后）`);
          if (recordProbe) {
            recordProbe({ mode: 'normal', idleMinutes: Math.round(idleMs / 60000), sent: sentCount, total: texts.length, ok: true });
          }
          // 文字发出去了才补图。放在这里而不是 before，是因为 sender 里已经等过一批
          // 打字延迟，图再生成十几秒也不会显得"半天不说话"，顺序反而自然。
          if (afterSend) {
            try {
              await afterSend(userId);
            } catch (e) {
              warn(`afterSend 钩子失败: ${e.message}`);
            }
          }
        } else {
          // 一条都没发出去。先别判死刑 —— 探针数据里同一批失败之后仍能成功。
          const s = state(userId);
          s.failStreak = (s.failStreak || 0) + 1;
          const idleMinutes = Math.round(idleMs / 60000);
          if (recordProbe) {
            recordProbe({ mode: 'normal', idleMinutes, sent: 0, total: texts.length, ok: false });
          }
          if (s.failStreak >= maxFailStreak) {
            closeWindow(userId);
            warn(`主动消息连续 ${s.failStreak} 次一条都没发出去，判定发送窗口已关闭 → ${userId}（用户再说句话就会重新开始）`);
          } else {
            s.nextDueAt = Date.now() + retryDelayMs;
            userState.set(userId, s);
            warn(`主动消息发送失败（连续 ${s.failStreak}/${maxFailStreak} 次），${Math.round(retryDelayMs / 1000)} 秒后重试 → ${userId}`);
          }
        }
      }
    } catch (e) {
      warn('主动消息调度出错: ' + e.message);
    } finally {
      running = false;
    }
  }

  function schedule() {
    if (stopped) return;
    timer = setTimeout(async () => {
      await tick();
      schedule();
    }, Math.max(3000, tickEveryMs));
    if (timer.unref) timer.unref();
  }

  return {
    start() {
      if (!enabled) {
        log('主动消息：未启用');
        return;
      }
      stopped = false;
      log(`主动消息：已启用（间隔 ${Math.round(minGapMs / 1000)}-${Math.round(maxGapMs / 1000)} 秒，静默 ${Math.round(idleBeforeMs / 1000)} 秒后开始搭话，沉默满 ${Math.round(burstAfterIdleMs / 60000)} 分钟连发 ${burstMinCount}-${burstMaxCount} 条（间隔 ${Math.round(burstGapMs / 100) / 10} 秒），窗口 ${Math.round(contextTtlMs / 60000)} 分钟）`);
      log(`  忙碌模式：每 ${Math.round(busyGapMs / 60000)} 分钟发 ${busyMinCount}-${busyMaxCount} 条（间隔 ${Math.round(busyBurstGapMs / 100) / 10} 秒），不连发不提问${keepAlive ? '，发送前尝试续期' : ''}`);
      log(`  场景延续：优先接着说手头那件事，不到冷却时间不主动开新话题`);
      schedule();
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
    /** 手动触发一次（调试用） */
    async triggerNow() {
      await tick();
    }
  };
}

export { delay };
