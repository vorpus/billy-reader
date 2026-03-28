# M1: Python Annotation Service — Expanded Design
v0.1, March 2026

---

## Goal

Ship a local FastAPI server that accepts Chinese text and returns word-segmented pinyin annotations. This is the foundation for the entire reading experience: every subsequent milestone depends on this service returning accurate, well-structured data with low latency.

---

## Technical Decisions and Rationale

### Stack: FastAPI + jieba + pypinyin

This is the right stack for MVP. Here is the evaluation of each component and its alternatives.

#### Segmentation: jieba

**Choice: jieba (precise mode)**

jieba is the correct default for this use case. The key considerations:

| Library | Accuracy | Speed | Install size | Maintenance | Notes |
|---------|----------|-------|-------------|-------------|-------|
| jieba | Good (F1 ~95% on MSR corpus) | Fast after cold start | ~50MB (dictionary) | Stable, low churn | De facto standard, huge community |
| pkuseg | Better on formal text (~97% F1) | 3-5x slower than jieba | ~100MB+ with models | PKU-maintained, less community | Better accuracy but slower; has domain-specific models |
| stanza (Stanford NLP) | High | Much slower (neural model) | 200MB+ | Active | Overkill for pinyin annotation; designed for full NLP pipelines |
| LAC (Baidu) | Good | Fast | ~50MB | Baidu-maintained | Also does POS tagging; Paddle dependency is heavy |
| HanLP | High | Moderate | Large | Active | Java-based core with Python bindings; complex dependency |

**Why jieba wins for MVP:**
- For reading annotation, segmentation does not need to be perfect. A slightly wrong word boundary still produces correct per-character pinyin — the reader can still understand the text. The cost of a segmentation error is low (a word boundary is in the wrong place), not high (wrong pinyin).
- jieba's speed matters: we need <100ms per sentence. pkuseg is measurably slower.
- jieba is pure Python with no compiled dependencies beyond the standard library. This keeps `uv` installation trivial.
- If segmentation quality becomes a real problem on specific text types, we can swap to pkuseg later with zero API changes — the segmenter is an internal implementation detail.

**jieba mode choice: precise mode (`cut_all=False`, the default)**
- `cut_all=True` (full mode) produces overlapping segments — useless for annotation.
- Default/precise mode produces non-overlapping segments optimized for search/NLP.
- `cut_for_search` produces sub-segments of long words — also wrong for our use case, as it would double-annotate characters.
- Precise mode is what we want: one segmentation of the input with no overlaps.

#### Pinyin: pypinyin

**Choice: pypinyin with `Style.TONE` (tone-marked output)**

pypinyin is the only serious Python library for pinyin conversion. There is no real alternative. The key API details:

**Polyphonic character handling:**
pypinyin handles polyphonic characters (多音字) using a built-in phrase-pinyin dictionary. For common words, it is accurate:
- 行 in 银行 → "háng", in 行走 → "xíng"
- 长 in 长大 → "zhǎng", in 长江 → "cháng"
- 中 in 中国 → "zhōng", in 打中 → "zhòng"

**Known limitations with polyphonics:**
- pypinyin's disambiguation depends on its internal phrase dictionary. For rare or novel word combinations not in the dictionary, it falls back to the most common reading, which can be wrong.
- Accuracy for common polyphonics is estimated at ~95%+. For rare or literary text, it degrades.
- The `heteronym=True` flag returns all possible readings but that is not useful for annotation — we need a single best reading.
- **Mitigation for MVP:** Accept the ~95% accuracy. For the target user (someone with Chinese background), a wrong tone on a rare polyphonic is noticeable but not blocking. Post-MVP, we could feed jieba's segmentation context into pypinyin for better disambiguation.

**Critical API detail — feeding segmented words to pypinyin:**
pypinyin performs its own internal segmentation for polyphonic disambiguation. To get the best results, we should call `pypinyin.pinyin()` on each jieba segment individually (not on the full unsegmented string), because:
1. jieba's segmentation gives pypinyin word boundaries it can use for disambiguation.
2. Calling on the full string means pypinyin does its own (different) segmentation internally, which may conflict with jieba's boundaries.

