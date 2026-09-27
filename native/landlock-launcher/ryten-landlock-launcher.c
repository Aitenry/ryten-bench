/*
 * RytenBench 沙箱服务 —— Linux Landlock 启动器（自研，不依赖 bubblewrap）。
 *
 * 用法：
 *   ryten-landlock-launcher --ro <路径> [--ro <路径>...] --rw <路径> [--rw <路径>...] -- <命令> [参数...]
 *
 * 语义：
 *   - `--ro`  该路径树下允许「读 + 执行」；
 *   - `--rw`  该路径树下允许「读 + 执行 + 写 + 删除 + 建对象」；
 *   - 未列出的路径**一律拒绝**（Landlock 是白名单：handled_access_fs 覆盖全部文件操作，
 *     只有显式加规则的地方才放行）。
 *
 * 做法：先按「本内核支持的 ABI」拼出 handled 掩码，建 ruleset，把每条路径作为
 * PATH_BENEATH 规则加进去，然后 PR_SET_NO_NEW_PRIVS + landlock_restrict_self 限制自身，
 * 最后 execvp 目标命令。Landlock 的限制**跨 execve 继承**，因此整棵进程树都在限制下
 * （这正是我们不需要 bwrap 的原因：不需要 root、不需要 namespace、不需要任何外部程序）。
 *
 * 失败契约：任何一步失败都往 stderr 打 `ryten-landlock-launcher: <详情>` 并以 125 退出，
 * **绝不执行目标命令**（故障关闭；调用方据此判定「沙箱坏了」，而不是「命令失败了」）。
 *
 * 构建：`node native/landlock-launcher/build.mjs`（需要 cc；只在 Linux 上产出二进制）。
 */

#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#if defined(__has_include)
#if __has_include(<linux/landlock.h>)
#include <linux/landlock.h>
#define RYTEN_HAVE_LANDLOCK_HEADERS 1
#endif
#endif

#include <sys/prctl.h>
#include <sys/syscall.h>

#define LAUNCHER_NAME "ryten-landlock-launcher"
/** 启动器自身失败的退出码（与任何命令退出码区分开） */
#define LAUNCHER_FAILURE_EXIT 125
/** PATH_BENEATH 规则里最多允许的路径条数（够用即可，超出直接失败而不是静默截断） */
#define MAX_PATHS 256

#if !defined(RYTEN_HAVE_LANDLOCK_HEADERS)
/* 头文件缺失（老发行版）：直接编译成「永远失败」的启动器，
   让上层探针判为不可用并故障关闭，而不是给出一个假沙箱。 */
int main(int argc, char **argv)
{
  (void)argc;
  (void)argv;
  fprintf(stderr, LAUNCHER_NAME ": linux/landlock.h not available at build time\n");
  return LAUNCHER_FAILURE_EXIT;
}
#else

/* 老版本头文件里可能没有这些常量：按内核 ABI 逐级补齐 */
#ifndef LANDLOCK_ACCESS_FS_REFER
#define LANDLOCK_ACCESS_FS_REFER 0
#endif
#ifndef LANDLOCK_ACCESS_FS_TRUNCATE
#define LANDLOCK_ACCESS_FS_TRUNCATE 0
#endif
#ifndef LANDLOCK_ACCESS_FS_IOCTL_DEV
#define LANDLOCK_ACCESS_FS_IOCTL_DEV 0
#endif

#ifndef landlock_create_ruleset
static inline int landlock_create_ruleset(const struct landlock_ruleset_attr *attr, size_t size,
                                         uint32_t flags)
{
  return (int)syscall(__NR_landlock_create_ruleset, attr, size, flags);
}
static inline int landlock_add_rule(int ruleset_fd, enum landlock_rule_type rule_type,
                                    const void *rule_attr, uint32_t flags)
{
  return (int)syscall(__NR_landlock_add_rule, ruleset_fd, rule_type, rule_attr, flags);
}
static inline int landlock_restrict_self(int ruleset_fd, uint32_t flags)
{
  return (int)syscall(__NR_landlock_restrict_self, ruleset_fd, flags);
}
#endif

/** 读权限 + 执行（“看得见、跑得动”） */
static uint64_t read_mask(uint32_t abi)
{
  (void)abi;
  return LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_READ_DIR |
         LANDLOCK_ACCESS_FS_EXECUTE;
}

/** 写权限：创建/删除/改名/截断，按 ABI 逐级加（老内核不支持的能力不请求） */
static uint64_t write_mask(uint32_t abi)
{
  uint64_t mask = LANDLOCK_ACCESS_FS_WRITE_FILE |
                  LANDLOCK_ACCESS_FS_REMOVE_DIR |
                  LANDLOCK_ACCESS_FS_REMOVE_FILE |
                  LANDLOCK_ACCESS_FS_MAKE_CHAR |
                  LANDLOCK_ACCESS_FS_MAKE_DIR |
                  LANDLOCK_ACCESS_FS_MAKE_REG |
                  LANDLOCK_ACCESS_FS_MAKE_SOCK |
                  LANDLOCK_ACCESS_FS_MAKE_FIFO |
                  LANDLOCK_ACCESS_FS_MAKE_BLOCK |
                  LANDLOCK_ACCESS_FS_MAKE_SYM;
  if (abi >= 2) mask |= (uint64_t)LANDLOCK_ACCESS_FS_REFER;
  if (abi >= 3) mask |= (uint64_t)LANDLOCK_ACCESS_FS_TRUNCATE;
  if (abi >= 5) mask |= (uint64_t)LANDLOCK_ACCESS_FS_IOCTL_DEV;
  return mask;
}

