# Sprint 1 live curl — config trail

Sample: `flat-and-crooked.jpg` · Intent: "make this flat, crooked photo pop" · Model: anthropic/claude-sonnet-4-6

Each step is the FULL DevelopConfig the agent returned; the server re-rendered it from `original.jpg`.

| Step | straighten | exposure | highlights | shadows | contrast | vibrance | sharpen | note |
|------|-----------|----------|-----------|---------|----------|----------|---------|------|
| 1 | 2.5 | 0 | 0 | 0 | 0 | 0 | 0 | level horizon first |
| 2 | 1.5 | 0.4 | -20 | 30 | 0.30 | 0.45 | 0.3 | big pop pass — **overshoots** |
| 3 | 1.5 | 0.4 | -20 | 30 | **0.20** | **0.25** | 0.3 | **reduces** contrast & vibrance (sees neon) |
| 4 | 1.5 | 0.4 | -20 | 30 | 0.25 | 0.35 | 0.3 | small nudge back up |
| 5 | 3.5 | 0.5 | -25 | 35 | 0.20 | 0.30 | 0.3 | re-straighten + rebalance |
| 6 | 3.5 | 0.5 | -25 | 35 | 0.20 | **0.15** | 0.3 | **reduces** vibrance again → natural |
| 7 | — | — | — | — | — | — | — | done:true (converged) |

**Headline:** vibrance moved 0.45 → 0.25 → 0.35 → 0.30 → 0.15 — freely up AND down. Because every
render is from the original, step-06 (vibrance 0.15) is genuinely LESS saturated than step-02
(vibrance 0.45) — provable by pixels and JPEG size (step-02 236KB vs step-03 207KB), not an inverse
op piled on top. 0 AI_JSONParseError across the run; terminated on the model's own done judgment.