The call pattern is:
```
pypinyin.pinyin(segment, style=Style.TONE, heteronym=False)
```
This returns a list of `[pinyin_string]` for each character. `Style.TONE` produces tone-marked vowels (e.g., "zhōng", "guó").

#### Server: FastAPI + uvicorn

No change from the design doc. FastAPI is the right choice:
- Automatic request validation via Pydantic
- Built-in OpenAPI docs at `/docs` (useful during development)
- Async support (though our CPU-bound work is synchronous)
- `CORSMiddleware` built in

---

## API Contract

### `POST /annotate`

#### Request

```json
{
  "text": "一想到总有一天会失去你，我就感到害怕。"
}
```

- `text`: a single string, max 5000 characters. The extension batches text nodes into ~500 char chunks, but we allow larger inputs for flexibility.
- Single string, not a batch. Rationale: the extension already batches into chunks and sends up to 4 concurrent requests. Adding a batch array to the API adds complexity without benefit — HTTP pipelining over localhost is essentially free. Keep the API simple.

#### Response

```json
{
  "segments": [
    {
      "chars": "一想到",
      "pinyin": ["yī", "xiǎng", "dào"],
      "phrase_boundary": true
    },
    {
      "chars": "总有一天",
      "pinyin": ["zǒng", "yǒu", "yī", "tiān"],
      "phrase_boundary": true
    },
    {
      "chars": "会",
      "pinyin": ["huì"],
      "phrase_boundary": true
    },
    {
      "chars": "失去",
      "pinyin": ["shī", "qù"],
      "phrase_boundary": true
    },
    {
      "chars": "你",
      "pinyin": ["nǐ"],
      "phrase_boundary": true
    },
    {
      "chars": "，",
      "pinyin": null,
      "phrase_boundary": false
    },
    {
      "chars": "我",
      "pinyin": ["wǒ"],
      "phrase_boundary": true
    },
    {
      "chars": "就",
      "pinyin": ["jiù"],
      "phrase_boundary": true
    },
    {
      "chars": "感到",
      "pinyin": ["gǎn", "dào"],
      "phrase_boundary": true
    },
    {
      "chars": "害怕",
      "pinyin": ["hài", "pà"],
      "phrase_boundary": true
    },
    {
      "chars": "。",
      "pinyin": null,
      "phrase_boundary": false
    }
  ]
}
```

Rules:
- Every character in the input appears in exactly one segment. No characters are dropped or duplicated.
- `pinyin` is a list of tone-marked strings, one per character in `chars`. Length of `pinyin` always equals length of `chars`.
- For non-Chinese segments (punctuation, whitespace, English text), `pinyin` is `null`.
- `phrase_boundary` is `true` for Chinese word segments, `false` for punctuation/whitespace. This tells the extension where to add visual spacing.

#### Error responses

| Status | When | Body |
|--------|------|------|
| 400 | `text` field missing or not a string | `{"detail": "text field is required and must be a string"}` |
| 400 | `text` exceeds 5000 characters | `{"detail": "text exceeds maximum length of 5000 characters"}` |
| 422 | Malformed JSON (FastAPI default) | Pydantic validation error |
| 500 | Unexpected error in segmentation/pinyin | `{"detail": "internal annotation error"}` |

### `GET /health`

Returns `{"status": "ok"}`. Used by the extension to check if the service is running before attempting annotation. No authentication, no parameters.

---

## Implementation Details

### Detecting Chinese vs. non-Chinese text

When jieba segments a string, it returns a mix of Chinese words, punctuation, numbers, English words, and whitespace. We need to classify each segment to decide whether to generate pinyin or pass through.

**Classification approach:** Check each segment character-by-character against CJK Unicode ranges:

```
CJK Unified Ideographs:           U+4E00–U+9FFF
CJK Unified Ideographs Ext A:     U+3400–U+4DBF
CJK Compatibility Ideographs:     U+F900–U+FAFF
```

