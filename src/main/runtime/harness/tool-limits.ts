/**
 * Output boundary constants for filesystem tools (single source of truth).
 *
 * Why it is a separate module: these limits are consumed in two places at once —
 *  - `fs-backend.ts`: the hard boundary when actually executing reads/searches/commands;
 *  - `service/tool-presentation.ts`: when projecting tool results into frontend cards, it needs
 *    them to decide "was the result truncated" and to report accurate metadata.
 * The module stays dependency-free so node offline regression scripts can import it directly.
 */

/**
 * Inline limit for a single file read (characters; anything beyond does not enter the model
 * context)
 */
export const MAX_FILE_CHARS = 20_000
/**
 * read_file in-memory protection limit (oversized files are truncated to 2M characters so the
 * whole file is never pulled into memory)
 */
export const MAX_FILE_READ_CHARS = 2_000_000
/** Command output limit (characters) */
export const MAX_EXEC_CHARS = 8_000
/** Recursive search entry limit */
export const MAX_SCAN_ENTRIES = 2_000
/** Hard tool output limit (memory protection; 12K–500K is handled by the overflow strategy) */
export const MAX_OUTPUT_CHARS = 500_000
