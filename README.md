# Agentic Image Editor

A single-page Nuxt tool that takes an **image** plus a **natural-language edit description** and produces an edited image through an **iterative, vision-in-the-loop agent**. Each step the model looks at the current image, compares it to the user's intent, and tunes a **develop config** (one absolute value per slider) toward a stated sub-goal; the server re-renders from the original each pass, then re-evaluates — continuing until it judges the goal met (or hits an iteration cap).

This is the closed-loop version of the manual Lightroom workflow: the model stays in the loop and self-corrects instead of handing back to a human between edits.

## Layout

```
agentic-image-editor/
├── src/                 # the Nuxt app (Nuxt 4 + Nuxt UI starter)
├── internal_docs/       # spec + implementation plan
└── README.md
```

The actual Nuxt project lives one level down in `src/`. Run everything from there:

```bash
cd src
npm install
npm run dev      # http://localhost:3000
```

## Docs

- **Spec:** [`internal_docs/agentic-image-editor-spec.md`](internal_docs/agentic-image-editor-spec.md)
- **Implementation plan:** [`internal_docs/`](internal_docs/) (dated plan)

## Environment

See `src/.env.example`. v1 keeps it simple — a single **Vercel AI Gateway** key routes the vision model (swap Claude / GPT / Gemini without code changes).