A segment is "Chinese" if it contains at least one character in these ranges. Everything else (punctuation, Latin text, numbers, whitespace, fullwidth punctuation) is passed through with `pinyin: null`.

**Punctuation and whitespace specifics:**
- Chinese punctuation (fullwidth): `\u3000-\u303F`, `\uFF00-\uFFEF` — includes `，。！？；：""''【】`
- ASCII punctuation: standard range `\u0020-\u007F`
- jieba generally keeps punctuation as separate segments, but may attach whitespace to adjacent tokens. We should strip and re-emit whitespace as its own segment if needed.

**Mixed Chinese/English in one segment:**
jieba handles mixed text reasonably — English words and numbers are typically emitted as separate segments. For example, `"我用Python写代码"` segments as `["我", "用", "Python", "写", "代码"]`. No special handling needed; the CJK detection per-segment handles this naturally.

### Processing pipeline (pseudocode)

```
function annotate(text):
    segments = jieba.lcut(text)           # returns list of strings
    result = []
    for seg in segments:
        if contains_cjk(seg):
            py = pypinyin.pinyin(seg, style=Style.TONE, heteronym=False)
            # py is [[pinyin1], [pinyin2], ...] — one list per character
            flat_pinyin = [p[0] for p in py]
            result.append({chars: seg, pinyin: flat_pinyin, phrase_boundary: True})
        else:
            result.append({chars: seg, pinyin: None, phrase_boundary: False})
    return {segments: result}
```

### Cold start: jieba dictionary loading

**The problem:** The first call to `jieba.cut()` or `jieba.lcut()` triggers a dictionary load from disk. This takes 0.5-1.5 seconds depending on disk speed (it reads a ~50MB dictionary file and builds a prefix dictionary in memory).

**Solution:** Call `jieba.initialize()` at module import time (in `app.py` top level or in a startup event). This moves the cold start to server boot rather than first request. FastAPI has a `lifespan` context manager or `@app.on_event("startup")` for this.

```
# At server startup:
jieba.initialize()  # Forces dictionary load immediately
```

After initialization, subsequent calls to `jieba.lcut()` are fast (<10ms for typical sentences).

### uvicorn + jieba: concurrency considerations

**Thread safety:** jieba is thread-safe for `cut`/`lcut` after initialization. The dictionary is read-only once loaded. pypinyin is also effectively thread-safe (read-only lookups against its internal dictionaries).

**GIL and CPU-bound work:** Both jieba and pypinyin are CPU-bound pure Python. Under uvicorn with async handlers, CPU-bound work blocks the event loop. Two options:

1. **Sync endpoint (recommended for MVP):** Define the endpoint as a regular `def` (not `async def`). FastAPI automatically runs sync endpoints in a thread pool, preventing event loop blocking. This is the simplest correct approach.

2. **Async with `run_in_executor`:** Define as `async def` and explicitly run the CPU work in a thread pool. More boilerplate for no real benefit at MVP scale.

**Recommendation:** Use a sync `def` endpoint. FastAPI's default thread pool (40 threads) is more than enough for a single-user local tool.

**Workers:** Run uvicorn with a single worker (the default). Multiple workers would each load their own jieba dictionary (~150MB RSS per worker). For a single-user local tool, one worker is sufficient.

### Pydantic models

```
class AnnotateRequest(BaseModel):
    text: str = Field(..., max_length=5000)

class Segment(BaseModel):
    chars: str
    pinyin: list[str] | None
    phrase_boundary: bool

class AnnotateResponse(BaseModel):
    segments: list[Segment]
```

---

## Known Risks and Gotchas

### 1. Polyphonic accuracy on literary/unusual text
**Risk:** pypinyin's polyphonic disambiguation relies on a finite phrase dictionary. Literary Chinese, internet slang, or novel word combinations may get wrong readings.
**Impact:** Low for MVP user — the user has Chinese background and will recognize when pinyin is wrong for a given context.
**Mitigation:** Accept for now. Post-MVP option: use pypinyin's `phrases_dict` to add custom overrides, or integrate a neural pinyin model.

