# M3: DOM Walking + Annotation Rendering
**Expanded Design Document**
v0.1, March 2026

---

## Goal

Implement the core annotation pipeline in `content.js`: extract Chinese text nodes from the page DOM, send them to the local `/annotate` service in batched requests, and replace each text node with `<ruby>` markup showing pinyin above each character. This must work without breaking page layout, event listeners, or the structure of inline elements.

---

## Technical Decisions and Rationale

### 1. DOM Walking: TreeWalker wins

**Decision:** Use `document.createTreeWalker` with `NodeFilter.SHOW_TEXT`.

**Alternatives considered:**

| Approach | Pros | Cons |
|---|---|---|
| `TreeWalker` (SHOW_TEXT) | Native C++ iteration, memory-efficient (no intermediate array), built-in filtering via `acceptNode` callback | Slightly unfamiliar API |
| Recursive `childNodes` walk | Simple to understand | Manual recursion, must handle all node types yourself, slower on deep DOMs, risk of stack overflow on pathological pages |
| `querySelectorAll('*')` + iterate `.childNodes` | Familiar | Selects elements not text nodes -- still need inner loop. Creates a large static NodeList upfront. No way to filter at the query level. |
| XPath (`document.evaluate`) | Can select text nodes directly via `//text()` | Awkward iterator API, no filtering callback, less idiomatic in extension code |

**Why TreeWalker:**
- It is the purpose-built DOM API for iterating specific node types. With `SHOW_TEXT`, the browser's native code skips all non-text nodes internally -- we never see them.
- The `acceptNode` callback lets us reject nodes inside excluded ancestors (`<script>`, `<style>`, `<textarea>`, `<input>`, `<ruby>`, `<code>`, `<pre>`) without maintaining a manual skip list during traversal.
- It does not create an array of all matching nodes upfront -- it is a lazy iterator, so memory stays flat even on very large pages.
- This is the same approach used by established extensions that modify page text (e.g., the "Mark" text-highlighter library, translation extensions like Zhongwen, and accessibility tools like Clearly).

**Important caveat:** We must snapshot the text nodes into an array before mutating the DOM. If we call `walker.nextNode()` after replacing the current node, the walker's internal state becomes invalid. Collect first, mutate second.

### 2. Text Node Replacement: `parentNode.replaceChild` with a DocumentFragment

**Decision:** For each text node, build a `DocumentFragment` containing the annotated markup, then call `textNode.parentNode.replaceChild(fragment, textNode)`.

**Why not other approaches:**

| Approach | Problem |
|---|---|
| `innerHTML` on parent | Destroys all child elements and their event listeners. Absolute non-starter. |
| `Range.insertNode` | Designed for inserting at a point, not replacing a node. Awkward for full replacement. |
| Wrap text node in a `<span>`, then set `span.innerHTML` | Extra wrapper `<span>` around every text node adds DOM bloat. Also, inserting the wrapper via `insertBefore` + `removeChild` is two operations where `replaceChild` is one. |
| `textNode.replaceWith(...nodes)` | Modern API, clean syntax. However, `replaceWith` is slightly less compatible and does the same thing as `replaceChild` under the hood. Either works -- we go with `replaceChild` for explicitness. |

**Why DocumentFragment:**
- A DocumentFragment is a lightweight container that, when inserted into the DOM, "dissolves" -- only its children are inserted. No wrapper element remains.
- We build up the ruby elements and plain text nodes inside the fragment, then do a single `replaceChild` call. This is one reflow, not N.
- Event listeners on the *parent* element are unaffected because we are replacing a child text node, not the parent itself. Event listeners on sibling elements are also unaffected.

### 3. Handling Mixed Content (Chinese + English + Punctuation)

**Decision:** Send the entire text node content to `/annotate` and let the server handle segmentation. The server already returns punctuation and non-Chinese text as passthrough segments (segments with no pinyin). On the client side, we render each segment appropriately:

- Chinese segments: `<ruby>char<rt>pinyin</rt></ruby>` elements
- Non-Chinese segments (English words, punctuation, numbers, whitespace): plain `document.createTextNode()` calls

This means we do **not** need to split text nodes on the client before sending. The regex for detecting "has CJK" is only used as a gate to decide whether a text node is worth sending at all -- not for splitting.

