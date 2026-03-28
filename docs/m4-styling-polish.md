# M4: Styling + Polish — Expanded Design
**Billy Reader**
v0.1, March 2026

---

## Goal

Make pinyin annotations look clean, readable, and visually unobtrusive across a wide range of real Chinese websites — without breaking host page layouts. Add keyboard-triggered annotation and guard against double-annotation. After this milestone, the extension should be usable for daily reading on typical Chinese web content.

---

## 1. Ruby Rendering in Firefox

### 1.1 Current State of `<ruby>` Support

Firefox has supported `<ruby>` and `<rt>` natively since Firefox 38 (2015). The rendering is mature and reliable for the simple case we need (base text + single annotation line). Key facts:

- Firefox renders `<rt>` above the base text by default, which is the standard position for pinyin.
- `<rp>` (ruby parenthesis) fallback tags are unnecessary for Firefox-only targeting but are cheap to include for robustness.
- Firefox does **not** support `<rtc>` (ruby text container) for double-sided annotations — irrelevant for our use case but worth noting.
- `ruby-position: over` is supported and is the default. No need to set it explicitly unless a host page overrides it.

### 1.2 Known Quirks

| Issue | Description | Mitigation |
|---|---|---|
| Line-height inflation | Ruby annotations increase the effective line-height of the line they sit on, causing uneven line spacing in paragraphs | Set `ruby { line-height: normal; }` and consider `rt { line-height: 1; }` to minimize inflation. Accept that some inflation is unavoidable — this is inherent to ruby rendering. |
| Intercharacter spacing | Firefox adds slight spacing between ruby bases to accommodate wider `<rt>` text (pinyin is often wider than a single hanzi) | This is actually desirable for readability. No mitigation needed. |
| `overflow: hidden` ancestors | If a parent element has `overflow: hidden` with a tight height, `<rt>` text can be clipped | No general fix. This is rare in practice and site-specific. |
| Interaction with `text-transform` | `text-transform: uppercase` on an ancestor will uppercase pinyin | Reset with `rt { text-transform: none; }` |
| `font-size` inheritance | `<rt>` inherits font-size from its parent `<ruby>`, then browsers apply an internal 50% scaling. Setting `rt { font-size: 50%; }` explicitly can cause double-scaling (resulting in 25% of parent). | Set `rt { font-size: 0.5em; }` relative to the `<ruby>` element, **but first** reset the browser's internal UA stylesheet scaling with `rt { font-size: revert-layer; font-size: 0.5em; }` or simply rely on the browser default and only override if needed. Safest: test the computed size and only apply a custom size if the default is wrong. |

### 1.3 Why Raw `<ruby>` Is the Right Choice

Alternatives considered:

| Approach | Pros | Cons |
|---|---|---|
| Native `<ruby>` + `<rt>` | Semantic, accessible, browser handles alignment, works with text selection and copy | Line-height impact, some CSS quirks |
| CSS `::after` pseudo-elements with `content: attr(data-pinyin)` | No extra DOM nodes, no line-height impact | Cannot wrap per-character, poor alignment, inaccessible, breaks text selection |
| Absolutely positioned overlays | Full layout control | Extremely fragile, must recalculate on scroll/resize, terrible for reflow |
| Canvas/SVG overlay | Complete visual control | Not part of text flow, kills accessibility, copy-paste, text selection |

**Decision: Use native `<ruby>` + `<rt>`.** The semantic and practical advantages far outweigh the styling quirks. The line-height impact is an acceptable trade-off that users of Chinese reading tools universally expect.

---

## 2. CSS Architecture

### 2.1 Style Isolation Strategy

The extension injects styles into host pages. Those styles must:
1. Apply reliably to our injected elements
2. Not leak into host page elements
3. Not be overridden by host page styles

**Approach: Namespaced selectors + targeted `!important` + CSS custom properties.**

