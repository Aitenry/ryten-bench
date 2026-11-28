/**
 * Login / account / Lattice plugin hub / sync entries.
 *
 * Namespaces are split by product area (no copy is hard-coded in components):
 * - `login.*`: standalone login page (brand panel + login card + advanced server address);
 * - `lattice.*`: sidebar account area, bridge status, publish and upload;
 * - `plugins.hub.*`: plugin repository page / plugin detail page (platform catalog, versions and
 *   source, publishing, importing a local directory);
 * - `sync.*`: sync status bar, sync actions and result messages in the account menu.
 *
 * The plugin repository has only one remote source, the platform, so there are no data-source
 * switching entries such as `sourceLattice` / `sourceGithub` here.
 *
 * Count messages use `{{n}}` rather than i18next's `count`: the numbers in the plugin hub need no
 * plural rules, which avoids writing a separate `_one/_other` set per language.
 */
export const zhCNLattice = {
  login: {
    windowTitle: '登录',
    title: '登录 RytenBench',
    subtitle: '登录 Lattice 账号，解锁插件中心与跨设备同步。',
    username: '用户名',
    usernamePlaceholder: '请输入用户名',
    usernameRequired: '请输入用户名',
    password: '密码',
    passwordPlaceholder: '请输入密码',
    passwordRequired: '请输入密码',
    remember: '记住我',
    submit: '登录',
    submitting: '正在登录…',
    success: '登录成功，欢迎回来',
    failure: '登录失败，请检查用户名与密码',
    errorTitle: '无法登录',
    back: '返回工作台',
    bridgeUnavailableTitle: '插件中心未就绪',
    bridgeUnavailableDesc: '主进程的插件中心通道尚未就绪，暂时无法登录。请重启应用后再试。',
    server: {
      label: '服务器地址',
      placeholder: 'http://127.0.0.1:8080',
      hint: '高级选项：留空时使用默认地址，通常无需修改。'
    },
    brand: {
      tagline: '助手可以在应用里打造您的专属工作台，以及解决您的其他需求。',
      point1Title: '插件中心',
      point1Desc: '发现、安装并更新团队插件，都在一处。',
      point2Title: '跨设备同步',
      point2Desc: '插件清单与配置，多台设备保持一致。',
      point3Title: '本地优先',
      point3Desc: '数据留在本机，需要时才同步到云端。',
      footer: 'RytenBench · Lattice 平台'
    }
  },
  lattice: {
    account: {
      guest: '未登录',
      goLogin: '点击登录',
      connecting: '连接中…',
      bridgeUnavailable: '插件中心未就绪',
      bridgeHint: '主进程通道未连接',
      title: '账号信息',
      username: '用户名',
      displayName: '显示名称',
      userId: '用户 ID',
      role: '角色',
      server: '服务器',
      /* Two sync lines in the account info dialog: the value takes its own right-hand column, so the labels must not contain {{time}} / {{n}} placeholders */
      lastSync: '最近同步',
      conflicts: '数据冲突',
      roleAdmin: '管理员',
      roleMaintainer: '运营',
      roleMember: '用户',
      connected: '插件中心已连接',
      localStatus: '本地工作区',
      logout: '退出登录',
      logoutTitle: '退出登录',
      logoutBody: '退出后本机已安装的插件仍会保留，但不会再从插件中心同步数据。',
      logoutSuccess: '已退出登录',
      logoutFail: '退出登录失败',
      logoutConfirm: '确认退出',
      hub: '插件中心',
      accountInfo: '账号信息',
      syncNow: '立即同步'
    },
    errors: {
      bridgeUnavailable: '未检测到插件中心连接：主进程的插件中心通道尚未就绪，请重启应用后再试。',
      requestFailed: '请求失败：{{reason}}',
      loginRequired: '请先登录插件中心'
    },
    hub: {
      latestVersion: '插件中心版本',
      notPublished: '尚未发布',
      updateAvailable: '插件中心有更新 v{{version}}',
      notLoggedIn: '登录后可查看插件中心版本'
    },
    upload: {
      modalTitle: '发布到插件中心',
      preparing: '正在准备发布…',
      phaseZip: '正在打包插件',
      phaseMeta: '正在写入插件信息',
      phaseUpload: '正在上传插件包',
      phaseSource: '正在上传源码包',
      bytes: '{{sent}} / {{total}}',
      keepOpen: '上传过程中请勿关闭窗口',
      success: '已发布 {{name}} v{{version}}',
      submitted: '已提交 {{name}} v{{version}}，等待管理员审核通过',
      canceled: '已取消上传',
      fail: '上传失败',
      publishAction: '发布到插件中心',
      publishActionDesc:
        '选择插件包目录（读取其中的 plugin.json 与 README.md），安装包与源码会一起上传到 Lattice 插件中心。'
    }
  },
  plugins: {
    hub: {
      searchPlaceholder: '搜索名称、作者或标签…',
      categoryLabel: '分类',
      categoryAll: '全部分类',
      refresh: '刷新',
      upload: '上传',
      uploadZipHint: '上传 .zip 安装包',
      uploadWithSourceHint: '发布安装包 + 源码目录（两份分开的 zip）',
      /** Top-bar "Publish" dropdown: three publish modes + import local directory in one menu (no longer 4 buttons side by side) */
      publishMenu: '发布',
      publishMenuTitle: '发布插件到插件中心',
      publishDir: '发布插件目录…',
      publishZip: '发布 .zip 安装包…',
      publishWithSource: '发布安装包 + 源码目录…',
      installLocal: '本地安装',
      importLocalDir: '导入本地插件目录…',
      total: '共 {{n}} 个插件',
      loading: '正在加载插件中心…',
      loadFail: '加载插件中心目录失败：{{reason}}',
      loadFailTitle: '插件中心加载失败',
      retry: '重试',
      loginRequiredTitle: '登录后使用插件中心',
      loginRequiredDesc:
        '登录 Lattice 账号即可浏览、安装、更新与发布团队插件，并在多台设备间同步插件配置。',
      goLogin: '去登录',
      unavailableTitle: '插件中心不可用',
      unavailableDesc: '主进程的插件中心通道尚未就绪。请重启应用后再试。',
      empty: '插件中心还没有插件',
      emptyHint: '上传本机插件包，或导入本地插件目录后再看看。',
      noMatch: '没有匹配的插件',
      install: '安装',
      update: '更新',
      reinstall: '重新安装',
      installFail: '安装插件失败',
      installSuccess: '已安装「{{name}}」',
      updateSuccess: '「{{name}}」已更新到 v{{version}}',
      installVersionSuccess: '「{{name}}」已安装为 v{{version}}',
      updateAvailable: '可更新',
      updateTo: '更新到 v{{version}}',
      updateAll: {
        button: '更新全部（{{n}}）',
        done: '已更新 {{n}} 个插件',
        partial: '更新完成：成功 {{ok}} 个，失败 {{fail}} 个'
      },
      installed: '已安装',
      installedVersion: '本地 v{{version}}',
      enabled: '已启用',
      disabled: '已停用',
      downloads: '下载 {{n}}',
      versions: '{{n}} 个版本',
      owner: '作者',
      installDisabled: '该插件暂不可安装',
      openDetail: '打开插件详情',
      /** Generic message shown when the current main process has not implemented a channel of contract v2 yet */
      v2Unsupported: '当前主进程版本暂不支持该能力（请重启更新后的应用）',
      /** Source package (contract v2: each platform version = install package + optional source package) */
      source: {
        badge: '源码',
        hasSource: '含源码',
        noSource: '无源码',
        open: '打开源码',
        size: '源码 {{size}}',
        hint: '平台版本同时提供安装包与源代码包',
        downloadFailed: '安装包已装好，但源码下载失败：{{reason}}',
        backedUp: '本机源码有改动，更新前已备份到：{{path}}'
      },
      /** Plugins installed on this machine but not yet published to the plugin hub (installed via local upload) */
      local: {
        badge: '本地安装',
        desc: '通过本地上传安装，尚未发布到插件中心',
        detail: '查看详情',
        empty: '没有本地安装的插件'
      },
      /** Version history table on the plugin detail page */
      versionTable: {
        title: '版本历史',
        version: '版本',
        size: '大小',
        source: '源码',
        publishedAt: '发布时间',
        changelog: '更新说明',
        actions: '操作',
        downloadPackage: '下载安装包',
        downloadSource: '下载源码',
        installVersion: '安装此版本',
        currentVersion: '当前版本',
        latest: '最新',
        noChangelog: '—',
        empty: '暂无版本信息'
      },
      detail: {
        readmeTitle: '插件说明',
        latestVersion: '插件中心最新版',
        notPublished: '尚未发布到插件中心',
        localVersion: '本机版本',
        sourcePath: '源码路径',
        noSourcePath: '未下载源码（该版本没有源码包）',
        localSourcePath: '本机安装目录',
        downloads: '下载 {{n}}',
        downloadsLabel: '下载数',
        category: '分类',
        tags: '标签',
        publishedAt: '发布时间',
        updateAvailable: '插件中心有新版 v{{version}}',
        installVersion: '安装 v{{version}}',
        openInChat: '在对话中修改',
        openInChatDesc: '打开源码工作区，让模型帮你改这个插件',
        publishNewVersion: '发布新版本',
        publishNewVersionDesc: '读取本机源码目录，重新打包安装包与源码并发布到插件中心',
        publishLocal: '发布到插件中心',
        publishLocalDesc: '直接发布本机已安装的这个插件（自动带安装包与源码，无需选择目录）',
        notPublishedHint: '这个插件还没有发布到插件中心，发布的版本才会出现在插件目录里。',
        workflowTitle: '源码与发布',
        workflowDesc:
          '安装时会把源码一起下载到本机；在对话中改完源码后，用「发布新版本」上传新的安装包与源码。'
      },
      /** "Publish new version" modal on the detail page */
      publish: {
        title: '发布新版本',
        version: '版本号',
        versionPlaceholder: '如 1.4.2',
        versionHint: '需高于插件中心当前最新版本 v{{version}}',
        versionRequired: '请输入版本号',
        versionInvalid: '版本号格式不正确（示例：1.4.2）',
        changelog: '更新说明',
        changelogPlaceholder: '这次改了什么？（可选）',
        submit: '发布',
        success: '已发布 v{{version}}',
        submitted: '已提交 v{{version}}，等待管理员审核通过',
        fail: '发布失败：{{reason}}'
      },
      /** "Open source" on the detail page / cards */
      openSource: {
        success: '已打开插件源码，可在对话中让模型修改',
        folderFallback: '已在文件管理器打开源码（未能自动创建对话）',
        fail: '打开源码失败：{{reason}}',
        unsupported: '当前主进程版本不支持打开源码（请重启更新后的应用）',
        noSource: '该版本没有源码包，无法打开'
      },
      /** Download actions in the version table (the main process shows a save dialog) */
      download: {
        success: '已保存到 {{path}}',
        canceled: '已取消下载',
        fail: '下载失败：{{reason}}',
        unsupported: '当前主进程版本不支持下载（请重启更新后的应用）'
      },
      /** Top-bar "Import local plugin directory" bulk publish */
      import: {
        success: '导入完成：成功 {{imported}} 个，跳过 {{skipped}} 个',
        empty: '所选目录里没有找到包含 plugin.json 的插件',
        fail: '导入失败：{{reason}}',
        unsupported: '当前主进程版本不支持导入本地插件目录（请重启更新后的应用）'
      }
    }
  },
  sync: {
    title: '同步',
    lastSync: '最近同步 {{time}}',
    never: '尚未同步',
    now: '立即同步',
    merge: {
      button: '合并云端数据',
      /** Same shape as "sync.success": plugin count / synced row count, without listing each plugin */
      success: '合并完成：{{merged}} 个插件 / {{rows}} 条数据',
      /** Some plugins failed: successful ones are reported as usual, failed ones are only counted (reasons go to the log / sync details) */
      partial: '合并完成：{{merged}} 个插件 / {{rows}} 条数据，{{failed}} 个失败',
      failed: '合并失败：{{failed}} 个插件的数据没并进来',
      /** Changed on both sides: no automatic union; the user is explicitly sent to the conflict dialog */
      conflicts:
        '已对齐 {{merged}} 个插件 / {{rows}} 条数据；{{conflicts}} 个插件两边都有改动，请到「解决冲突」选择（没有覆盖任何一边）',
      /** Missing merge base (first time after an upgrade): prompts to sync once first instead of a vague "merge failed" */
      blocked:
        '还有 {{blocked}} 个插件缺少合并基线，请先「立即同步」一次再合并（本次没有改动任何数据）',
      empty: '没有可合并的数据（没有安装快照插件，或云端还没有它们的快照）',
      hint: '对着「上次同步的基线」比：只有本机改过（删除/修改）就把本机更新推上去；只有云端更新就拉下来；两边都改过会记为冲突让你选择——不会自动并集，也不会覆盖任何一边。'
    },
    syncing: '正在同步…',
    success:
      '同步完成：推送 {{pushed}} 个插件 / {{pushedRows}} 条数据，拉取 {{pulled}} 个插件 / {{pulledRows}} 条数据',
    rowsSummary: '↑{{pushed}} 条 · ↓{{pulled}} 条',
    conflicts: '{{n}} 个数据冲突',
    conflictsShort: '{{n}} 个冲突',
    error: '同步失败：{{reason}}',
    justNow: '刚刚',
    /**
     * Automatic reinstall when switching machines: on pull, records where the platform has an
     * install record but the local machine has no plugin package are reinstalled automatically.
     * Enabled by default; failures are visible one by one (not silent), with details in "Sync details".
     */
    autoInstall: {
      toggle: '自动补齐插件',
      toggleHint:
        '换机、重装或手动删除插件目录后，同步时自动从插件中心重新安装缺失的插件（默认开启）。关闭后同步只在结果里列出缺失插件，不自动安装。',
      on: '自动补齐：开',
      off: '自动补齐：关',
      done: '已自动补齐 {{n}} 个插件',
      partial: '已自动补齐 {{ok}} 个插件，{{fail}} 个失败（可查看原因）',
      allFailed: '{{fail}} 个插件自动补齐失败（可查看原因）',
      failed: '{{fail}} 个自动补齐失败（可查看原因）',
      orphaned: '{{n}} 个安装记录的平台插件已删除',
      viewDetails: '查看同步详情',
      unsupported: '当前主进程版本不支持自动补齐（请重启更新后的应用）'
    },
    details: {
      title: '同步详情',
      description: '本次同步的明细：自动补齐、平台已删除的安装记录与插件数据冲突。',
      autoInstallTitle: '自动补齐',
      autoInstallEmpty: '本次同步没有需要自动补齐的插件',
      installedTitle: '已补齐（{{n}}）',
      failedTitle: '补齐失败（{{n}}）',
      failedHint: '单个插件失败不影响其它插件补齐；可稍后重新同步，或在插件仓库手动安装。',
      orphanedTitle: '平台已删除的安装记录（{{n}}）',
      orphanedHint:
        '这些安装记录指向的插件已在平台删除。本机的插件目录与数据会保留，不会自动删除（标记为 orphaned）。',
      orphanedEmpty: '没有平台已删除的安装记录',
      conflictsTitle: '数据冲突（{{n}}）',
      conflictsHint: '本机与云端都改过同一插件的数据，请用「解决冲突」逐个选择保留哪边。',
      retry: '重新同步',
      unsupported: '当前主进程版本不支持同步详情（请重启更新后的应用）',
      close: '关闭'
    },
    resolve: {
      button: '解决冲突（{{n}}）',
      title: '解决插件数据冲突',
      description:
        '云端与本机都改过同一个插件的数据。请逐个选择保留哪一边；支持合并的插件还可以「合并两边」（保留本机数据、把云端独有的行按自然键去重后加进来）。',
      localRev: '本机 rev {{n}}',
      serverRev: '云端 rev {{n}}',
      localData: '本机数据',
      serverData: '云端数据',
      noData: '（无数据）',
      useLocal: '用本机覆盖云端',
      useCloud: '用云端覆盖本机',
      merge: '合并两边',
      done: '冲突已解决',
      empty: '没有待解决的冲突'
    },
    pushed: '推送 {{n}}',
    pulled: '拉取 {{n}}'
  }
}
