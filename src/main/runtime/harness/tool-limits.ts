/**
 * 文件系统工具的输出边界常量（单一真源）。
 *
 * 抽成独立模块的原因：这些上限同时被两处消费——
 *  - `fs-backend.ts`：真正执行读取/搜索/命令时的硬边界；
 *  - `service/tool-presentation.ts`：把工具结果投影成前端卡片时，需要据此判断
 *    「结果是否被截断」并给出准确的元信息。
 * 该模块保持零依赖，因此可被 node 离线回归脚本直接导入。
 */

/** 单文件读取内联上限（字符；超出部分不进入模型上下文） */
export const MAX_FILE_CHARS = 20_000
/** read_file 内存保护上限（超大文件截断到 2M 字符，防止把整个文件读进内存） */
export const MAX_FILE_READ_CHARS = 2_000_000
/** 命令输出上限（字符） */
export const MAX_EXEC_CHARS = 8_000
/** 递归搜索条目上限 */
export const MAX_SCAN_ENTRIES = 2_000
/** 工具输出硬上限（内存保护；12K~500K 由溢出策略处理） */
export const MAX_OUTPUT_CHARS = 500_000
