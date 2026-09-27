# 沙箱服务（自研跨平台）

> 目标：**装上就能用**的真正的沙箱——不需要管理员权限、不需要新建系统账户、不需要用户
> 额外安装 bubblewrap / Docker / 任何工具。写入边界由**操作系统**强制，而不是靠正则猜命令。

## 分层

| 层                 | 位置                                                          | 职责                                                                             |
| ------------------ | ------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| 策略 / 审批        | `src/plugins/harness/main/runtime/permission*.ts`             | 档位（仅可查看 / 工作区内修改 / 完全权限）、危险命令提前问人、审批弹窗、升权重试 |
| **执行（本文档）** | `src/plugins/harness/main/sandbox/**`                         | 把档位翻译成各平台 OS 隔离原语，包装要执行的命令                                 |
| 平台后端           | 同上 + `resources/sandbox/**` + `native/landlock-launcher/**` | Windows 受限令牌 runner、Linux Landlock 启动器 / bubblewrap、macOS sandbox-exec  |

关键原则：**拿不到内核级隔离就拒绝执行（故障关闭）**，绝不退回「不受限地跑」。
`SANDBOX_UNAVAILABLE` 文本会原样返回给模型，界面在「设置 → 智能体 → 沙箱」里如实显示后端状态。

## 各平台机制（全部自研，无第三方沙箱依赖）

### Windows：受限令牌 + 能力 SID + DACL

`resources/sandbox/win32-sandbox-runner.cjs`（纯 JS + koffi 调 Win32 API）：

1. 打开当前进程令牌 → 取登录 SID（`S-1-5-5-x-y`，进程初始化必需）；
2. 由工作区路径**确定性派生**能力 SID（`S-1-4-a-b`，SHA-256 → 两个子权威），
   私有临时目录再派生第二个（随机目录 → 随机 SID）；
3. 给工作区/临时目录的 DACL 合并一条该 SID 的写 ACE（写 + 删除 + 删除子项，
   **不含** `WRITE_DAC`/`WRITE_OWNER`——被沙箱化的进程不能改 DACL 自救），
   读-改-写全程持每路径 `LockFileEx` 独占锁，避免并发沙箱互相覆盖 ACE；
4. `CreateRestrictedToken(WRITE_RESTRICTED)`：restricting 列表 = [登录 SID, Everyone]
   （workspace-write 再加两个能力 SID）。Windows 对写类访问做**两遍检查**，
   restricting 列表里没有的 SID 拿不到任何写权限 ⇒ 只能写工作区；
5. `CreateProcessAsUserW` 以受限令牌 spawn，**runner 自己 `CreatePipe` 建匿名管道**做 stdio
   （Node 的管道是 overlapped 的，受限子进程同步写会 `ERROR_INVALID_PARAMETER`），
   `PeekNamedPipe` + `ReadFile` 泵回 runner 的 stdout；子进程放进 kill-on-close 的
   Job Object（runner 被杀 → 整棵子树被清理）；
6. `TMP`/`TEMP` 指向已授权的私有临时目录；退出后撤销临时 ACE、删临时目录、镜像退出码。

命令：`mode=cleanup` 可撤销工作区上的常驻 ACE（工作区 ACE 默认常驻以复用：第二次起命中
精确 ACE 就跳过整棵树的重新传播）。

### Linux：Landlock（自研启动器）/ bubblewrap

- 优先 `bwrap`（若系统已装）：`--ro-bind / /` + workspace-write 时 `--bind <工作区>`、
  `--tmpfs /tmp`、`--unshare-pid`、`--die-with-parent`；
- 否则用**自研启动器** `native/landlock-launcher/ryten-landlock-launcher.c`
  （由 `native/build-sandbox.mjs` 在 Linux 上编译，产出到 `resources/sandbox/linux-<arch>/`）：
  先按内核 ABI 拼 handled 掩码，给 `--ro` / `--rw`
  路径加 `PATH_BENEATH` 规则，`PR_SET_NO_NEW_PRIVS` + `landlock_restrict_self` 自我限制，
  再 `execvp` 目标命令——限制跨 `execve` 继承到整棵进程树。
  **不需要 root、不需要装任何包**，只要求内核 ≥ 5.13（Landlock）。

### macOS：sandbox-exec（系统自带）

运行时生成 SBPL 配置：`(allow default)(deny file-write*)` + 放开 `/dev/null` 等 sink，
workspace-write 时再 `(allow file-write* (subpath <工作区>))`；命令经
`sandbox-exec -p <profile> -- argv` 执行。

## 故障语义（工装逐条钉住）

| 情况                                                                                                                  | 行为                                                                                                  |
| --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 后端可用                                                                                                              | 按档位包装执行；`workspace-write` 越界写入被 OS 拒绝                                                  |
| 写被拒                                                                                                                | 命令输出尾部附 `[sandbox: file access denied under <mode> mode]` + 升权提示（模型可申请一次人工提权） |
| 后端自身失败（签名 `ryten-sandbox-run:` / 退出码 127、`ryten-landlock-launcher:` / 125、`bwrap: `、`sandbox-exec: `） | 判定为**沙箱坏了**而不是命令失败，工具返回「命令未执行」                                              |
| 没有任何可用后端                                                                                                      | `[sandbox: unavailable — the command was not run]`，命令**不执行**                                    |

两层是叠加的，不是二选一：**审批放行 ≠ 沙箱放行**。用户在弹窗里批准一条危险命令后，
它仍然要在文件系统边界内运行——越界写入照样被操作系统拒绝（模型会拿到拒绝标记，
可以再申请一次「完全权限」的临时升权，那会再弹一次窗）。