**Why this is better than client-side splitting:**
- Simpler client code. One regex test per text node, not a complex tokenization pass.
- The server (jieba) handles boundary detection properly. Client-side regex splitting would get boundaries wrong at mixed-script transitions (e.g., "iPhone13很好用" -- jieba correctly keeps "iPhone13" as a passthrough and "很好用" as Chinese segments).
- Fewer API calls. A text node like "Hello 世界 Goodbye" is one request, not a request for just "世界".

### 4. Annotating Inside Inline Elements (`<a>`, `<strong>`, `<em>`, etc.)

**Decision:** Yes, annotate text nodes inside inline formatting elements. The TreeWalker naturally descends into them. Since we replace the *text node* (a child of the `<a>` or `<strong>`), the parent element and its styling are preserved. The ruby elements inherit the parent's computed styles (color, font-weight, font-style, text-decoration).

**Exclusion list (nodes whose text we skip):**
- `SCRIPT`, `STYLE` -- not visible text
- `TEXTAREA`, `INPUT` -- form controls, replacing their text nodes would break them
- `RUBY`, `RT`, `RP` -- already annotated (either by us or by the page itself)
- `CODE`, `PRE` -- likely programming content, not Chinese prose
- `SVG` -- text inside SVGs has different rendering rules
- Any element with class `billy-annotated` -- our own marker to prevent double-annotation

The check should walk up the ancestor chain of each text node (using a loop on `parentElement`) to see if any ancestor is in the exclusion set. This is cheap -- inline elements are rarely more than 3-4 levels deep.

### 5. Batch Concurrency: Promise Pool Pattern

**Decision:** Implement a simple "pool of 4" concurrency limiter using a queue and Promise chaining. No external library needed.

**Algorithm (pseudocode):**

```
function runPool(tasks, concurrency):
    let queue = [...tasks]
    let active = 0
    let resolve_all
    let promise = new Promise(r => resolve_all = r)

    function next():
        while active < concurrency and queue.length > 0:
            let task = queue.shift()
            active++
            task().then(result => {
                active--
                next()
            }).catch(err => {
                active--
                next()  // continue even on failure
            })
        if active == 0 and queue.length == 0:
            resolve_all()

    next()
    return promise
```

This is sometimes called a "promise pool" or "p-limit" pattern. It is ~15 lines of vanilla JS. Each "task" is a function that returns a Promise (the fetch + DOM replacement for one batch).

**Why not `Promise.all` with pre-split groups of 4:** That would wait for all 4 in a group to finish before starting the next group. If 3 requests finish fast and 1 is slow, we waste 3 slots. The pool pattern keeps all 4 slots busy continuously.

**Why not `Promise.allSettled`:** We do use `allSettled` semantics *within* the pool (continue on individual failure), but `allSettled` alone does not limit concurrency.

---

## DOM Walking Algorithm

**Pseudocode:**

```
function collectTextNodes():
    let validNodes = []
    let walker = document.createTreeWalker(
        document.body,
        NodeFilter.SHOW_TEXT,
        {
            acceptNode: function(node) {
                // Check ancestor chain for excluded elements
                let parent = node.parentElement
                while parent:
                    let tag = parent.tagName
                    if tag in EXCLUDED_TAGS:
                        return NodeFilter.FILTER_REJECT
                    if parent.classList.contains('billy-annotated'):
                        return NodeFilter.FILTER_REJECT
                    parent = parent.parentElement

                // Check if text contains CJK characters
                if CJK_REGEX.test(node.textContent):
                    return NodeFilter.FILTER_ACCEPT
                else:
                    return NodeFilter.FILTER_REJECT
            }
        }
    )

    while walker.nextNode():
        validNodes.push(walker.currentNode)

    return validNodes
```

**Note on `FILTER_REJECT` vs `FILTER_SKIP`:** For `SHOW_TEXT`, this distinction does not matter because text nodes have no children. Both result in the node being excluded. We use `REJECT` for clarity of intent.

**CJK regex:** `/[\u4E00-\u9FFF\u3400-\u4DBF\uF900-\uFAFF]/` -- matches if the text contains at least one CJK Unified Ideograph. This intentionally does not include CJK punctuation in the match -- a text node of purely Chinese punctuation like "，。！" does not need annotation (though if it appears alongside characters, the server handles it as a passthrough segment).

---

## Text Batching and Response Mapping Strategy

### Batching

We need to group text nodes into batches of roughly 500 characters for the API, but each text node must remain individually addressable so we can replace it in the DOM.

**Data structure for a batch:**

