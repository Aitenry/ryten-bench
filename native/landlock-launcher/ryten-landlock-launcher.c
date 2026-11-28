/*
 * RytenBench sandbox service — Linux Landlock launcher (custom-built, no bubblewrap dependency).
 *
 * Usage:
 *   ryten-landlock-launcher --ro <path> [--ro <path>...] --rw <path> [--rw <path>...] -- <command> [args...]
 *
 * Semantics:
 *   - `--ro`  the tree under this path allows "read + execute";
 *   - `--rw`  the tree under this path allows "read + execute + write + remove + create objects";
 *   - paths not listed are **always denied** (Landlock is a whitelist: handled_access_fs covers
 *     all file operations, and only explicitly added rules are allowed).
 *
 * Approach: first assemble the handled mask from "the ABI supported by this kernel", create the
 * ruleset, add each path as a PATH_BENEATH rule, then PR_SET_NO_NEW_PRIVS + landlock_restrict_self
 * to restrict itself, and finally execvp the target command. Landlock restrictions are
 * **inherited across execve**, so the whole process tree stays restricted
 * (which is exactly why we don't need bwrap: no root, no namespaces, no external programs).
 *
 * Failure contract: any failure in any step prints `ryten-landlock-launcher: <detail>` to stderr
 * and exits with 125, **never executing the target command** (fail closed; callers use this to
 * decide "the sandbox is broken" rather than "the command failed").
 *
 * Build: `node native/landlock-launcher/build.mjs` (needs cc; only produces a binary on Linux).
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
/** Launcher's own failure exit code (distinguished from any command exit code) */
#define LAUNCHER_FAILURE_EXIT 125
/** Maximum number of paths allowed in PATH_BENEATH rules (enough for our needs; overflow fails instead of silently truncating) */
#define MAX_PATHS 256

#if !defined(RYTEN_HAVE_LANDLOCK_HEADERS)
/* Headers missing (old distros): compile straight into an "always fails" launcher so the
   upper-layer probe marks it unavailable and fails closed, instead of presenting a fake sandbox. */
int main(int argc, char **argv)
{
  (void)argc;
  (void)argv;
  fprintf(stderr, LAUNCHER_NAME ": linux/landlock.h not available at build time\n");
  return LAUNCHER_FAILURE_EXIT;
}
#else

/* Older headers may lack these constants: fill them in level by level according to the kernel ABI */
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

/** Read + execute permissions ("can see it, can run it") */
static uint64_t read_mask(uint32_t abi)
{
  (void)abi;
  return LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_READ_DIR |
         LANDLOCK_ACCESS_FS_EXECUTE;
}

/** Write permissions: create/remove/rename/truncate, added level by level per ABI (capabilities unsupported by old kernels are not requested) */
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

/** Add a PATH_BENEATH rule for one path (a nonexistent path fails immediately: a wrong whitelist must not silently degrade) */
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

  /* 1) Ask the kernel which Landlock ABI is supported (unsupported returns ENOSYS / EOPNOTSUPP) */
  int abi = landlock_create_ruleset(NULL, 0, LANDLOCK_CREATE_RULESET_VERSION);
  if (abi < 1)
  {
    fail("Landlock is not available on this kernel");
    return LAUNCHER_FAILURE_EXIT;
  }
  if (abi < 3)
  {
    /* ABI 1/2 lack TRUNCATE: report that faithfully (the upper layer marks enforcement
       completeness as partial based on it), but still apply the restriction. The prefix is
       deliberately **not** the fatal signature `ryten-landlock-launcher:` — that is the basis for
       deciding "the sandbox is broken"; an informational message on a successful run carrying the
       same prefix would be misread as a backend failure by the tool layer (measured during
       container verification on 2026-09-27). */
    fprintf(stderr, "[ryten-sandbox] partial enforcement (Landlock ABI %d < 3)\n", abi);
  }

  /* 2) Create the ruleset: handled mask = all file operations supported by this kernel (whitelist semantics) */
  struct landlock_ruleset_attr ruleset_attr;
  memset(&ruleset_attr, 0, sizeof(ruleset_attr));
  ruleset_attr.handled_access_fs = read_mask((uint32_t)abi) | write_mask((uint32_t)abi);
  int ruleset_fd = landlock_create_ruleset(&ruleset_attr, sizeof(ruleset_attr), 0);
  if (ruleset_fd < 0)
  {
    fail("landlock_create_ruleset");
    return LAUNCHER_FAILURE_EXIT;
  }

  /* 3) Add rules: --ro grants read+execute only, --rw additionally stacks write permissions */
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

  /* 4) Restrict self: no_new_privs is a prerequisite for Landlock */
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

  /* 5) Execute the target command (restrictions are inherited across execve into the whole process tree) */
  execvp(argv[index], &argv[index]);
  fail("execvp");
  return LAUNCHER_FAILURE_EXIT;
}

#endif /* RYTEN_HAVE_LANDLOCK_HEADERS */
