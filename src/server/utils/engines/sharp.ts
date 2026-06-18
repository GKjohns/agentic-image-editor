// The Sharp `DevelopEngine` — the `RT_EXECUTION=sharp` fallback. A thin adapter
// over the existing `EditExecutor.renderConfig`, so behavior is unchanged from
// before the engine seam existed. Stateless: `sessionId` is ignored and
// `dispose` is a no-op (only the sandbox runner keeps per-session state).

import type { DevelopEngine } from '~~/shared/types'
import { executor } from '~~/server/utils/executor'

export class SharpEngine implements DevelopEngine {
  async renderConfig(args: { sessionId: string, originalPath: string, config: import('~~/shared/types').DevelopConfig }): Promise<Buffer> {
    return executor.renderConfig(args.originalPath, args.config)
  }

  async dispose(_sessionId: string): Promise<void> {
    // No state to release.
  }
}
