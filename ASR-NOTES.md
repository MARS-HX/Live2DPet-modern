# 离线语音识别 — 实现笔记

本文记录为实现「完全离线的本地语音识别」而**实测**出来的约束。
每一条都是探针跑出来的结果，不是推测；踩过的坑写在这里，避免重复排查。

---

## 已确认的事实（实测）

### 1. Electron 自带的 Web Speech 识别**不可用**

`webkitSpeechRecognition` / `SpeechRecognition` **存在**（`typeof === 'function'`），
但 Chromium 的语音识别是**云端服务**，Electron 不附带 Google 的 API key。
调用 `start()` 必然以 `network` / `service-not-allowed` 失败。

→ 因此本项目改为**完全离线**方案，不再依赖该系统 API。

### 2. 识别页面必须「跨域隔离」，否则 `vosk-browser` 静默挂起

| API | 普通页面 | 加 COOP/COEP 后 |
|-----|---------|----------------|
| `SharedArrayBuffer` | `undefined` | `function` |
| `crossOriginIsolated` | `false` | `true` |
| `isSecureContext` | `false`（`data:`/`file:` 不稳） | `true`（回环 http） |

`vosk-browser` 的 worker 把模型和音频环形缓冲放在 `SharedArrayBuffer` 里，
SAB 缺失时 **`createModel()` 既不 resolve 也不 reject** —— 表现为无限挂起，没有任何报错。

所以识别页面由**回环 HTTP 服务**提供，并带：

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
Cross-Origin-Resource-Policy: same-origin
```

顺带解决了麦克风权限问题：`127.0.0.1` 本身就是安全上下文。

### 3. 引擎只吃**未压缩 tar 的 gzip 包**，不是目录、不是 zip

- 传**目录 URL** → 直接 404（它要的是归档文件）
- 库源码里 `tar` 出现 89 次，`gzip` / `DecompressionStream` / `pako` 均为 0
- 但运行时日志显示它把下载物命名为 **`downloaded.tar.gz`**

→ 实际做法：把已安装的模型文件在本地打成 tar，再 gzip（65.1 MB → 42.2 MB）。
`src/main/tar-writer.js` 负责 tar；测试用**系统自带的 tar 真正解包**来验证，
而不是拿自己的假设当标准。

### 4. 引擎会把模型缓存进 Emscripten 持久化存储

日志（`logLevel=3`）：

```
Setting up persistent storage at /vosk
File system synced from host to runtime
Downloading http://.../model.tar.gz to /vosk/http___127_0_0_1_..._model_tar_gz
Writing response to .../downloaded.tar.gz, Content-Length: 44289907
download 100%
Failed to sync file system: Error: FS error      <-- 卡在这
```

- 下载**能跑完**（100%）
- 之后 `FS.syncfs`（把内存 FS 持久化到 IndexedDB）报 `FS error`，然后**永久挂起**

### 5. 这个 `FS error` **不是** IndexedDB 权限/配额问题

单独探测同一环境：

```
indexedDB     : object
openResult    : ok
quota         : 57727500288 (55 GB)
usage         : 0
session       : persistent = true
```

→ IndexedDB 完全正常，问题出在库自己的 IDBFS 用法（很可能是单次 44 MB 的 sync）。

---

## 当前状态

| 环节 | 状态 |
|------|------|
| ZIP 解压器（零依赖） | ✅ 已实现并测试 |
| 模型下载 + 安装校验 | ✅ 用**真实 41.9 MB 档案**验证通过（14 文件 / 0 跳过 / 5.3s） |
| 引擎内置（5.7 MB，自包含 WASM） | ✅ 许可已声明 |
| COOP/COEP 跨域隔离 | ✅ 已验证 SAB 可用 |
| tar / gzip 打包 | ✅ 已实现，tar 经真实 `tar` 验证 |
| **引擎初始化** | ❌ `FS.syncfs` 报 `FS error` 后挂起 |

---

## 下一步的两条路

### A. 继续修 WASM 路线
`vosk-browser@0.0.8` 是 **2021 年**的包，而本机 Chromium 是 **148**。它的 IDBFS
用法可能在这么新的运行时上已经失效。可尝试：
- 查是否有办法**关掉持久化缓存**（若缓存失败是唯一故障点，绕开即可）
- 预先把模型塞进它的 IDBFS 路径
- 试 `sherpa-onnx` 的 WASM 构建（在维护、支持离线流式识别）

### B. 改走**原生库 + koffi**（推荐）
本项目**已经依赖 `koffi`**（原本用于 VOICEVOX 原生调用）。Vosk 提供
`libvosk.dll` + `vosk_api.h`，可以直接 FFI 调用，于是：

- 模型直接从**本地磁盘路径**加载 —— 不需要 HTTP 服务、不需要 COOP/COEP、
  不需要 SharedArrayBuffer、不需要 tar、没有 WASM 运行时
- 少了整整一层（浏览器约束）故障面
- 代价：多下载一个原生库（约 10–20 MB），打包时要把 dll 放进 `asarUnpack`
  （构建配置里已为 koffi 配好 `asarUnpack`）

考虑到 A 已经在一个不维护的库上卡了两轮，**B 的成功率明显更高**。