## 已知边界（如实写出来，不假装是绝对边界）

- **Windows 是部分强制**：受限令牌必须保留 `Everyone`（否则早期 DLL 初始化与 CNG 会崩），
  因此 DACL 里显式授予 Everyone 写权限的对象仍可写；NTFS 硬链接可把已授权文件别名到工作区外；
- Windows 需要 **NTFS**（exFAT / 网络盘没有 ACL）：探针会在这种工作区里失败 → 判定不可用；
- 沙箱会给工作区目录加一条 ACE（不可见、可复用、可用 `cleanup` 撤销）；
- macOS 的 `sandbox-exec` 被 Apple 标记为 deprecated（但仍随每个 macOS 分发）；
- **Linux Landlock 腿：只接受目录级写规则**（对普通文件/字符设备调用 `landlock_add_rule`
  会返回 `EINVAL`，2026-09-27 在 ABI 1 上实测），而 `> /dev/null` 是命令行基本操作，
  所以这条腿放开的是 `/dev` **目录**的写权限 —— 代价是 /dev 下的设备节点写权限一并放开
  （普通用户对这些节点本身没有 DAC 权限），因此该腿自评 **partial**；
  bubblewrap 腿没有这个问题（`--dev /dev` 换掉整个 /dev，只留 null/zero/full/random/urandom/tty），自评 **full**；
- Linux 需要内核 ≥ 5.13；ABI < 3 时启动器会往 stderr 报 `[ryten-sandbox] partial enforcement (Landlock ABI N < 3)`
  （**信息性提示，不是致命签名**：致命失败才是 `ryten-landlock-launcher: ...` + 退出码 125）；
- 本沙箱只约束**文件系统写入**（与 DSH 一致），不约束网络、进程或凭据。

## 打包

- `electron-builder.yml`：`extraResources: resources/sandbox → sandbox`（脚本要能被
  独立进程 spawn；Linux 启动器还要保住可执行位），`asarUnpack` 里含 `**/koffi/**`
  （原生 `.node` 不能从 asar 里加载）；
- 运行期路径解析见 `sandbox/service.ts` 的 `resolveSandboxAsset`：开发态
  `<仓库>/resources/sandbox/...`，打包态 `<resourcesPath>/sandbox/...`；
- Windows runner 用 `process.execPath` + `ELECTRON_RUN_AS_NODE=1` 启动，并通过
  `RYTEN_APP_ROOT` 找到 koffi；
- **`resources/sandbox/` 整目录是构建产物**（`.gitignore` 已忽略）：由
  `native/build-sandbox.mjs`（`pnpm build:sandbox`）产出——把
  `native/win32-sandbox-runner/win32-sandbox-runner.cjs` 复制成
  `<out>/win32-sandbox-runner.cjs`，并在 Linux 上把
  `native/landlock-launcher/ryten-landlock-launcher.c` 编译成
  `<out>/linux-<arch>/ryten-landlock-launcher`。`dev` 与 `build:win/mac/linux/unpack`
  都会先跑它，所以 clone 下来不会缺资源；源码全在会入库的 `native/` 下，删掉该目录不丢东西。

## 工装

### 本机（Windows）真机 + 三平台 argv 契约

```bash
node test/verify-sandbox-service.mjs
```

- ① 各后端 argv 契约（离线，三平台都能跑）；
- ② 服务链路：探针缓存、平台链回退、故障关闭；
- ③ 输出分类：拒绝 vs 后端故障（含「信息性提示不得被当成故障」）；
- ④ **真机**：Windows 段（越界写入真被拒、工作区内写入成功、read-only 连工作区都写不了、
  工作区外读取仍可用、TMP 重定向、孙进程可启动、输出直通、ACL 上确有 `S-1-4-*`、cleanup 撤销 ACE、
  工具层把越界写入分类成 `denied`）；Linux 段（自研启动器 / bwrap，同样逐条真机断言）；
  macOS 段（Seatbelt，在有 Mac 时跑）。

### Docker：跨平台构建 + 容器内真机验证

```bash
pnpm verify:sandbox-docker          # linux/amd64 + linux/arm64 都跑
node docker/verify-sandbox.mjs --arch amd64
```

> 按仓库 `.gitignore` 约定，`docker/` 与 `test/` 同为**不入库的本地工装**（和 `scripts/`、`docs/`
> 一样）。也就是说 clone 下来没有这两个目录；要复现跨平台验证，需按本节描述自建——脚本本身
> 很短（驱动 ~200 行 + 容器内验证器 ~200 行 + 一个 Dockerfile），逻辑已在本节说明清楚。

流程与结论（2026-09-27 实测：Docker 29 + WSL2 内核 5.15）：

| 平台        | 后端                               | 结论                                                                                                                                                          |
| ----------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| linux/amd64 | `linux-landlock`（自研静态启动器） | **OK**（8 项真机断言全过，partial）                                                                                                                           |
| linux/amd64 | `linux-bwrap`（`--privileged`）    | **OK**（8 项，full）                                                                                                                                          |
| linux/arm64 | 两条腿                             | **DEGRADED**：QEMU 用户态模拟没实现 Landlock 系统调用（`ENOSYS`）、也建不起 namespace，只能验证「产物可用 + 故障关闭」；**强制能力需真机/原生 arm64 CI 复验** |

容器里的 `docker/verify-linux.mjs` 是进版本库的自包含验证器（`test/` 被忽略，不能依赖它）；
它先探测两条腿是否真的可用，不可用时进入**降级模式**并如实打印原因，而不是假装通过。
`--security-opt seccomp=unconfined` 是必需的：部分 Docker 版本的默认 seccomp 白名单不含
`landlock_*` 三个系统调用。