static void fail(const char *what)
{
  fprintf(stderr, LAUNCHER_NAME ": %s: %s\n", what, strerror(errno));
}

static void fail_fmt(const char *what, const char *detail)
{
  fprintf(stderr, LAUNCHER_NAME ": %s: %s\n", what, detail);
}

/** 给一条路径加 PATH_BENEATH 规则（路径不存在直接失败：白名单写错不该静默降级） */
static int add_path_rule(int ruleset_fd, const char *path, uint64_t allowed)
{
  int path_fd = open(path, O_PATH | O_CLOEXEC);
  if (path_fd < 0)
  {
    fail(path);
    return -1;
  }
  struct landlock_path_beneath_attr attr;
  memset(&attr, 0, sizeof(attr));
  attr.allowed_access = allowed;
  attr.parent_fd = path_fd;
  if (landlock_add_rule(ruleset_fd, LANDLOCK_RULE_PATH_BENEATH, &attr, 0) != 0)
  {
    int saved = errno;
    close(path_fd);
    errno = saved;
    fail(path);
    return -1;
  }
  close(path_fd);
  return 0;
}

int main(int argc, char **argv)
{
  const char *ro_paths[MAX_PATHS];
  const char *rw_paths[MAX_PATHS];
  size_t ro_count = 0;
  size_t rw_count = 0;
  int index = 1;

  for (; index < argc; index++)
  {
    if (strcmp(argv[index], "--") == 0)
    {
      index++;
      break;
    }
    if (strcmp(argv[index], "--ro") == 0 || strcmp(argv[index], "--rw") == 0)
    {
      const int is_ro = argv[index][2] == 'r' && argv[index][3] == 'o';
      if (index + 1 >= argc)
      {
        fail_fmt("missing path after", argv[index]);
        return LAUNCHER_FAILURE_EXIT;
      }
      if (is_ro)
      {
        if (ro_count >= MAX_PATHS)
        {
          fail_fmt("too many --ro paths", argv[index + 1]);
          return LAUNCHER_FAILURE_EXIT;
        }
        ro_paths[ro_count++] = argv[index + 1];
      }
      else
      {
        if (rw_count >= MAX_PATHS)
        {
          fail_fmt("too many --rw paths", argv[index + 1]);
          return LAUNCHER_FAILURE_EXIT;
        }
        rw_paths[rw_count++] = argv[index + 1];
      }
      index++;
      continue;
    }
    fail_fmt("unknown argument", argv[index]);
    return LAUNCHER_FAILURE_EXIT;
  }

  if (index >= argc)
  {
    fail_fmt("missing command after --", "");
    return LAUNCHER_FAILURE_EXIT;
  }

  /* 1) 问内核支持哪个 Landlock ABI（不支持会返回 ENOSYS / EOPNOTSUPP） */
  int abi = landlock_create_ruleset(NULL, 0, LANDLOCK_CREATE_RULESET_VERSION);
  if (abi < 1)
  {
    fail("Landlock is not available on this kernel");
    return LAUNCHER_FAILURE_EXIT;
  }
  if (abi < 3)
  {
    /* ABI 1/2 缺少 TRUNCATE：如实报出来（上层据此把强制完整度标为 partial），但仍然施加限制。
       前缀刻意**不是**致命签名 `ryten-landlock-launcher:`——那是「沙箱坏了」的判定依据；
       成功运行的信息性提示若带同一前缀，会被工具层误判成后端故障（2026-09-27 容器验证实测踩到）。 */
    fprintf(stderr, "[ryten-sandbox] partial enforcement (Landlock ABI %d < 3)\n", abi);
  }

  /* 2) 建 ruleset：handled 掩码 = 本内核支持的全部文件操作（白名单语义） */
  struct landlock_ruleset_attr ruleset_attr;
  memset(&ruleset_attr, 0, sizeof(ruleset_attr));
  ruleset_attr.handled_access_fs = read_mask((uint32_t)abi) | write_mask((uint32_t)abi);
  int ruleset_fd = landlock_create_ruleset(&ruleset_attr, sizeof(ruleset_attr), 0);
  if (ruleset_fd < 0)
  {
    fail("landlock_create_ruleset");
    return LAUNCHER_FAILURE_EXIT;
  }

  /* 3) 加规则：--ro 只给读+执行，--rw 再叠加写 */
  for (size_t i = 0; i < ro_count; i++)
  {
    if (add_path_rule(ruleset_fd, ro_paths[i], read_mask((uint32_t)abi)) != 0)
    {
      close(ruleset_fd);
      return LAUNCHER_FAILURE_EXIT;
    }
  }
  for (size_t i = 0; i < rw_count; i++)
  {
    if (add_path_rule(ruleset_fd, rw_paths[i], read_mask((uint32_t)abi) | write_mask((uint32_t)abi)) != 0)
    {
      close(ruleset_fd);
      return LAUNCHER_FAILURE_EXIT;
    }
  }

  /* 4) 自我限制：no_new_privs 是 Landlock 的前置条件 */
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0)
  {
    fail("prctl(PR_SET_NO_NEW_PRIVS)");
    close(ruleset_fd);
    return LAUNCHER_FAILURE_EXIT;
  }
  if (landlock_restrict_self(ruleset_fd, 0) != 0)
  {
    fail("landlock_restrict_self");
    close(ruleset_fd);
    return LAUNCHER_FAILURE_EXIT;
  }
  close(ruleset_fd);

  /* 5) 执行目标命令（限制跨 execve 继承到整棵进程树） */
  execvp(argv[index], &argv[index]);
  fail("execvp");
  return LAUNCHER_FAILURE_EXIT;
}

#endif /* RYTEN_HAVE_LANDLOCK_HEADERS */
