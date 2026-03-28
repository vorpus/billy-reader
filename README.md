# Billy Reader

A Firefox extension that adds pinyin annotations to Chinese text on web pages, backed by a local annotation service.

## Prerequisites

- [uv](https://docs.astral.sh/uv/) (Python package manager)

## Setup

```bash
uv sync
```

## Run the annotation service

```bash
uv run uvicorn server.app:app --reload --port 8000
```

The service runs at `http://localhost:8000`. API docs available at `http://localhost:8000/docs`.