```
batch = {
    nodes: [textNode1, textNode2, ...],
    offsets: [0, 45, 128, ...],   // character offset where each node's text starts in the combined string
    combined: "node1text\x00node2text\x00node3text"  // joined with a sentinel
}
```

**Sentinel character:** We join node texts with `\x00` (null byte) which cannot appear in normal page text. The server's jieba segmentation will treat it as a boundary. In the response, any segment containing `\x00` tells us we have crossed a node boundary.

**Alternative approach (simpler, recommended):** Instead of a sentinel, send each text node's content as a separate entry in an array, and have the server return a parallel array of segment lists. This avoids the sentinel/offset mapping entirely.

Revised API contract for batching:

```
Request:  { "texts": ["node1text", "node2text", "node3text"] }
Response: { "results": [ {segments: [...]}, {segments: [...]}, {segments: [...]} ] }
```

Each entry in the response maps 1:1 to the input entry, which maps 1:1 to a DOM text node. No offset math needed. The server iterates over the array, runs jieba + pypinyin on each string, returns the parallel array.

**This requires a small change to the M1 API surface:** add an optional `texts` array field alongside the existing `text` string field. When `texts` is provided, the response uses `results` (array of segment arrays) instead of `segments`. This is backward-compatible.

**Batch formation algorithm:**

```
function batchNodes(nodes, maxChars):
    let batches = []
    let current = { nodes: [], totalChars: 0 }

    for node in nodes:
        let len = node.textContent.length
        if current.totalChars + len > maxChars and current.nodes.length > 0:
            batches.push(current)
            current = { nodes: [], totalChars: 0 }
        current.nodes.push(node)
        current.totalChars += len

    if current.nodes.length > 0:
        batches.push(current)

    return batches
```

A single text node longer than 500 chars gets its own batch. This is fine -- the server can handle it.

---

## Ruby Markup Generation

For each text node, given its array of segments from the API response:

**Pseudocode:**

```
function buildAnnotatedFragment(segments):
    let fragment = document.createDocumentFragment()
    let currentPhraseGroup = null

    for segment in segments:
        if segment.pinyin and segment.pinyin.length > 0:
            // Chinese segment -- create ruby elements
            if segment.phrase_boundary or currentPhraseGroup == null:
                // Start a new phrase group
                currentPhraseGroup = document.createElement('span')
                currentPhraseGroup.className = 'billy-phrase-group'
                fragment.appendChild(currentPhraseGroup)

            for i, char in enumerate(segment.chars):
                let ruby = document.createElement('ruby')
                ruby.textContent = char
                let rt = document.createElement('rt')
                rt.textContent = segment.pinyin[i]
                ruby.appendChild(rt)
                currentPhraseGroup.appendChild(ruby)
        else:
            // Non-Chinese segment (punctuation, English, whitespace)
            currentPhraseGroup = null  // break phrase grouping
            fragment.appendChild(document.createTextNode(segment.chars))

    return fragment
```

**Then replace the original text node:**

```
let wrapper = document.createElement('span')
wrapper.className = 'billy-annotated'
wrapper.appendChild(fragment)
textNode.parentNode.replaceChild(wrapper, textNode)
```

We do add one wrapper `<span class="billy-annotated">` per text node. This serves double duty: it marks the node as already-annotated (preventing double-processing), and it gives us a handle for potential future toggle/restore. The `<span>` is inline and should not affect layout.

**Preserving original text:** Store the original string as `wrapper.dataset.original = textNode.textContent`. This is lighter than keeping a reference to the old text node and supports future restore-without-reload.

---

## Error Handling

### Service Not Running (Connection Refused)

- Before walking the DOM, do a fast `fetch('http://localhost:8000/health')` with a 2-second timeout.
- If it fails, log a warning to the console and do nothing. Do not walk the DOM, do not modify the page.
- Show a subtle indicator in the extension popup (e.g., "Service not running" status line). This can be communicated via `browser.runtime.sendMessage` to the popup.

### Individual Batch Failure

- If a single batch fetch fails (network error, 500, timeout), skip that batch. The corresponding text nodes remain unmodified.
- Log the error with the batch index and character count for debugging.
- Continue processing other batches -- do not abort the whole page.

### Malformed API Response

- Validate that the response has a `results` array of the expected length.
- If a single result entry is malformed (missing segments, wrong length), skip that text node.
- If the entire response is malformed, treat it as a batch failure.

### Timeout

- Set a per-request timeout of 5 seconds using `AbortController`.
- A 500-char batch should return in under 500ms per the performance requirements, so 5s is generous and only guards against hangs.

