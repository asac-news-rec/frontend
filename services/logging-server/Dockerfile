FROM python:3.11-slim-bookworm AS verify
WORKDIR /service
COPY requirements*.txt ./
RUN pip install --no-cache-dir -r requirements-dev.txt
COPY logging_service ./logging_service
COPY python_tests ./python_tests
RUN python -m compileall -q logging_service && python -m pytest python_tests -q
FROM python:3.11-slim-bookworm
WORKDIR /service
ENV LOGGING_HOST=0.0.0.0 LOGGING_PORT=4195 LOGGING_DB=/service/data/inbox.sqlite LOGGING_EXPORT_DIR=/service/data/objects PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt && useradd --uid 1000 --create-home logging && mkdir /service/data && chown logging:logging /service/data
COPY --from=verify /service/logging_service ./logging_service
USER logging
EXPOSE 4195
CMD ["python","-m","logging_service"]
