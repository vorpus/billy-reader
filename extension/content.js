const SERVICE_URL = "http://localhost:8000";
const MAX_BATCH_CHARS = 500;
const MAX_CONCURRENT = 4;
const FETCH_TIMEOUT_MS = 5000;
const CJK_RE = /[\u4E00-\u9FFF\u3400-\u4DBF\uF900-\uFAFF]/;
const EXCLUDED_TAGS = new Set([
  "SCRIPT", "STYLE", "TEXTAREA", "INPUT", "RUBY", "RT", "RP", "CODE", "PRE", "SVG",
]);

let enabled = false;
let annotating = false;
let isAnnotated = false;
let observer = null;
const OBSERVER_DEBOUNCE_MS = 200;

// --- Message handling (M2 plumbing) ---

browser.runtime.onMessage.addListener((message) => {
  if (message.type === "GET_STATE") {
    return Promise.resolve({ enabled });
  }

  if (message.type === "TOGGLE") {
    enabled = !enabled;
    if (enabled && !annotating) {
      annotate();
    }
    return Promise.resolve({ enabled });
  }
});

// --- DOM walking ---

function collectTextNodes(root = document.body) {
  const nodes = [];
  const walker = document.createTreeWalker(
    root,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        let el = node.parentElement;
        while (el) {
          if (EXCLUDED_TAGS.has(el.tagName)) return NodeFilter.FILTER_REJECT;
          if (el.hasAttribute("data-billy-annotated")) return NodeFilter.FILTER_REJECT;
          el = el.parentElement;
        }
        return CJK_RE.test(node.textContent)
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT;
      },
    }
  );

  while (walker.nextNode()) {
    nodes.push(walker.currentNode);
  }
  return nodes;
}

// --- Batching ---

function batchNodes(nodes) {
  const batches = [];
  let current = { nodes: [], totalChars: 0 };

  for (const node of nodes) {
    const len = node.textContent.length;
    if (current.totalChars + len > MAX_BATCH_CHARS && current.nodes.length > 0) {
      batches.push(current);
      current = { nodes: [], totalChars: 0 };
    }
    current.nodes.push(node);
    current.totalChars += len;
  }

  if (current.nodes.length > 0) {
    batches.push(current);
  }
  return batches;
}

// --- Concurrency pool ---

function runPool(tasks, concurrency) {
  const queue = [...tasks];
  let active = 0;

  return new Promise((resolve) => {
    function next() {
      while (active < concurrency && queue.length > 0) {
        const task = queue.shift();
        active++;
        task()
          .catch((err) => console.warn("Billy Reader: batch failed", err))
          .finally(() => {
            active--;
            next();
          });
      }
      if (active === 0 && queue.length === 0) {
        resolve();
      }
    }
    next();
  });
}

// --- Ruby markup generation ---

function buildAnnotatedFragment(segments) {
  const fragment = document.createDocumentFragment();

  for (const seg of segments) {
    if (seg.pinyin && seg.pinyin.length > 0) {
      const group = document.createElement("span");
      group.className = "billy-phrase-group";

      for (let i = 0; i < seg.chars.length; i++) {
        const ruby = document.createElement("ruby");
        ruby.setAttribute("data-billy", "");
        ruby.textContent = seg.chars[i];
        const rt = document.createElement("rt");
        rt.setAttribute("data-billy", "");
        rt.textContent = seg.pinyin[i] || "";
        ruby.appendChild(rt);
        group.appendChild(ruby);
      }

      fragment.appendChild(group);
    } else {
      fragment.appendChild(document.createTextNode(seg.chars));
    }
  }

  return fragment;
}

function replaceTextNode(textNode, segments) {
  if (!textNode.parentNode) return;

  const wrapper = document.createElement("span");
  wrapper.setAttribute("data-billy-annotated", "");
  wrapper.dataset.original = textNode.textContent;
  wrapper.appendChild(buildAnnotatedFragment(segments));
  textNode.parentNode.replaceChild(wrapper, textNode);
}

// --- Fetch ---

async function fetchAnnotations(texts) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const resp = await fetch(`${SERVICE_URL}/annotate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ texts }),
      signal: controller.signal,
    });

    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}`);
    }

    const data = await resp.json();
    return data.results;
  } finally {
    clearTimeout(timeout);
  }
}

// --- Core annotation pipeline ---

async function annotateNodes(textNodes) {
  if (textNodes.length === 0) return;

  const batches = batchNodes(textNodes);

  const tasks = batches.map((batch) => async () => {
    const texts = batch.nodes.map((n) => n.textContent);
    const results = await fetchAnnotations(texts);

    if (!results || results.length !== batch.nodes.length) {
      console.warn("Billy Reader: response/node count mismatch");
      return;
    }

    for (let i = 0; i < batch.nodes.length; i++) {
      replaceTextNode(batch.nodes[i], results[i]);
    }
  });

  await runPool(tasks, MAX_CONCURRENT);
}

async function checkHealth() {
  const resp = await fetch(`${SERVICE_URL}/health`, {
    signal: AbortSignal.timeout(2000),
  }).catch(() => null);
  return resp?.ok ?? false;
}

// --- Main annotation flow ---

async function annotate() {
  if (isAnnotated || annotating) return;
  annotating = true;

  try {
    if (!await checkHealth()) {
      console.warn("Billy Reader: annotation service not running");
      return;
    }

    await annotateNodes(collectTextNodes());
    isAnnotated = true;
    startObserver();
  } finally {
    annotating = false;
  }
}

// --- MutationObserver for dynamic content ---

function startObserver() {
  if (observer) return;

  let pendingNodes = [];
  let debounceTimer = null;

  observer = new MutationObserver((mutations) => {
    if (!enabled) return;

    for (const mutation of mutations) {
      for (const added of mutation.addedNodes) {
        if (added.nodeType === Node.TEXT_NODE) {
          if (CJK_RE.test(added.textContent) && !added.parentElement?.hasAttribute("data-billy-annotated")) {
            pendingNodes.push(added);
          }
        } else if (added.nodeType === Node.ELEMENT_NODE) {
          if (added.hasAttribute("data-billy-annotated")) continue;
          pendingNodes.push(...collectTextNodes(added));
        }
      }
    }

    if (pendingNodes.length > 0) {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        const nodes = pendingNodes.filter((n) => n.parentNode != null);
        pendingNodes = [];
        if (nodes.length > 0) {
          annotateNodes(nodes);
        }
      }, OBSERVER_DEBOUNCE_MS);
    }
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
  });
}

// --- Keyboard shortcut: Alt+A ---

document.addEventListener("keydown", (e) => {
  if (!e.altKey || e.code !== "KeyA") return;

  const tag = document.activeElement?.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || document.activeElement?.isContentEditable) {
    return;
  }

  e.preventDefault();
  e.stopPropagation();

  if (!isAnnotated && !annotating) {
    enabled = true;
    annotate();
  }
}, true);