### Already-Annotated Pages

- The `billy-annotated` class check in the TreeWalker filter prevents double-annotation if the user triggers annotation twice.

---

## Known Risks and Gotchas

### 1. DOM Mutation During Collection

If the page modifies its own DOM between when we collect text nodes and when we replace them, a collected text node may no longer be in the document. **Mitigation:** Before calling `replaceChild`, check that `textNode.parentNode` is not null. If it is, skip the node.

### 2. Very Large Pages

A page with 50,000+ Chinese characters (e.g., a full novel chapter) could produce 100+ batches. At 4 concurrent requests, this takes 25+ round trips. **Mitigation:** Consider annotating only visible content first (using `IntersectionObserver` or `getBoundingClientRect` against the viewport). This is a post-MVP optimization but worth noting. For MVP, we process everything and accept the latency.

### 3. `<ruby>` Elements Change Text Flow

Ruby annotations add vertical space above the text line. This can:
- Push content below downward, causing layout shift
- Break tightly-constrained flex/grid layouts
- Make lines of text taller, causing overflow in fixed-height containers

**Mitigation (M4 concern, but noted here):** The `rt` element should have `font-size: 50%` and `line-height: 1` to minimize vertical impact. We can also set `ruby-position: over` explicitly. Full layout fix work belongs in M4.

### 4. Content Security Policy (CSP)

Some pages set strict CSP. Since we are creating DOM elements programmatically (not injecting HTML strings via `innerHTML`), CSP should not block us. We do not use `eval`, inline scripts, or `innerHTML` in the annotation path. This is a deliberate benefit of the DocumentFragment approach.

### 5. Fetch from Content Script to Localhost

In Firefox MV2, content scripts can use `fetch` but the request origin is the page's origin, not the extension's. This means:
- The FastAPI server's CORS middleware must allow all origins (already decided in design.md: `allow_origins=["*"]`).
- Some pages with aggressive CSP `connect-src` directives could block the fetch. **Mitigation:** If this becomes an issue, we can route through a background script (which is not subject to page CSP). For MVP, direct fetch with permissive CORS should work for the vast majority of pages.
- `manifest.json` must include `"permissions": ["http://localhost:8000/*"]` to allow the content script to make cross-origin requests to localhost.

### 6. Shadow DOM

Text inside Shadow DOM (used by web components) is not reachable by a TreeWalker rooted at `document.body`. **Mitigation:** Out of scope for MVP. Most Chinese content sites do not use Shadow DOM heavily. If needed later, we can query for elements with `shadowRoot` and walk each shadow tree separately.

### 7. Race Condition: User Navigates Away Mid-Annotation

If the user navigates while fetches are in-flight, the responses will try to modify a detached DOM. **Mitigation:** The `parentNode == null` check before `replaceChild` handles this gracefully. The fetch promises resolve/reject harmlessly against a dead page.

---

## Verification Steps

1. **Basic annotation**: Load a simple Chinese webpage (e.g., a news article). Trigger annotation. Confirm pinyin appears above Chinese characters in ruby tags.

2. **Mixed content**: Load a page with mixed Chinese/English text. Confirm English text and punctuation are not wrapped in `<ruby>` tags but remain in place.

3. **Inline elements preserved**: Find a page with Chinese text inside `<a>` and `<strong>` tags. Confirm the links still work and bold styling is preserved after annotation.

4. **Excluded elements**: Confirm text inside `<script>`, `<style>`, `<textarea>`, `<code>`, and existing `<ruby>` tags is not modified.

5. **No double annotation**: Trigger annotation twice on the same page. Confirm no duplicate pinyin appears.

6. **Service down**: Stop the FastAPI server, trigger annotation. Confirm the page is not modified and no errors are thrown to the user. Check console for a clear warning.

7. **Partial failure**: Annotate a page with many text nodes, then kill the server mid-annotation. Confirm some nodes are annotated (from completed batches) and remaining nodes are left untouched.

8. **Event listeners**: On a page with clickable Chinese text (e.g., links, buttons), annotate and confirm the click handlers still work.

9. **Performance**: On a text-heavy page (~5000 Chinese characters), measure time from annotation trigger to completion. Should be under 3 seconds with the local service running.

10. **Large text node**: Create a test page with a single `<p>` containing 2000 Chinese characters. Confirm it is split into multiple batches and annotated correctly with no missing or duplicated text.