Shadow DOM was considered but rejected for the following reasons:
- Ruby elements must live inline within the host page's text flow. Wrapping them in shadow DOM would break text selection across annotated and non-annotated content.
- Shadow DOM boundaries prevent the host page's font styles from cascading in, meaning annotated text would lose its font-family/size/color unless we manually copied computed styles.
- Shadow DOM adds complexity disproportionate to the isolation benefit for inline text annotations.

**Specific strategy:**

1. **Prefix all classes** with `billy-` (e.g., `billy-annotated`, `billy-phrase-group`) to avoid collisions with host page classes.

2. **Use high-specificity selectors.** Instead of `ruby { ... }`, use `ruby.billy-ruby { ... }` or even `ruby[data-billy] { ... }`. Attribute selectors are unlikely to collide with host page styles.

3. **Apply `!important` only on properties that host pages commonly override** and that are critical to our rendering:
   - `rt[data-billy] { font-size: 0.5em !important; }` — prevents host `*` selectors from breaking annotation size
   - `rt[data-billy] { text-transform: none !important; }` — prevents uppercasing
   - `ruby[data-billy] { display: ruby !important; }` — prevents host page from changing display type

4. **Do NOT apply `!important` to** colors, font-family, or other visual properties that should inherit from the host page for visual consistency.

5. **Inject styles via a dedicated `<style>` element** with `id="billy-reader-styles"` inserted into `<head>`, rather than inline styles on each element. This is more performant and easier to manage.

### 2.2 Core Stylesheet

```css
/* === Billy Reader Annotation Styles === */

/* Ruby base: ensure inline rendering, prevent layout disruption */
ruby[data-billy] {
  display: ruby !important;
  ruby-position: over;
  line-height: normal;
  /* Inherit font properties from host page */
}

/* Ruby text (pinyin) */
rt[data-billy] {
  font-size: 0.5em !important;
  line-height: 1;
  text-transform: none !important;
  font-style: normal !important;
  font-weight: normal !important;
  color: inherit;
  opacity: 0.7;
  user-select: none; /* Prevent pinyin from appearing in copy-paste */
}

/* Phrase group spacing */
span.billy-phrase-group {
  margin-right: 0.4em;
  display: inline; /* Critical: never block or inline-block */
}

/* Annotated container marker */
[data-billy-annotated] {
  /* No visual styling — purely a marker */
}
```

### 2.3 Font Size Analysis: Is 50% Readable?

The PRD specifies `<rt>` at 50% of parent font size. Analysis at common body text sizes:

| Body font size | `<rt>` at 50% | Readable? | Notes |
|---|---|---|---|
| 14px | 7px | Barely — at the limit of legibility | Common on dense Chinese news sites. May need 60% override. |
| 16px (most common) | 8px | Yes, acceptable | Standard browser default. Pinyin is legible but small. |
| 18px | 9px | Yes, comfortable | Common on reading-focused sites. |
| 20px+ | 10px+ | Yes, very comfortable | Large text sites, accessibility modes. |

**Decision:** Default to 50% as specified. At 14px body text, 7px pinyin is tight but the pinyin serves as a hint, not primary reading material. Users who read sites with 14px body text are likely already comfortable with dense layouts. If testing reveals consistent readability issues, bump to 55% or 60%.

**Future consideration:** The PRD lists RT font size as configurable (40%-70%). The default should work for the 80% case; configurability addresses the rest.

### 2.4 Phrase Group Spacing

The design calls for `margin-right: 0.4em` on `.billy-phrase-group` spans.

**Potential issues:**
- `margin-right` on inline elements works correctly in Firefox — inline elements respect horizontal margins.
- At line wrap boundaries, the margin creates a small gap at the end of the line before wrapping. This is visually acceptable and matches how word-spacing works in Latin text.
- If the phrase group is the last element in a line, the trailing margin is harmless (it does not cause horizontal overflow because inline margins do not extend the containing block).

**One concern:** If phrase groups are inside a `text-align: justify` container, the extra margins may interfere with justification. This is unlikely to be noticeable because Chinese text justification already uses inter-character spacing.

