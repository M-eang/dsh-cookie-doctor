/**
 * dsh-cookie-doctor — 宿主半边：DSH 每次启动时清掉 Chromium cookie 库里残留的
 * dsh-auth-* 行，只保留最新的一条。
 *
 * 为什么有效：dsh-auth-<sha256(host:port)> 这条 cookie 的名字随端口变化，
 * 旧的永远不会再被使用，也永远不会被清理；同域全部 cookie 会被一起发出去，
 * 约 70 条就撞到 Node http server 的 maxHeaderSize=16384 → 431。
 *
 * 本插件不声明 inject，让 cordis 在最早阶段 apply —— 必须抢在 Electron 壳
 * 为 welcome 首次访问 cookie 库之前执行，否则库会被 NetworkService 独占。
 */
import { run } from './lib/clean.js'

export const name = 'cookie-doctor'

export function apply(ctx, config = {}) {
  // 任何失败都只记日志：绝不能因为清理动作让 DSH 起不来。
  try {
    const result = run(config)
    if (!result.silent) {
      ctx?.logger?.('cookie-doctor')?.info?.(result.summary)
    }
  } catch (error) {
    try {
      console.error('[cookie-doctor]', error?.message ?? error)
    } catch { /* noop */ }
  }
}

export default { name, apply }
