# Sample photo credits

Curated practice photos for the agentic image editor. Each was chosen because it
exhibits a clear, *globally fixable* problem (the kind of work the agent does:
straighten, exposure, contrast, tone, white balance, saturation/vibrance, named
looks, sharpen). All are real, minimally-processed shots — not pre-graded stock.

| File | Editing problem it demonstrates | Source | Author | License |
|------|--------------------------------|--------|--------|---------|
| `foggy-ocean-horizon.jpg` | Extremely flat / hazy / washed-out grey, very low contrast and no black point. Needs contrast + black-point/dehaze + a touch of vibrance. | https://unsplash.com/photos/foggy-ocean-stretches-into-the-misty-horizon-QLhHlNOu9Lw | Brandon Griggs (@paralitik) | Unsplash License (free, commercial OK, no attribution required) |
| `foggy-rocky-shore.jpg` | Hazy, low-contrast coastline with muted greens and a flat sky. Needs contrast + vibrance + highlight/haze recovery. | https://unsplash.com/photos/a-foggy-day-on-a-rocky-shore-with-pine-trees-X_YFIJsxUaA | Michael Baumgaertner (@mcb626) | Unsplash License (free, commercial OK, no attribution required) |
| `cozy-cafe-warm-cast.jpg` | Strong warm/orange tungsten color cast and a slightly dim interior. Needs white-balance correction + minor exposure lift. | https://unsplash.com/photos/a-cozy-cafe-interior-with-warm-lighting-and-furniture-0i5clWZBit0 | Kouji Tsuru (@pafuxu) | Unsplash License (free, commercial OK, no attribution required) |
| `overcast-ocean-horizon.jpg` | Flat, muted overcast seascape with a clear (slightly soft/off-level) horizon. Needs straighten + contrast + vibrance. | https://unsplash.com/photos/overcast-sky-above-a-dark-calm-ocean-B821YonGeMo | Richard Stachmann (@stachmann) | Unsplash License (free, commercial OK, no attribution required) |
| `flat-and-crooked.jpg` | Deliberately-degraded demo image (low contrast + crooked frame). Kept as-is from the original repo for the straighten + contrast demo. | (repo-provided demo asset) | — | — |

## Notes

- The three original picsum.photos samples (`landscape.jpg`, `portrait.jpg`,
  `street.jpg`) were removed. They were already color-graded stock photos (e.g.
  a punchy HDR sunset cityscape) that look finished out of the box — poor demos
  because the agent has little obvious work to do.
- Unsplash License summary: photos are free to use for commercial and
  non-commercial purposes, no permission or attribution required (attribution
  appreciated). See https://unsplash.com/license. Attribution is recorded above
  regardless, as good practice.
- All images resized to a max ~1600px long edge and re-encoded as JPEG to keep
  the repo light (each well under 400KB).
