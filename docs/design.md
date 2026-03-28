# Engineering Design Document
**Billy Reader — MVP**
v0.1, March 2026

---

## Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Extension manifest | Manifest V2 | Stable on Firefox, simpler for MVP |
| Extension ↔ service communication | Content script fetches localhost directly | FastAPI adds CORS headers; no background proxy needed |
| Dynamic content handling | Annotate on page load only | Low migration cost to add MutationObserver later |
| Batch concurrency | Parallel, max 4 in-flight | Minimal code overhead, noticeably faster on text-heavy pages |
| Toggle/restore | None — reload to revert | Eliminates DOM state management complexity |
| Python tooling | uv | Fast, modern, no virtualenv ceremony |
| Server | uvicorn running FastAPI | Standard ASGI stack |

---

## Architecture

```
Firefox Extension (Manifest V2)
├── manifest.json
├── content.js          ← DOM walker, ruby injector
├── popup.html + popup.js  ← enable/disable toggle
└── styles.css          ← ruby styling, phrase spacing

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

**Out (post-MVP):**
- `/explain` endpoint + LLM
- Per-character granularity toggle
- Background script caching
- Per-domain overrides
- Configurable settings (font size, spacing, pinyin style)
- MutationObserver for dynamic content

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

## How to run

```bash
# Start the annotation service
cd server && uv run uvicorn app:app --reload --port 8000

# Load the extension
# Firefox → about:debugging → This Firefox → Load Temporary Add-on → select extension/manifest.json
```
