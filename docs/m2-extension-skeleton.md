# M2: Extension Skeleton + Popup
**Expanded Design — Billy Reader**

---

## Goal

Ship a Firefox extension (Manifest V2) that loads on any webpage, displays a browser action popup with an enable/disable toggle, persists that state, and sends messages to a content script. No annotation logic yet — this milestone proves the extension plumbing works end-to-end.

---

## Technical Decisions and Rationale

### 1. Manifest V2, not V3

Firefox has full, stable MV2 support. MV3 on Firefox is supported but still has rough edges (particularly around background service workers and content script lifecycle). MV2 gives us persistent background pages (if we ever need one) and well-documented APIs. Since this is a personal tool loaded as a temporary add-on, there is no store-review concern about MV2 deprecation.

### 2. No background script in M2

The design doc intentionally omits `background.js` from the MVP. For M2, the popup communicates directly with the content script via `browser.tabs.sendMessage`. A background script is only needed later for caching (M3+). Skipping it now avoids unnecessary complexity.

### 3. `browser.*` API namespace (no polyfill needed)

Firefox natively provides the `browser.*` namespace, which returns Promises. The `chrome.*` namespace also works in Firefox (callback-based, for Chrome compat), but since we are targeting Firefox only, we use `browser.*` directly. No `webextension-polyfill` is needed.

If Chrome support is ever added, we would either: (a) add `webextension-polyfill` as a shim, or (b) migrate to MV3 which standardizes the `chrome.*` namespace with Promises. Neither is needed now.

### 4. State management: per-tab, stored in memory (not storage)

The design doc says "state stored via `browser.storage.local` keyed by tab ID." This has a problem: **tab IDs are ephemeral**. They are integers assigned by the browser and never reused within a session, but they have no meaning across sessions. Storing them in `browser.storage.local` would accumulate stale entries.

**Revised approach:** Store enabled state **in the content script itself** (a simple boolean variable). The popup queries the content script for current state on open, and sends a toggle message. This means:

- State is naturally per-tab (each tab has its own content script instance).
- State dies with the tab (no cleanup needed).
- No storage API needed for M2 at all.
- `browser.storage.local` is reserved for future persistent settings (granularity, font size, per-domain defaults).

If we later want "remember enabled state across page reloads for a domain," that becomes a per-domain setting in storage, which is the right granularity anyway.

### 5. Content script injected on every page

The content script is declared in `manifest.json` with `"matches": ["<all_urls>"]`. This means it loads on every page, even when annotation is disabled. The tradeoff:

| Approach | Pros | Cons |
|---|---|---|
| Always inject (chosen) | Popup can always message it; no programmatic injection needed; simpler | Tiny memory overhead on every tab |
| Inject on demand via `browser.tabs.executeScript` | Zero overhead when disabled | Requires `activeTab` or broader permissions at injection time; popup must handle "script not yet injected" case; more error states |

Since the content script in M2 is a minimal shell (< 1KB), always-inject is the right call. The overhead is negligible.

### 6. Popup communicates with content script via message passing

The message flow is:

```
popup.js                          content.js (in active tab)
   │                                   │
   ├── browser.tabs.query(            │
   │     {active:true,                │
   │      currentWindow:true})        │
   │                                   │
   ├── browser.tabs.sendMessage(      │
   │     tabId,                       │
   │     {type:"TOGGLE"})  ──────────►│
   │                                   ├── toggles internal state
   │                                   ├── returns {enabled: bool}
   │◄──────────────────────────────────┤
   ├── updates toggle button UI        │
   │                                   │
   ├── browser.tabs.sendMessage(      │
   │     tabId,                       │
   │     {type:"GET_STATE"}) ─────────►│
   │                                   ├── returns {enabled: bool}
   │◄──────────────────────────────────┤
   ├── initializes toggle button UI    │
```

Key details:
- `browser.tabs.sendMessage` sends a message to all content scripts in the specified tab. It returns a Promise that resolves with the content script's response.
- The content script uses `browser.runtime.onMessage.addListener(handler)`. The handler receives `(message, sender)` and returns a value (or a Promise) which becomes the response.
- The popup queries `browser.tabs.query({active: true, currentWindow: true})` to get the active tab's ID. This requires no special permissions beyond what `browser_action` provides.

**Why not `browser.runtime.sendMessage` (the other direction)?** That sends from content script to background/popup. We do not need it in M2 because the popup initiates all communication.

---

## manifest.json Skeleton

```json
{
  "manifest_version": 2,
  "name": "Billy Reader",
  "version": "0.1.0",
  "description": "Pinyin annotations for Chinese text on any webpage.",

  "permissions": [
    "activeTab",
    "storage",
    "*://localhost/*"
  ],

  "browser_action": {
    "default_popup": "popup.html",
    "default_title": "Billy Reader"
  },

  "content_scripts": [
    {
      "matches": ["<all_urls>"],
      "js": ["content.js"],
      "css": ["styles.css"],
      "run_at": "document_idle"
    }
  ]
}
```

### Field-by-field explanation

| Field | Required? | Purpose |
|---|---|---|
| `manifest_version` | Yes | Must be `2`. |
| `name` | Yes | Extension display name. |
| `version` | Yes | Semver string. |
| `description` | No, but recommended | Shown in `about:addons`. |
| `permissions` | No, but needed | See permissions section below. |
| `browser_action` | No | Defines the toolbar button + popup. In MV2, `browser_action` is for always-visible icons. (`page_action` is for per-page icons, not what we want.) |
| `content_scripts` | No | Declaratively inject scripts/CSS into pages. |

