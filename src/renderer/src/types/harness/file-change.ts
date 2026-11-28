/**
 * File change view types.
 *
 * The source of truth lives in the main process (`src/main/workspace/file-history.ts`); this module
 * only forwards them, so the renderer does not keep a second definition that drifts from the main
 * process; cross-process DTOs are centralized in `shared/types.ts`.
 */
export type { FileChangeView, FileChangeContent } from '../../../../shared/harness/types'
