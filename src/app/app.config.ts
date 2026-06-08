export default defineAppConfig({
  ui: {
    // Monochrome theme: `primary` rides the neutral grayscale ramp, then
    // `--ui-primary` is overridden to pure black/white in `main.css` (see the
    // note there — black & white have no 50–950 scale, so the semantic token is
    // set directly rather than via a palette name).
    colors: {
      primary: 'neutral',
      neutral: 'neutral'
    }
  }
})
