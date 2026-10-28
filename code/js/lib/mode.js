/* ==========================================================================
   mode.js · 生日模式判断
   必须用浏览器本地时间。机房在英国，用服务器时间判断必然错位。
   窗口按「月-日」比较，因此每年到这个时候会自动再次触发。
   ========================================================================== */

import { config } from '../config.js';
import { pad2 } from './dom.js';

const MM_DD = (d) => `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

/** config.birthday 的兜底 —— isBirthdayMode 做了检查而下面几个函数原来没有，
    一旦有人删掉 config 里的 birthday 块，birthdayLabel() 会在 main/hero里
    直接抛错，整个启动被 boot().catch 吞成一句「页面加载出了点问题」。 */
const bday = () => config.birthday || {};

/** 当前是否处于生日叙事窗口内 */
export function isBirthdayMode(now = new Date()) {
  if (config.debug.forceBirthdayMode) return true;
  if (!config.birthday || config.birthday.month == null) return false;

  const today = MM_DD(now);
  const { windowFrom, windowTo } = config.birthday;
  if (!windowFrom || !windowTo) return false;

  /* ⚠️ 字符串比较只在窗口**不跨年**时成立。跨年时（12-20 → 01-10）
     today >= '12-20' && today <= '01-10' 恒为false，生日模式永远不触发，
     而且不报任何错。当前配置安全，但改配置的人不会知道会踩。 */
  if (windowFrom <= windowTo) return today >= windowFrom && today <= windowTo;
  // 跨年：拆成两段
  return today >= windowFrom || today <= windowTo;
}

/** 是否临近生日（用于窗口外显示手动入口） */
export function isNearBirthday(now = new Date(), days = 20) {
  const { month, day } = bday();
  if (month == null || day == null) return false;
  const year = now.getFullYear();
  const target = new Date(year, month - 1, day);
  if (target < now) target.setFullYear(year + 1);
  const diff = (target - now) / 86400000;
  return diff <= days;
}

/** 「生日当天，有个东西给你」这类手动入口是否该出现 */
export function shouldShowManualEntry(now = new Date()) {
  if (isBirthdayMode(now)) return false;
  if (!bday().manualEntryOutsideWindow) return false;
  return isNearBirthday(now);
}

/** 距离下一次生日还有多少天 */
export function daysUntilBirthday(now = new Date()) {
  const { month, day } = bday();
  if (month == null || day == null) return 0;
  const target = new Date(now.getFullYear(), month - 1, day);
  if (target < now) target.setFullYear(now.getFullYear() + 1);
  return Math.ceil((target - now) / 86400000);
}

/** 生日那天是几月几号，用于页脚展示 */
export function birthdayLabel() {
  const { month, day } = bday();
  if (month == null || day == null) return '';
  return `${month}.${day}`;
}