### 2. jieba segmentation of classical/literary Chinese
**Risk:** jieba is trained on modern simplified Chinese. Classical Chinese (文言文), traditional characters, or very colloquial internet text may segment poorly.
**Impact:** Segmentation errors shift word boundaries but do not produce wrong pinyin per-character. Visual grouping may look odd.
**Mitigation:** Accept for MVP. If this becomes a real problem, pkuseg or a custom dictionary can be swapped in.

### 3. Edge case: CJK characters outside the common ranges
**Risk:** Rare characters in CJK Extension B (`U+20000-U+2A6DF`) or later extensions are not in the basic detection ranges. These are extremely rare in web content.
**Mitigation:** Ignore for MVP. Expand Unicode ranges if users hit this.

### 4. Empty or whitespace-only input
**Risk:** `jieba.lcut("")` returns `[""]` (a list with one empty string). This should not crash but could produce a confusing empty segment.
**Mitigation:** Check for empty/whitespace-only input and return `{"segments": []}`.

### 5. Very long input strings
**Risk:** A malformed or misbehaving extension could send very large strings. jieba handles large strings fine but response size grows linearly.
**Mitigation:** Enforce the 5000-character limit at the Pydantic validation level. The extension already batches at ~500 chars, so 5000 provides generous headroom.

### 6. Numbers and special characters within Chinese text
**Risk:** Strings like `"2024年3月28日"` need the numbers passed through and the Chinese characters annotated. jieba segments this as `["2024", "年", "3", "月", "28", "日"]`, which is correct — the CJK detection handles each segment individually.
**Mitigation:** No special handling needed. The existing pipeline handles this correctly.

---

## Verification Steps

1. **Server starts cleanly:**
   ```
   uv run uvicorn app:app --port 8000
   ```
   Server starts without errors. Check that jieba initialization completes during startup (log message or timing).

2. **Health check:**
   ```
   curl http://localhost:8000/health
   → {"status":"ok"}
   ```

3. **Basic annotation:**
   ```
   curl -X POST http://localhost:8000/annotate \
     -H "Content-Type: application/json" \
     -d '{"text":"一想到总有一天"}'
   ```
   Verify: returns segments for "一想到" and "总有一天" with correct pinyin.

4. **Polyphonic disambiguation:**
   ```
   curl -X POST http://localhost:8000/annotate \
     -H "Content-Type: application/json" \
     -d '{"text":"我去银行行不行"}'
   ```
   Verify: 银行 → "yín háng", 行不行 → "xíng bù xíng". The two uses of 行 should have different readings.

5. **Punctuation passthrough:**
   ```
   curl -X POST http://localhost:8000/annotate \
     -H "Content-Type: application/json" \
     -d '{"text":"你好，世界！"}'
   ```
   Verify: "，" and "！" appear as segments with `pinyin: null`.

6. **Mixed Chinese/English:**
   ```
   curl -X POST http://localhost:8000/annotate \
     -H "Content-Type: application/json" \
     -d '{"text":"我用Python写代码"}'
   ```
   Verify: "Python" appears as a segment with `pinyin: null`. Chinese words have correct pinyin.

7. **Empty input:**
   ```
   curl -X POST http://localhost:8000/annotate \
     -H "Content-Type: application/json" \
     -d '{"text":""}'
   ```
   Verify: returns `{"segments": []}`.

8. **CORS headers present:**
   ```
   curl -v -X OPTIONS http://localhost:8000/annotate \
     -H "Origin: moz-extension://fake-id" \
     -H "Access-Control-Request-Method: POST"
   ```
   Verify: response includes `Access-Control-Allow-Origin: *`.

9. **Latency check:**
   Send a paragraph of ~300 characters. Verify response time is under 500ms (excluding the very first request if jieba isn't pre-initialized).

---

## File Listing

```
server/
└── app.py              # FastAPI application: /annotate, /health, CORS, startup init

pyproject.toml          # Project metadata + dependencies:
                        #   fastapi, uvicorn, jieba, pypinyin
```

Both files live at the repository root level (`pyproject.toml`) and in a `server/` subdirectory (`app.py`), as specified in the main design doc.
