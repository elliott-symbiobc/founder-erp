# Built from the repository root so the image can carry sql/schema.sql, which
# the API applies to an empty database on first start (see app.main._init_db).
#   docker build -f api/Dockerfile .
FROM python:3.11-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
        gcc g++ curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY api/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY api/app/ ./app/
COPY sql/ ./sql/

EXPOSE 8000
CMD ["/bin/sh", "-c", "exec uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
