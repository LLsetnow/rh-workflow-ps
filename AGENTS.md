# RH Workflow PS

This project is independent of rh-workflow-desk. Do not modify that project.

- Business UI lives in `static/`, inside a real browser WebView. `static/app.css` and the Desk component structure are the visual source of truth.
- `plugin/` is a small native UXP shell and Photoshop API bridge. Never reproduce the business UI in native UXP HTML.
- Native shell CSS uses basic flex layout, fixed pixel values, and explicit colors. Modern browser CSS belongs in `static/`.
- Use `scripts/sync-desk-ui.py` to refresh the Desk UI. Keep integration changes in the sync script, `ps-webview.js`, and `ps-webview.css`.
- Prompt workshop, focus mode, and Telegram inbound are disabled. Workflow prompt editing and Telegram output delivery remain available.
- Use the project's own `data/` and port 8768. Never copy keys, accounts, cookies, .env, SQLite, or original user media from another project automatically.
- Browser checks are preliminary. A visual change is accepted only after observing the actual Photoshop WebView panel. Record Photoshop version, viewport, and what was tested.
- No real RunningHub/Codex/paid generation during tests. The native self-test creates a synthetic scratch document, checks pixels, and closes that scratch document without saving.
- Preserve originals and unrelated changes. Use JSON-safe RPC methods with request IDs, timeouts, a method allowlist, and origin checks; never add an arbitrary JavaScript evaluation endpoint.

Validation: `npm run check`, `.venv/bin/python -m pytest -q tests`, browser checks at 320/460/900px, and `/lab?autorun=1` in the actual Photoshop WebView.
