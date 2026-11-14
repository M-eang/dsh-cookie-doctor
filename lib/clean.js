/**
 * cookie 库清理实现：只读名字 + 删除旧行，不碰其它 cookie。
 *
 * 保留策略是「按 creation_utc 保留最新 N 条」而不是「全删」：
 * 插件执行时当前会话那条可能已经写进库了，全删会让正在连着的 UI 立刻 401。
 */
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const COOKIE_PREFIX = 'dsh-auth-'
const MAX_BACKUPS = 5

function dshHome() {
  const fromEnv = process.env.DSH_HOME
  return typeof fromEnv === 'string' && fromEnv.trim() !== '' ? fromEnv.trim() : join(homedir(), '.dsh')
}

function dataDir() {
  return join(dshHome(), 'cookie-doctor')
}

export function log(line) {
  try {
    mkdirSync(dataDir(), { recursive: true })
    appendFileSync(join(dataDir(), 'doctor.log'), `[${new Date().toISOString()}] ${line}\n`, 'utf8')
  } catch { /* 记不下来也不影响主流程 */ }
}

/** Electron 壳的 userData 目录里放的就是 Chromium 的 cookie 库。 */
export function resolveCookieDb(config = {}) {
  const explicit = config.dbPath || process.env.DSH_COOKIE_DB
  if (typeof explicit === 'string' && explicit.trim() !== '') return explicit
  const appData = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming')
  return join(appData, '@deepseek-ai', 'dsh-desktop', 'Network', 'Cookies')
}

function backupPath(dbPath) {
  const dir = join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'dsh-cookie-doctor')
  mkdirSync(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
  return join(dir, `Cookies.${stamp}.bak`)
}

function pruneBackups() {
  try {
    const dir = join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'dsh-cookie-doctor')
    const files = readdirSync(dir).filter((f) => f.startsWith('Cookies.') && f.endsWith('.bak'))
      .map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t)
    for (const extra of files.slice(MAX_BACKUPS)) {
      rmSync(join(dir, extra.f), { force: true })
    }
  } catch { /* noop */ }
}

/**
 * 打开库并删掉除最新 keep 条以外的 dsh-auth-*。
 * 返回 { status, total, kept, removed, error }
 *   status: 'ok' | 'clean' | 'missing' | 'locked' | 'error'
 */
export function purge(config = {}) {
  const dbPath = resolveCookieDb(config)
  const keep = Number.isInteger(config.keep) ? Math.max(1, config.keep) : 1
  if (!existsSync(dbPath)) {
    return { status: 'missing', dbPath, total: 0, kept: 0, removed: 0 }
  }

  let db
  try {
    db = new DatabaseSync(dbPath, { timeout: 300 })
  } catch (error) {
    return {
      status: 'locked',
      dbPath,
      total: 0,
      kept: 0,
      removed: 0,
      error: String(error?.message ?? error),
    }
  }

  try {
    // creation_utc 是 1601 起的微秒数（约 1.3e16），超过 JS 安全整数范围，
    // 取回 JS 会直接抛 "Value is too large" —— 所以排序与偏移全部交给 SQLite，
    // 只把 rowid 这种小整数取出来。
    const total = db.prepare(
      `SELECT COUNT(*) AS n FROM cookies WHERE name LIKE ?`,
    ).get(`${COOKIE_PREFIX}%`).n
    if (total <= keep) {
      db.close()
      return { status: 'clean', dbPath, total, kept: total, removed: 0 }
    }

    if (config.backup !== false) {
      try {
        copyFileSync(dbPath, backupPath(dbPath))
        pruneBackups()
      } catch (error) {
        log(`backup failed: ${error?.message ?? error}`)
      }
    }

    const doomed = db.prepare(
      `SELECT rowid AS rid FROM cookies WHERE name LIKE ? ORDER BY creation_utc DESC LIMIT -1 OFFSET ?`,
    ).all(`${COOKIE_PREFIX}%`, keep)
    db.exec('BEGIN IMMEDIATE')
    const stmt = db.prepare('DELETE FROM cookies WHERE rowid = ?')
    for (const row of doomed) stmt.run(row.rid)
    db.exec('COMMIT')

    let integrity = 'unknown'
    try {
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
      const row = db.prepare('PRAGMA integrity_check').get()
      integrity = String(row?.integrity_check ?? Object.values(row ?? {})[0] ?? 'ok')
    } catch { /* checkpoint 失败不影响删除结果 */ }

    db.close()
    return { status: 'ok', dbPath, total, kept: total - doomed.length, removed: doomed.length, integrity }
  } catch (error) {
    try { db.close() } catch { /* noop */ }
    return {
      status: 'error',
      dbPath,
      total: 0,
      kept: 0,
      removed: 0,
      error: String(error?.message ?? error),
    }
  }
}

export function run(config = {}) {
  const started = Date.now()
  const result = purge(config)
  const ms = Date.now() - started
  let summary
  switch (result.status) {
    case 'ok':
      summary = `已清理 ${result.removed} 条旧 ${COOKIE_PREFIX}*（保留 ${result.kept} 条），${ms}ms，integrity=${result.integrity ?? 'n/a'}`
      break
    case 'clean':
      summary = `${COOKIE_PREFIX}* 仅 ${result.kept} 条，无需清理`
      break
    case 'missing':
      summary = `cookie 库不存在：${result.dbPath}`
      break
    case 'locked':
      summary = `cookie 库被占用，跳过清理（${result.error}）`
      break
    default:
      summary = `清理失败：${result.error}`
  }
  log(`${result.status} | ${summary} | ${result.dbPath}`)
  return { ...result, summary, ms, silent: Boolean(config.silent) }
}