**Decision:** `margin-right: 0.4em` on inline spans is sufficient. No fallback needed.

---

## 3. Ruby Elements in Complex Layouts

### 3.1 Flexbox Parents

If a text node lives inside a flex container (e.g., `<div style="display:flex"><span>中文</span></div>`), replacing the text node's content with `<ruby>` elements works fine because:
- The `<ruby>` elements are inline and sit inside an existing flex item (the `<span>` or text-containing element).
- We are replacing **text nodes**, not the flex items themselves.
- The flex item may grow slightly taller due to ruby line-height inflation, which could affect `align-items` behavior.

**Risk:** Low. The DOM walker targets text nodes, which are always inside some container element. The container's display type is not changed.

### 3.2 Grid Parents

Same analysis as flexbox. Grid items contain our text nodes; we modify content inside grid items, not the grid items themselves. Minimal risk.

### 3.3 Float Layouts

Floated elements with fixed heights are the most likely to clip `<rt>` content. If a floated element has `height: 40px; overflow: hidden`, the ruby annotation above the first line of text may be clipped.

**Mitigation:** None at the CSS level. This is a site-specific issue. The annotation is "best effort" — some layout contexts will clip annotations, and that is acceptable for MVP.

### 3.4 `position: absolute` / `position: fixed` Overlays

Text in absolutely positioned elements (cookie banners, modals, tooltips, floating menus) will be annotated if it contains CJK characters. The ruby rendering works fine, but:
- These elements often have tight heights and `overflow: hidden`.
- Annotating ephemeral UI elements (tooltips, dropdowns) is usually undesirable.

**Mitigation for MVP:** None. The DOM walker already excludes `<script>`, `<style>`, `<input>`, `<textarea>`. Adding exclusions for `[role="tooltip"]`, `[role="dialog"]`, or elements with `position: fixed` is a post-MVP enhancement.

---

## 4. Double-Annotation Prevention

### 4.1 Problem

If the user triggers annotation twice (via popup toggle or keyboard shortcut), the content script must not re-annotate already-annotated content. Re-annotation would:
- Wrap `<ruby>` inside `<ruby>`, producing garbled rendering
- Double the DOM node count
- Potentially annotate pinyin text in `<rt>` elements as if it were Chinese content

### 4.2 Strategy

Three layers of defense:

1. **Container-level marker:** When a text node is annotated, its replacement span gets a `data-billy-annotated` attribute. The DOM walker skips any node whose ancestor has this attribute.

2. **`<ruby>` exclusion in the walker:** The existing design already excludes nodes inside `<ruby>` elements (M3 spec). This prevents annotating the `<rt>` content.

3. **Global state flag:** `content.js` maintains a module-level boolean `isAnnotated`. When annotation is triggered:
   - If `isAnnotated === true`, skip (or optionally: remove annotations and re-annotate, for a future "refresh" feature).
   - If `isAnnotated === false`, proceed and set to `true` on completion.

**Why all three?** Defense in depth. The global flag handles the simple case. The `data-billy-annotated` attribute handles partial annotation (e.g., if annotation was interrupted or if new content was dynamically added). The `<ruby>` exclusion handles edge cases where content from other sources already has ruby markup.

### 4.3 DOM Walker Filter (Updated)

The text node filter in M3 should include this additional check:

```
Skip node if:
  - node is inside <script>, <style>, <input>, <textarea>, <ruby>
  - node is inside an element with [data-billy-annotated]
  - node contains no CJK characters
```

---

## 5. Keyboard Shortcut: `Alt+A`

### 5.1 Implementation Approach

**Use `addEventListener('keydown', ...)` in the content script**, not the `commands` API in manifest.json.

Rationale:
- The `commands` API (manifest.json `"commands"` key) routes shortcuts through the background script, requiring message-passing to reach the content script. This adds complexity.
- The `commands` API is better suited for global shortcuts that work even when no page is focused. Our shortcut only needs to work on pages with content scripts.
- A content script `keydown` listener is simpler and more direct.

