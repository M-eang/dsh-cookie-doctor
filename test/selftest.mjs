/** 离线自测：临时库上跑完整清理流程，不碰真库。 */
import { DatabaseSync } from 'node:sqlite'
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

process.env.LOCALAPPDATA = mkdtempSync(join(tmpdir(), 'cdoc-'))
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'cdoc-home-'))

const { purge } = await import('../lib/clean.js')

const dir = mkdtempSync(join(tmpdir(), 'cdoc-db-'))
const dbPath = join(dir, 'Cookies')
const db = new DatabaseSync(dbPath)
db.exec(`CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);
         INSERT INTO meta VALUES('version','24');
         CREATE TABLE cookies(creation_utc INTEGER, host_key TEXT, name TEXT, value TEXT,
           encrypted_value BLOB, path TEXT, expires_utc INTEGER, is_secure INTEGER,
           is_httponly INTEGER, last_access_utc INTEGER, has_expires INTEGER,
           is_persistent INTEGER, priority INTEGER, samesite INTEGER,
           source_scheme INTEGER, source_port INTEGER, is_monolithic INTEGER,
           has_cross_site_ancestor INTEGER);`)
const ins = db.prepare(`INSERT INTO cookies(creation_utc,host_key,name,value,encrypted_value,path,expires_utc,source_port)
                        VALUES(?,?,?,?,?,?,?,?)`)
for (let i = 0; i < 71; i += 1) {
  ins.run(13350000000000000 + i, '127.0.0.1', `dsh-auth-${String(i).padStart(43, '0')}`, '', Buffer.alloc(173, 1), '/', 13360000000000000, 50000 + i)
}
ins.run(13350000000000000, '127.0.0.1', 'keep-me', '', Buffer.from('x'), '/', 13360000000000000, 50000)
db.close()

const first = purge({ dbPath, keep: 1 })
console.log('第一次:', JSON.stringify(first))
assert.equal(first.status, 'ok', '首轮应清理成功')
assert.equal(first.removed, 70, '应删掉 70 条旧的')
assert.equal(first.kept, 1, '应保留最新 1 条')

const check = new DatabaseSync(dbPath)
const left = check.prepare("SELECT COUNT(*) AS n FROM cookies WHERE name LIKE 'dsh-auth-%'").get().n
const kept = check.prepare("SELECT COUNT(*) AS n FROM cookies WHERE name='keep-me'").get().n
const meta = check.prepare("SELECT value FROM meta WHERE key='version'").get().value
check.close()
assert.equal(left, 1, '剩余 dsh-auth-* 应为 1')
assert.equal(kept, 1, '无关 cookie 必须保留')
assert.equal(meta, '24', 'meta version 必须不变')

const second = purge({ dbPath, keep: 1 })
assert.equal(second.status, 'clean', '第二轮应判定无需清理')

const backups = readdirSync(join(process.env.LOCALAPPDATA, 'dsh-cookie-doctor')).filter((f) => f.endsWith('.bak'))
assert.ok(backups.length >= 1, '应生成备份')

rmSync(dir, { recursive: true, force: true })
console.log(`剩余 dsh-auth-*: ${left}  保留其它: ${kept}  meta: ${meta}  备份: ${backups.length} 个`)
console.log('SELFTEST PASS')
