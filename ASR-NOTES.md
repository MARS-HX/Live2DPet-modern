# 离线语音识别 — 实现笔记

> **结论（已端到端验证）**：走**原生 `libvosk.dll` + `koffi`** 的路线**完全跑通**，
> 而且**整条生产链路**都被验证过 —— 不是分层验证，是端到端：
>
> ```
> bridge present : function
> asr status     : nativeInstalled: true, modelInstalled: true
> capture start  : {"ok":true}
> [ASR] heard: 你好 世界 这 是 一个 语音识别 测试 ...
> RESULT: END-TO-END WORKS — full offline chain produced text
> ```
>
> 链路：`getUserMedia` → `AudioWorklet` → 重采样 16 kHz → IPC →
> `AsrSession` → 原生 libvosk → 文字回传渲染进程。
> **全程离线、不联网、不需要 API Key。**
>
> 验证脚本：`verify-asr-offline.js`（见文末「如何复现验证」）。

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

---

## ✅ 最终采用：B（原生库 + koffi）— 已验证可用

### 组件

| 组件 | 说明 |
|------|------|
| `libvosk.dll` | 来自 `vosk-win64-0.3.45.zip`（GitHub release，14.2 MB） |
| 随附 MinGW 运行时 | `libstdc++-6.dll`(25 MB) / `libgcc_s_seh-1.dll` / `libwinpthread-1.dll` —— **必须一起放**，否则 dll 加载失败 |
| 模型 | 复用已有下载器装好的 `vosk-model-small-cn-0.22` |
| 绑定 | `koffi`（项目**本来就依赖**，原用于 VOICEVOX） |

落盘位置：`<userData>/vosk-native/lib/vosk-win64-0.3.45/`（下载解压**复用了第①②步的代码**）

### 绑定的 C API（签名取自随包 `vosk_api.h`）

```
void            vosk_set_log_level(int)
VoskModel*      vosk_model_new(const char* model_path)
void            vosk_model_free(VoskModel*)
VoskRecognizer* vosk_recognizer_new(VoskModel*, float sample_rate)
int             vosk_recognizer_accept_waveform(VoskRecognizer*, const char* data, int length)
const char*     vosk_recognizer_result(VoskRecognizer*)        // 部分结果
const char*     vosk_recognizer_final_result(VoskRecognizer*)  // 收尾
void            vosk_recognizer_free(VoskRecognizer*)
```

音频格式：**16 kHz 单声道 int16 小端**。

### 为什么这条路更好

WASM 路线需要的所有东西，这里**一个都不需要**：

| WASM 需要 | 原生 |
|---|---|
| 回环 HTTP 服务 | 不需要（模型直接读磁盘目录） |
| COOP / COEP 跨域隔离 | 不需要 |
| `SharedArrayBuffer` | 不需要 |
| tar + gzip 打包 | 不需要 |
| Emscripten 虚拟文件系统 / IDBFS | 不需要 |
| 浏览器安全上下文（麦克风） | 不需要 |

### 已清理的 WASM 残留

确定走原生路线后，以下均已删除（原因保留在本文档里，便于日后需要时重建）：

| 已删除 | 当初为何需要 |
|---|---|
| `libs/vosk/vosk.js`（5.7 MB） | WASM 引擎本体 |
| `src/main/tar-writer.js` + 其测试 | 引擎只吃未压缩 tar，需要把模型打包 |
| `vosk-browser` devDependency | 同上 |

### 打包注意

`libvosk.dll` 及其 MinGW 运行时（合计约 67 MB）放在 **userData**，
**不进安装包**。真正需要 `asarUnpack` 的是 `koffi`（FFI 加载器），
构建配置里已包含：`"asarUnpack": ["node_modules/koffi/**"]`。

### 验证方式

用 **Windows 自带的中文语音合成**（`Microsoft Huihui Desktop`，zh-CN）
在本地生成 16 kHz 单声道 WAV，再喂给引擎 —— **不需要联网、不需要 API Key**：

```
wav: 16000 Hz, 1 ch, 16 bit, 150 KB
expected : 你好世界，这是一个语音识别测试
heard    : 你好 世界 这 是一个 语音识别 测试
```

集成测试在**检测到本机已安装原生库+模型时才运行**（不会让测试套件依赖 60 MB 下载），
本机实测 **13 个用例全过、0 跳过**（即真的跑了真实模型）。

---

## 如何复现端到端验证

`verify-asr-offline.js` 利用 Chromium 的「用 WAV 文件冒充麦克风」能力
（`--use-file-for-fake-audio-capture`），把**整条生产链路**跑一遍 ——
不需要人对着麦克风说话，也不需要联网：

```bash
# 1) 本地合成一句中文语音（Windows 自带，离线）
#    用 System.Speech 输出 16kHz / 单声道 / 16bit WAV

# 2) 跑端到端验证
node_modules/electron/dist/electron.exe verify-asr-offline.js <wav路径> "期望文本"
```

它加载的是**真实的生产代码**：`registerAsrIPC` + `preload.js` +
`src/core/pcm-util.js` + `src/renderer/offline-asr.js`，
只有音源是合成的。任何一环坏掉都会在这里暴露。

> 注意：脚本里必须 `app.setName('live2dpet')`。
> 直接以裸脚本运行 Electron 时 `app.getName()` 是 `Electron`，
> `userData` 会指到别的目录，于是明明装好的引擎会被报成「未安装」——
> 这个坑我踩过一次，排查方向完全跑偏。

### 麦克风权限（已验证）

应用页面走 `file://`，实测在该上下文下：

```
isSecureContext : true
navigator.mediaDevices.getUserMedia : 存在
实际请求捕获      : {"ok":true,"tracks":1}
```

即 `file://` 被 Chromium 视为可信来源，麦克风可用；
`main.js` 里已有 `setPermissionRequestHandler` 放行 `media`。
