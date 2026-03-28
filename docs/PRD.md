# Chinese Reading Assistant
**Chrome Extension + Local Annotation Service**
Product Requirements Document — v0.1, March 2026

---

## Table of Contents
1. [Overview](#1-overview)
2. [Goals & Non-Goals](#2-goals--non-goals)
3. [User & Context](#3-user--context)
4. [System Architecture](#4-system-architecture)
5. [Feature Specifications](#5-feature-specifications)
6. [Data Flow](#6-data-flow)
7. [Configuration & Settings](#7-configuration--settings)
8. [Performance Requirements](#8-performance-requirements)
9. [Out of Scope / Future Work](#9-out-of-scope--future-work)

---

## 1. Overview

A browser-based Chinese reading annotation tool for users with partial Chinese reading ability who want in-context support while reading Chinese web content — without disrupting reading flow or requiring copy-paste into a separate app.

The system is split into two components:
- A **Chrome extension** that annotates page content in-place
- A **local annotation service** that does linguistic processing without sending any data to external servers

---

## 2. Goals & Non-Goals

### Goals
- Annotate Chinese text on any webpage with pinyin and phrase groupings, rendered inline using semantic HTML `<ruby>` tags
- Keep all processing local — no Chinese text leaves the user's machine
- Support on-demand LLM explanation for difficult sentences or grammar patterns
- Minimize latency: pinyin/segmentation should feel near-instant; LLM explanation is explicitly on-demand
- Allow toggling annotation on/off per page without a full reload

### Non-Goals (v1)
- Full machine translation of entire pages
- Non-Chinese language support
- Mobile browser support
- Cloud sync or user accounts
- OCR / image-based text extraction

---

## 3. User & Context

Single user with a Chinese background — can recognize many characters and knows common vocabulary, but encounters unfamiliar words/patterns regularly, especially in literary, formal, or internet-register text (e.g. anime subtitles, news, social media, novels).

**Primary use cases:**
- Reading Chinese subtitles or transcripts in the browser
- Reading Chinese news, social media, or forum posts
- Reading Chinese manga or novel sites

The user does not want a translation — they want to *read* the Chinese. The tool supports that process, not replaces it.

---

## 4. System Architecture

### 4.1 Overview

Two components communicating over localhost HTTP:

```
Browser (Chrome Extension)
  └── content.js        ← walks DOM, annotates text nodes
  └── popup.html/js     ← settings, toggle
  └── background.js     ← cache, service worker
        │
        │ HTTP (localhost)
        ▼
Local Annotation Service (FastAPI, Python)
  └── /annotate         ← jieba + pypinyin
  └── /explain          ← Ollama (Qwen2.5)
        │
        ▼
  Ollama (local LLM)
  └── Qwen2.5-7B (default)
  └── Qwen2.5-14B (optional, higher quality)
```

### 4.2 Local Annotation Service

A lightweight FastAPI server with two endpoints:

#### `POST /annotate`
Core annotation endpoint.

- **Input:** raw Chinese string
- **Processing:**
  - jieba segments the string into words/phrases
  - pypinyin maps each character to tone-marked pinyin, with polyphonic disambiguation (行, 中, 长, etc.)
- **Output:** structured JSON array of segments

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
    }
  ]
}
```

- **Target latency:** <100ms per sentence, <500ms per paragraph

#### `POST /explain`
On-demand LLM explanation endpoint.

- **Input:** sentence + optional user question (e.g. "why is 把 used here?")
- **Processing:** calls local Ollama with a structured prompt; response is streamed
- **Output:** plain-text explanation focused on grammar, word choice, or idiom meaning

### 4.3 Model Stack

| Component | Tool | Notes |
|---|---|---|
| Segmentation | jieba | Pure Python, no GPU, ~50MB |
| Pinyin | pypinyin | Tone disambiguation for polyphonics |
| LLM | Qwen2.5-7B via Ollama | Default; swap to 14B for higher quality |

No internet required after initial model download.

### 4.4 Chrome Extension Structure

```
extension/
├── manifest.json
├── content.js        ← DOM walker, ruby tag injector
├── background.js     ← service worker, response cache
├── popup.html        ← settings UI
├── popup.js
└── styles.css        ← ruby styling, phrase spacing, hover states
```

---

## 5. Feature Specifications

### 5.1 DOM Annotation

#### Text Node Extraction
- Walk all text nodes in the page body
- **Include:** nodes containing CJK characters (Unicode ranges `\u4E00–\u9FFF`, `\u3400–\u4DBF`, `\uF900–\uFAFF`, and fullwidth punctuation)
- **Exclude:** `<script>`, `<style>`, `<input>`, `<textarea>`, already-annotated nodes, nodes that are purely Latin/numeric/punctuation

#### Ruby Tag Rendering

Annotated text uses native HTML `<ruby>` elements — the semantic standard for character annotation, with browser-native alignment:

```html
<span class="phrase-group">
  <ruby>一<rt>yī</rt></ruby><ruby>想<rt>xiǎng</rt></ruby><ruby>到<rt>dào</rt></ruby>
</span>
<span class="phrase-group">
  <ruby>总<rt>zǒng</rt></ruby><ruby>有<rt>yǒu</rt></ruby><ruby>一<rt>yī</rt></ruby><ruby>天<rt>tiān</rt></ruby>
</span>
```

- Each jieba segment becomes a ruby group
- Phrase groups (contiguous segments forming a grammatical unit) are wrapped in `.phrase-group` spans with added letter-spacing for visual separation
- Punctuation is preserved inline, not annotated
- `<rt>` font size defaults to 50% of character size, configurable

#### Granularity Modes

| Mode | Behavior |
|---|---|
| Per-word (default) | Pinyin shown once per jieba segment |
| Per-character | Each character gets individual pinyin (useful for new vocab) |

Toggle via keyboard shortcut (`Alt+P`) or popup.

#### Caching

- Annotation results cached in `background.js` keyed by input string hash
- Avoids redundant requests for repeated phrases (very common in Chinese web content)
- Cache persisted in memory per session; not written to disk

### 5.2 On-Demand LLM Explanation

#### Trigger
- User selects/highlights a Chinese sentence or phrase on the page
- A small popover appears with an **Explain** button
- Optional: user types a specific question before submitting (e.g. "什么意思?" or "why is 把 used here?")
- Clicking Explain sends selected text + surrounding sentence context to `/explain`

#### Display
- Explanation streams into the popover in real time
- Popover is dismissible (click outside or Escape)
- No explanation is triggered automatically — always user-initiated

#### LLM Prompt Structure (server-side)

```
You are helping a Chinese learner understand a sentence.
The user can read Chinese but wants help with grammar, vocabulary, or nuance.
Do not translate the whole sentence unless asked.
Focus on: word meaning, grammar pattern, or why a particular structure is used.
Keep explanations concise (3–5 sentences max unless asked for more).

Sentence: {sentence}
Context: {surrounding_text}
Question: {user_question or "General explanation"}
```

### 5.3 Toggle & Controls

| Control | Action |
|---|---|
| Extension icon click | Open popup |
| Popup toggle | Enable/disable annotation on current tab |
| `Alt+P` | Toggle pinyin granularity (per-word ↔ per-character) |
| `Alt+A` | Toggle annotation on/off |
| Text selection | Triggers explain popover |

---

## 6. Data Flow

```
User loads page
    │
    ▼
content.js fires
    │
    ├── Extract all CJK text nodes
    ├── Batch into chunks (max ~500 chars per request)
    │
    ▼
POST /annotate (localhost)
    │
    ├── jieba.cut(text)
    ├── pypinyin.pinyin(chars, style=TONE)
    ├── Return segment array
    │
    ▼
content.js rebuilds DOM
    │
    ├── Replace text nodes with <ruby> + <span.phrase-group> markup
    └── Original text preserved as data-original attribute for toggle/restore

User highlights text
    │
    ▼
Popover appears → user clicks Explain
    │
    ▼
POST /explain (localhost)
    │
    ├── Build prompt with sentence + context + question
    ├── Stream response from Ollama (Qwen2.5-7B)
    │
    ▼
Popover streams explanation text
```

---

## 7. Configuration & Settings

Stored in `chrome.storage.sync` (local to device in v1):

| Setting | Default | Options |
|---|---|---|
| Annotation enabled | true | true/false |
| Granularity | per-word | per-word, per-character |
| Pinyin style | tone marks (ā á ǎ à) | tone marks, tone numbers (a1 a2 a3 a4), none |
| RT font size | 50% | 40%–70% |
| Phrase group spacing | 0.4em | 0–1em |
| LLM model | qwen2.5:7b | any Ollama model name |
| Service port | 8000 | configurable |
| Explanation max tokens | 300 | 100–1000 |

### Per-domain Overrides
- User can set per-domain defaults (e.g. always on for `mangadex.org`, off by default for everything else)

---

## 8. Performance Requirements

| Metric | Target |
|---|---|
| Annotation latency (single sentence) | <100ms |
| Annotation latency (full paragraph, ~300 chars) | <500ms |
| LLM explanation time-to-first-token | <2s |
| Extension DOM overhead | Invisible to user (async, non-blocking) |
| Memory footprint (extension) | <20MB |
| Local service idle RAM | <200MB (jieba + pypinyin loaded, no model) |
| Local service with Ollama | ~5–8GB (Qwen2.5-7B Q4) |

---

## 9. Out of Scope / Future Work

- **Traditional character support** — pypinyin handles this but jieba is optimized for simplified; worth testing
- **Vocabulary tracking** — log which words triggered pinyin lookups to build a personal word list
- **Anki export** — export unknown words as flashcard deck
- **Audio pronunciation** — TTS per segment on hover (local TTS model or browser SpeechSynthesis API)
- **Difficulty heatmap** — color-code characters by HSK level or personal familiarity
- **Firefox support**
- **Qwen-MT integration** — for sentences where a full translation is actually wanted
