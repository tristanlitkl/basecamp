FROM ghcr.io/astral-sh/uv:python3.12-bookworm-slim

WORKDIR /app

# Resolve production dependencies from the committed project metadata and lockfile.
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev

COPY . .

# Fail image construction before deployment if an application dependency is absent.
RUN uv run --frozen python -c "from langgraph.graph import END, START, StateGraph; print('langgraph import ok')"
RUN uv run --frozen python -c "import app.main; print('app import ok')"

CMD ["sh", "-c", "uv run --frozen uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-10000}"]
