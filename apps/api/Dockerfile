FROM python:3.12-slim

WORKDIR /app

RUN python -m pip install --no-cache-dir \
    "alembic>=1.13" \
    "asyncpg>=0.30" \
    "fastapi>=0.115" \
    "pydantic-settings>=2.6" \
    "pyjwt>=2.9" \
    "sqlalchemy>=2.0" \
    "uvicorn[standard]>=0.32"

COPY . .
CMD sh -c "python -m uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}"