### Permissions breakdown

| Permission | Why |
|---|---|
| `activeTab` | Lets the popup access the currently active tab (needed for `browser.tabs.query` + `sendMessage`). Granted implicitly when the user clicks the browser action. |
| `storage` | Access to `browser.storage.local`. Not strictly needed in M2 (state is in-memory), but included now to avoid a manifest change in M3. |
| `*://localhost/*` | Allows content scripts to `fetch()` the local FastAPI server. Without this, the request is blocked by the extension's CSP. Covers both `http://localhost:8000` and any port. |

**Note on `<all_urls>` in content_scripts.matches:** This is a match pattern, not a permission. It controls where the content script is injected. It does not grant the extension host permissions. The content script can only make cross-origin fetches if the target origin is listed in `permissions`.

---

## State Management

### M2 (this milestone)

```
              ┌────────────────────────┐
              │   content.js (per tab) │
              │                        │
              │   let enabled = false  │
              │                        │
              └────────────────────────┘
```

- Each content script instance holds its own `enabled` boolean.
- Default is `false` (annotation off).
- Popup reads/writes it via message passing.
- State is lost on page reload (acceptable for M2).

### Future (M3+)

- Per-domain defaults stored in `browser.storage.local`, keyed by hostname.
- On content script load, check storage for a domain default and initialize `enabled` accordingly.
- Popup toggle still uses message passing but also writes the domain default to storage.

---

## Known Risks and Gotchas

### 1. Content script not ready when popup sends message

If the user clicks the extension icon very quickly after page load, the content script may not have initialized yet. `browser.tabs.sendMessage` will reject with an error like "Could not establish connection. Receiving end does not exist."

**Mitigation:** Wrap the sendMessage call in a try/catch in popup.js. If it fails, show the toggle in a default "off" state. This is a minor UX edge case.

### 2. `file://` and privileged pages

Content scripts cannot inject into `about:*` pages, `moz-extension:*` pages, or `file://` URLs (unless `"all_urls"` is replaced with explicit file access, which requires a separate permission). The popup should handle this gracefully -- if sendMessage fails on these pages, show a "not available on this page" message.

### 3. Popup lifecycle

The popup is destroyed every time it closes. It has no persistent state of its own. Every time the user opens the popup, `popup.js` must query the content script for current state. This is fine -- the query is fast (sub-millisecond, same-process IPC).

### 4. Multiple content script injections

If the manifest is reloaded (during development via `about:debugging`), Firefox does not remove previously injected content scripts. The old and new scripts will both be running. Both will respond to messages, but `sendMessage` only receives the first response. This can cause confusion during development.

**Mitigation:** Add a version constant to messages and ignore mismatches, or simply reload the target tab after reloading the extension.

### 5. CSP on strict sites

Some websites have strict Content Security Policies. Content scripts run in an isolated world and are not affected by the page's CSP for their own execution. However, inline styles injected into the page DOM may be blocked by the page's CSP. Since we load `styles.css` via `manifest.json` (not inline), this should not be an issue. Worth verifying on a CSP-strict site during testing.

### 6. `localhost` permission and HTTPS pages

Fetching `http://localhost:8000` from a content script on an `https://` page is technically a mixed-content request. Firefox allows this for `localhost` specifically (it is treated as a secure context). No issue expected, but worth verifying in M3 when actual fetch calls are added.

---

## Verification Steps

1. **Load as temporary add-on:**
   - Open `about:debugging#/runtime/this-firefox`
   - Click "Load Temporary Add-on"
   - Select `extension/manifest.json`
   - Confirm: no errors in the console, extension icon appears in toolbar

2. **Popup opens:**
   - Click the Billy Reader icon
   - Confirm: popup appears with a toggle button showing "OFF" state

3. **Toggle sends message to content script:**
   - Open any webpage (e.g., `https://example.com`)
   - Open the browser console (F12) for that tab
   - Click the extension icon, click the toggle
   - Confirm: console logs show the message was received (e.g., `"Billy Reader: enabled = true"`)
   - Click toggle again
   - Confirm: console logs `"Billy Reader: enabled = false"`

4. **Popup reflects current state on reopen:**
   - Toggle to "ON"
   - Close the popup
   - Reopen the popup
   - Confirm: toggle shows "ON" (popup queried the content script)

5. **State is per-tab:**
   - Toggle ON in Tab A
   - Switch to Tab B (different page)
   - Open popup
   - Confirm: toggle shows "OFF" in Tab B (independent content script)

6. **Graceful failure on restricted pages:**
   - Navigate to `about:config` or `about:debugging`
   - Click extension icon
   - Confirm: popup does not crash; shows "off" or "not available"

---

## File Listing

```
extension/
├── manifest.json       # MV2 manifest: permissions, content script declaration, browser action
├── popup.html          # Minimal HTML: toggle button, status text
├── popup.js            # Queries active tab, sends TOGGLE/GET_STATE messages, updates UI
├── content.js          # Message listener shell: holds enabled state, logs to console
└── styles.css          # Empty placeholder (used in M3+)
```

No new server-side files in this milestone. No dependencies or build step.