### 5.2 Implementation Details

```
Listen for: keydown event where event.altKey === true && event.key === 'a' (or 'A')
Action: Toggle annotation (annotate if not yet annotated; no-op or reload-to-revert if already annotated)
Guard: event.preventDefault() and event.stopPropagation() to prevent the shortcut from triggering browser or page actions.
```

### 5.3 Conflict Analysis

| Conflict source | Risk | Mitigation |
|---|---|---|
| Firefox built-in shortcuts | `Alt+A` is not a standard Firefox shortcut on any OS. On Linux, `Alt` activates the menu bar, but `Alt+A` does not map to any menu. On macOS, `Alt/Option+A` types `å` — this is a **real conflict** for users who type in text fields. | Only intercept when the active element is NOT an input/textarea/contenteditable. Check `document.activeElement.tagName` and `isContentEditable`. |
| Host page JavaScript | Some web apps bind `Alt+A` for their own features (rare). | Our listener calls `stopPropagation()` but uses capture phase (`addEventListener('keydown', handler, true)`) so we get first priority. If conflicts emerge in practice, the shortcut can be made configurable post-MVP. |
| Other extensions | Other extensions may also listen for `Alt+A`. | No mitigation possible. Conflict is unlikely and user can disable conflicting extensions. |

### 5.4 macOS Consideration

On macOS, `Alt` (Option) is a modifier for typing special characters. `Option+A` produces `å`. This means:
- The shortcut will be intercepted before the special character is typed, but only outside text fields (per the guard above).
- This is acceptable behavior. The PRD already specifies `Alt+A`.
- If this proves problematic, an alternative like `Ctrl+Shift+A` could be considered post-MVP.

---

## 6. Test Matrix

### 6.1 Target Site Categories

| # | Category | Example Sites | Layout Patterns Exercised | Key Concerns |
|---|---|---|---|---|
| 1 | **News / Long-form articles** | sina.com.cn, thepaper.cn, bbc.com/zhongwen | Dense paragraphs, `<p>` tags, standard block flow, inline links and emphasis within text, pull quotes | Line-height inflation across many lines, readability of pinyin at small font sizes, large number of text nodes |
| 2 | **Forums / Nested comments** | v2ex.com, zhihu.com, tieba.baidu.com | Deeply nested `<div>` structures, flexbox/grid comment layouts, user-generated content with mixed Chinese/English, inline images, quoted text blocks | Ruby inside flex items, mixed-language annotation filtering, deeply nested DOM walking performance |
| 3 | **Video / Subtitle sites** | bilibili.com (comments + descriptions), youtube.com (Chinese titles/descriptions) | Short text fragments, overlay UI elements, dynamically loaded content, position: absolute/fixed elements | Annotating short strings, dealing with position:fixed elements, content that appears after initial page load |
| 4 | **E-commerce / Dense UI** | taobao.com, jd.com | Grid layouts, extremely dense text, tiny font sizes (12-13px), text in buttons/links/badges, `overflow: hidden` containers | Clipped `<rt>` in tight containers, annotating UI text vs. content text, very small pinyin at 50% of 12px = 6px |
| 5 | **Reading-focused / Literature** | 69shu.com, biquge-type novel sites, Chinese Wikipedia (zh.wikipedia.org) | Long flowing text, minimal layout complexity, large font sizes, clean semantic HTML | The ideal case — should work well. Good baseline for "does it look good when nothing goes wrong?" |

### 6.2 Test Procedure Per Site

For each test site:

1. **Load page** with extension active and server running.
2. **Trigger annotation** via popup toggle or `Alt+A`.
3. **Visual inspection:**
   - Pinyin appears above Chinese characters.
   - Pinyin is legible and correctly positioned.
   - Phrase group spacing creates visible word boundaries.
   - Page layout is not significantly disrupted (minor line-height changes are acceptable).
   - Non-Chinese text is not annotated.
   - Punctuation is not annotated.
