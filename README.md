# dsh-cookie-doctor

DSH 插件。每次启动时把 Chromium cookie 库里累积的 `dsh-auth-*` 清掉，只保留最新一条 —— 不用记命令，不用记得重启前跑脚本。

## 它解决什么

DSH 每次启动随机生成 launch token，并向 `127.0.0.1` 写一条 `dsh-auth-<sha256(host:port)>`：

- 名字里带端口 ⇒ host 每次换端口就多出一条新 cookie，旧的再也不会被用到，也永远不会被清理；
- Chromium 把同域 cookie 整批发出去 ⇒ 约 70 条时请求头撞到 Node http server 的 `maxHeaderSize = 16384`，Host 返回 431；
- Electron 壳把 431 当成了认证失败，于是弹窗 `desktop welcome: Web authentication failed`。

旧 cookie 清掉没有任何副作用：token 每个进程重新随机，旧值 100% 匹配不上。

## 功能

装好之后没有界面，也不需要操作：

- 每次 DSH 启动时尝试清理一次，保留最新 `keep` 条；
- 删之前备份到 `%LOCALAPPDATA%\dsh-cookie-doctor\Cookies.<时间戳>.bak`，保留最近 5 份；
- 每一步结果写进 `%DSH_HOME%\cookie-doctor\doctor.log`，包括"库被占用"这种失败原因；
- 任何异常都吞掉，只记日志 —— 清理动作绝不会让 DSH 起不来。

## 目录结构

```
dsh-cookie-doctor/
├── index.js           宿主插件入口（name / apply）
├── lib/clean.js       清理实现：定位库 → 备份 → 删旧留新 → checkpoint → 校验
├── cordis.patch.yml   bundle patch（insert 一条 cookie-doctor 行）
├── test/selftest.mjs  离线自测：临时库上跑完整流程
├── test/probe.mjs     手动探针：当前进程里跑一次，看库是否可写
└── package.json
```

## 安装

已经装进 `profiles\desktop`：`node_modules\dsh-cookie-doctor` 是指向本目录的目录联结，`profiles\desktop\cordis.patch.yml` 末尾多了一条 `- insert:` 行。重启 DSH 生效。

手动安装同样的两步：

1. `node_modules\dsh-cookie-doctor` 指向本目录（junction 或 symlink）；
2. `cordis.patch.yml` 追加：

```yaml
- insert:
    - id: cookie-doctor
      name: dsh-cookie-doctor
```

卸载：删掉那条 insert 行即可，插件不注册任何服务。

## 配置

在 `cordis.patch.yml` 里给这一行加 `config`：

```yaml
- insert:
    - id: cookie-doctor
      name: dsh-cookie-doctor
      config:
        keep: 1
        backup: true
        dbPath: C:\Users\you\AppData\Roaming\@deepseek-ai\dsh-desktop\Network\Cookies
```

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `keep` | `1` | 保留最新几条，最小 1 |
| `backup` | `true` | 删之前是否备份 |
| `dbPath` | Electron 壳的 userData 下的 `Network\Cookies` | 换目录部署时用 |
| `silent` | `false` | 不往宿主 logger 打摘要 |

`dbPath` 也可以用环境变量 `DSH_COOKIE_DB` 覆盖。

## 自测

```
node test/selftest.mjs
```

在临时目录建同构 schema（71 条 `dsh-auth-*` + 1 条无关 cookie），跑完整清理并断言：删 70 留 1、无关 cookie 保留、`meta.version` 不变、生成备份、第二轮判定 `clean`。预期输出 `SELFTEST PASS`。

```
node test/probe.mjs
```

在 DSH 运行中执行会返回 `status: "locked"`，这是正常的：Chromium 的 NetworkService 独占 cookie 库，只有启动早期窗口内才可写。

## 实测

2026-10-27 20:48 首次带插件启动，日志：

```
ok | 已清理 2 条旧 dsh-auth-*（保留 1 条），14ms，integrity=ok
```

启动早期（NetworkService 还没打开 cookie 库）确实可写，14ms 完成。之后每次启动都是 `N → 1`，条数不再累积，也就不会再撞 16 KB。

## 失败了怎么办

日志里如果出现 `locked`，说明那次没抢到窗口（连带约 1.4s 启动开销）。DSH 本身不受影响，只是那次没清。完全退出 DSH（等窗口关掉、端口释放）再启动一次，通常就恢复正常。若连续多次 `locked`，说明有别的进程长期占着 `Network\Cookies`，查一下安全软件或残留的 `DeepSeek Harness.exe` 进程；`%LOCALAPPDATA%\dsh-cookie-doctor\` 里有自动备份，可直接还原。
