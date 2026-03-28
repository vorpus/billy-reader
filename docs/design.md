# Engineering Design Document
**Billy Reader — MVP**
v0.1, March 2026

---

## Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Extension manifest | Manifest V2 | Stable on Firefox, simpler for MVP |
| Extension ↔ service communication | Content script fetches localhost directly | FastAPI adds CORS headers; no background proxy needed |
| Dynamic content handling | MutationObserver + shadow root polling | Handles SPAs, infinite scroll, and deeply nested web components (e.g. Bilibili) |
| Batch concurrency | Parallel, max 4 in-flight | Minimal code overhead, noticeably faster on text-heavy pages |
| Toggle/restore | None — reload to revert | Eliminates DOM state management complexity |
| Python tooling | uv | Fast, modern, no virtualenv ceremony |
| Server | uvicorn running FastAPI | Standard ASGI stack |

---

## Architecture

```
Firefox Extension (Manifest V2)
├── manifest.json
├── content.js          ← DOM walker, ruby injector, MutationObserver, shadow DOM
├── background.js       ← per-tab icon state management
├── popup.html + popup.js  ← enable/disable toggle (reload-to-revert)
├── styles.css          ← ruby styling, phrase spacing
├── icon-on.png         ← toolbar icon (enabled)
└── icon-off.png        ← toolbar icon (disabled)

        │ fetch (localhost:8000)
        ▼

Local Service (FastAPI + uvicorn)
└── POST /annotate      ← jieba segmentation + pypinyin
```

---

## MVP Scope

**In:**
- Pinyin annotation via `<ruby>` tags (per-word segmentation)
- Popup with enable/disable per tab
- FastAPI `/annotate` endpoint
- CORS configured for extension origin

**Also shipped (beyond original MVP scope):**
- MutationObserver for dynamic content
- Shadow DOM traversal (recursive, handles Bilibili's 5-level deep web components)
- Shadow root polling for late-attaching shadow roots (no DOM event exists for this)
- Firefox Xray vision workaround (`openOrClosedShadowRoot`)
- Per-tab icon state via background script
- Reload-to-revert when toggling off
- `Alt+A` keyboard shortcut (`e.code` for macOS compat)
- Batch `/annotate` API (`{ "texts": [...] }` → `{ "results": [...] }`)

**Out (post-MVP):**
- `/explain` endpoint + LLM
- Per-character granularity toggle
- Response caching
- Per-domain overrides
- Configurable settings (font size, spacing, pinyin style)

---

## Milestones

### M1: Python annotation service

**Goal:** A running FastAPI server that accepts Chinese text and returns segmented pinyin.

**Work:**
- Initialize Python project with `pyproject.toml` (dependencies: fastapi, uvicorn, jieba, pypinyin)
- Create `server/app.py` with:
  - `POST /annotate` — accepts `{ "text": "..." }`, returns `{ "segments": [...] }`
  - Each segment: `{ "chars": "...", "pinyin": ["...", ...] }`
  - Punctuation passed through as segments with no pinyin
- Add `CORSMiddleware` allowing all origins (single-user local tool)
- Add `GET /health` for connectivity checks
- Verify: `curl -X POST localhost:8000/annotate -d '{"text":"一想到总有一天"}' ` returns correct segments and pinyin

**Files:**
```
server/
├── app.py
pyproject.toml
```

---

### M2: Extension skeleton + popup

**Goal:** A Firefox extension that loads, shows a popup, and stores enable/disable state per tab.

**Work:**
- Create `manifest.json` (MV2): content script on all URLs, popup, permissions for localhost
- Create `popup.html` + `popup.js`:
  - Toggle button (on/off)
  - State stored via `browser.storage.local` keyed by tab ID
  - Sends message to content script on toggle
- Create `content.js` (empty shell):
  - Listens for messages from popup
  - Logs enable/disable state to console
- Create `styles.css` (empty, placeholder)
- Verify: install as temporary add-on in Firefox, click icon, toggle works, console shows messages

**Files:**
```
extension/
├── manifest.json
├── popup.html
├── popup.js
├── content.js
└── styles.css
```

---

### M3: DOM walking + annotation rendering

**Goal:** Content script extracts Chinese text nodes, calls `/annotate`, and replaces them with ruby markup.

**Work:**
- In `content.js`:
  - Walk DOM text nodes under `document.body`
  - Filter: include nodes with CJK characters (`\u4E00-\u9FFF`, `\u3400-\u4DBF`, `\uF900-\uFAFF`)
  - Exclude: nodes inside `<script>`, `<style>`, `<input>`, `<textarea>`, `<ruby>`
  - Batch text into chunks of ~500 chars
  - Fetch `POST localhost:8000/annotate` for each batch (max 4 concurrent)
  - Replace each text node with `<span>` containing `<ruby>` elements per segment
  - Punctuation segments rendered as plain text (no `<rt>`)
  - Wrap phrase groups (segments with `phrase_boundary: true`) in `<span class="phrase-group">`
- Wire to popup toggle: only annotate when enabled
- Verify: load a Chinese webpage with extension active and server running, pinyin appears above characters

**Files modified:**
```
extension/content.js
```

---

### M4: Styling + polish

**Goal:** Annotations look clean and don't break page layouts.

**Work:**
- In `styles.css`:
  - `ruby` base styling: `rt` font size 50% of parent
  - `.phrase-group` spacing: `margin-right: 0.4em`
  - Ensure ruby elements don't break `flexbox`/`grid` parent layouts (use `display: inline`)
  - Prevent annotation of already-annotated content (check for `.billy-annotated` class)
- Add `Alt+A` keyboard shortcut to trigger annotation (in `content.js`)
- Mark annotated containers with a class to prevent double-annotation
- Test on 3-4 real sites: a news article, a manga reader, a forum, a subtitle page
- Fix any layout breakage found during testing

**Files modified:**
```
extension/styles.css
extension/content.js
```

---

## Lessons Learned

- **Firefox Xray vision** blocks `element.shadowRoot` in content scripts even for open shadow roots. Use `element.openOrClosedShadowRoot` (Firefox extension privileged API) as fallback.
- **Shadow roots can attach after element insertion.** No DOM event fires for this, so polling (`setInterval`) is the only reliable detection method.
- **Bilibili comments** use 5 levels of nested shadow DOM (`bili-comments` → `bili-comment-thread-renderer` → `bili-comment-renderer` → `bili-rich-text`). Shadow root scanning must be fully recursive.
- **macOS `Alt+A`** produces `å` via Option key, so `e.key === "a"` fails. Use `e.code === "KeyA"` instead.
- **`rt` font-size 50%** is too small at body text ≤15px. Bumped to 60%.
- **Styles don't penetrate shadow DOM.** Must inject stylesheet via `<link>` into each shadow root, requiring `web_accessible_resources` in the manifest.

## How to run

See `README.md` in the project root.