4. **Interaction testing:**
   - Text selection works (can select annotated text).
   - Copy-paste produces base text without pinyin (due to `user-select: none` on `<rt>`).
   - Scrolling is smooth (no jank from DOM changes).
   - Clicking links within annotated text still works.
5. **Double-annotation test:** Trigger annotation again. Verify no change occurs.
6. **Keyboard shortcut test:** Press `Alt+A` outside a text field. Verify annotation triggers. Press `Alt+A` inside a text field. Verify the shortcut is NOT intercepted.

### 6.3 Pass/Fail Criteria

- **Pass:** Pinyin renders correctly, page remains usable, no console errors, no double annotation.
- **Acceptable degradation:** Minor line-height changes, clipped pinyin in `overflow: hidden` containers, annotation of UI text (buttons, labels).
- **Fail:** Page layout completely breaks, JavaScript errors halt the page, pinyin renders in wrong position, double annotation occurs.

---

## 7. Known Risks and Gotchas

| Risk | Severity | Likelihood | Mitigation |
|---|---|---|---|
| Line-height inflation makes dense paragraphs hard to read | Medium | High (expected) | Accept as inherent to ruby. Users can toggle off. Consider a "compact mode" post-MVP that uses CSS `ruby-position: under`. |
| 6-7px pinyin on small-font sites is illegible | Medium | Medium | Default to 50%, let users configure up to 70%. Could auto-detect body font size and adjust ratio. |
| Host page `* { }` or `ruby { }` selectors override our styles | Medium | Medium | `!important` on critical properties. Attribute selectors (`[data-billy]`) for specificity. |
| Host page CSP blocks injected `<style>` element | Low | Low | Content scripts in MV2 can inject styles regardless of page CSP. Firefox grants extensions this privilege. |
| `Alt+A` conflicts with macOS special character input | Low | Medium | Guard against interception in text fields. Document in user-facing notes. |
| Annotation of very large pages (10,000+ text nodes) causes jank | Medium | Medium | Not in M4 scope directly, but style recalculation after injecting thousands of ruby elements can cause a layout thrash. Consider annotating in batches with `requestAnimationFrame` yielding between batches. |
| Ruby inside `<a>` tags may affect click targets | Low | Medium | The `<ruby>` and `<rt>` elements expand the clickable area vertically. This is generally fine — the link becomes easier to click. |
| Some sites dynamically replace content, removing our annotations | Medium | High (on SPAs) | Out of MVP scope. MutationObserver is listed as post-MVP. Users reload to re-annotate. |

---

## 8. Verification Steps

After M4 implementation, verify the following:

### Functional Verification
- [ ] `styles.css` is loaded and applied when the extension is active.
- [ ] `<ruby>` elements have `data-billy` attribute.
- [ ] `<rt>` renders at approximately 50% of parent font size (inspect computed styles).
- [ ] Phrase groups have visible spacing between them.
- [ ] `Alt+A` triggers annotation on a page with Chinese content.
- [ ] `Alt+A` does NOT trigger when focused in a text input or textarea.
- [ ] Triggering annotation twice does not produce double annotations.
- [ ] `data-billy-annotated` attribute is present on annotated containers.
- [ ] The DOM walker skips elements that already have `data-billy-annotated`.

### Visual Verification
- [ ] Test on at least one site from each of the 5 categories in the test matrix.
- [ ] Pinyin is legible at the site's default font size.
- [ ] Page scroll performance is acceptable (no visible jank).
- [ ] Text selection and copy-paste work as expected.
- [ ] Links within annotated text remain clickable.

### Regression Verification
- [ ] Extension popup toggle still works (M2 functionality).
- [ ] Annotation server communication still works (M3 functionality).
- [ ] Punctuation is still not annotated.
- [ ] Non-CJK text is still not annotated.
