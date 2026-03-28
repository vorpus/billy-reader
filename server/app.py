import re
from contextlib import asynccontextmanager

import jieba
import pypinyin
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

# CJK Unicode ranges for detecting Chinese characters
_CJK_RE = re.compile(
    r"[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]"
)


def _contains_cjk(text: str) -> bool:
    return bool(_CJK_RE.search(text))


class AnnotateRequest(BaseModel):
    text: str = Field(..., max_length=5000)


class Segment(BaseModel):
    chars: str
    pinyin: list[str] | None
    phrase_boundary: bool


class AnnotateResponse(BaseModel):
    segments: list[Segment]


@asynccontextmanager
async def lifespan(app: FastAPI):
    jieba.initialize()
    yield


app = FastAPI(lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["POST", "GET", "OPTIONS"],
    allow_headers=["*"],
)


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/annotate", response_model=AnnotateResponse)
def annotate(req: AnnotateRequest):
    text = req.text
    if not text or text.isspace():
        return AnnotateResponse(segments=[])

    words = jieba.lcut(text)
    segments: list[Segment] = []

    for word in words:
        if _contains_cjk(word):
            py = pypinyin.pinyin(word, style=pypinyin.Style.TONE, heteronym=False)
            flat = [p[0] for p in py]
            segments.append(Segment(chars=word, pinyin=flat, phrase_boundary=True))
        else:
            segments.append(Segment(chars=word, pinyin=None, phrase_boundary=False))

    return AnnotateResponse(segments=segments)
