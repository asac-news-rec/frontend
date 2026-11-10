import asyncio
import hmac
import json
import logging
import os
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Annotated

from fastapi import Body, Depends, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, ConfigDict, Field
from starlette.concurrency import run_in_threadpool

from .exporter import Exporter, LocalSink
from .schema import InputError, identifier
from .store import Store

ROOT = Path(__file__).resolve().parents[1]
MAX_BODY = 262144
logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class Settings:
    token: str
    database: str = str(ROOT / "data/inbox.sqlite")
    export_dir: str = str(ROOT / "data/objects")
    flush_ms: int = 30000
    max_records: int = 100000

    def __post_init__(self):
        if len(self.token) < 24:
            raise ValueError("LOGGING_TOKEN_MIN_24_CHARS")
        if self.flush_ms < 100 or self.max_records < 1:
            raise ValueError("INVALID_LOGGING_LIMITS")

    @classmethod
    def environment(cls):
        return cls(os.environ.get("LOGGING_TOKEN", ""), os.environ.get("LOGGING_DB", cls.database),
                   os.environ.get("LOGGING_EXPORT_DIR", cls.export_dir), int(os.environ.get("LOGGING_FLUSH_MS", "30000")),
                   int(os.environ.get("LOGGING_MAX_RECORDS", "100000")))


class Events(BaseModel):
    model_config = ConfigDict(extra="forbid")
    events: list[dict] = Field(min_length=1, max_length=100, description="exposure/article_open/article_close/like/unlike. Per-event validation returns ACK results.")


class Records(BaseModel):
    model_config = ConfigDict(extra="forbid")
    records: list[dict] = Field(min_length=1, max_length=100)


class DeleteReader(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    reader_id: str


class ServiceLock:
    """One process per persistent DB; advisory lock is released even after a crash."""
    def __init__(self, database):
        self.file = None
        if database == ":memory:":
            return
        path = Path(database)
        path.parent.mkdir(parents=True, exist_ok=True)
        # Legacy Node process owns this PID lock. Stop Node before migrating.
        if Path(str(path) + ".lock").exists():
            raise RuntimeError("LEGACY_NODE_LOCK_PRESENT_STOP_NODE_FIRST")
        self.file = open(str(path) + ".service.lock", "a+b")
        try:
            if os.name == "nt":
                import msvcrt
                self.file.seek(0)
                self.file.write(b"0")
                self.file.flush()
                self.file.seek(0)
                msvcrt.locking(self.file.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(self.file, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            self.file.close()
            raise RuntimeError("LOGGING_ALREADY_RUNNING") from None

    def close(self):
        if self.file:
            self.file.close()


class BodyLimit:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope["method"] != "POST":
            return await self.app(scope, receive, send)
        # Bound the actual streamed body, including multipart overhead, before parsing.
        chunks, total = [], 0
        while True:
            message = await receive()
            if message["type"] == "http.disconnect":
                return
            total += len(message.get("body", b""))
            if total > MAX_BODY:
                return await JSONResponse({"error": "BODY_TOO_LARGE"}, status_code=413)(scope, receive, send)
            chunks.append(message)
            if not message.get("more_body", False):
                break
        iterator = iter(chunks)

        async def replay():
            try:
                return next(iterator)
            except StopIteration:
                return await receive()

        await self.app(scope, replay, send)


def create_app(settings=None):
    @asynccontextmanager
    async def lifespan(app):
        config = settings or Settings.environment()
        lease = ServiceLock(config.database)
        store = None
        stop = asyncio.Event()
        wake = asyncio.Event()
        worker = None
        try:
            store = Store(config.database)
            exporter = Exporter(store, LocalSink(config.export_dir))
            app.state.config, app.state.store, app.state.exporter = config, store, exporter
            app.state.loop, app.state.wake = asyncio.get_running_loop(), wake

            async def periodic():
                while not stop.is_set():
                    try:
                        await asyncio.wait_for(wake.wait(), config.flush_ms / 1000)
                    except asyncio.TimeoutError:
                        pass
                    wake.clear()
                    if not stop.is_set():
                        try:
                            await run_in_threadpool(exporter.flush)
                        except Exception:
                            logger.error("Periodic export failed")

            worker = asyncio.create_task(periodic())
            yield
        finally:
            stop.set()
            wake.set()
            if worker:
                await worker
            try:
                if store:
                    try:
                        if hasattr(app.state, "exporter"):
                            await run_in_threadpool(app.state.exporter.flush)
                    finally:
                        store.close()
            finally:
                lease.close()

    app = FastAPI(title="ASAC Logging Server", version="1.0.0", lifespan=lifespan)
    app.add_middleware(BodyLimit)
    bearer = HTTPBearer(auto_error=False)

    def authenticate(request: Request, credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer)]):
        if not credentials or not hmac.compare_digest(credentials.credentials.encode(), request.app.state.config.token.encode()):
            raise HTTPException(401, "UNAUTHORIZED", headers={"WWW-Authenticate": "Bearer"})

    async def json_type(request: Request):
        if request.headers.get("content-type", "").split(";")[0] != "application/json":
            raise HTTPException(415, "JSON_REQUIRED")

    @app.middleware("http")
    async def no_cache(request, call_next):
        response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        return response

    @app.exception_handler(HTTPException)
    async def http_error(request, error):
        return JSONResponse({"error": error.detail}, status_code=error.status_code, headers=error.headers)

    @app.exception_handler(RequestValidationError)
    async def validation_error(request, error):
        # Preserve the previous JSON API's 400 contract; never echo event bodies.
        return JSONResponse({"error": "INVALID_REQUEST"}, status_code=400)

    @app.exception_handler(InputError)
    async def input_error(request, error):
        return JSONResponse({"error": str(error)}, status_code=403 if str(error) in ("COLLECTION_DISABLED", "USER_REVOKED") else 400)

    @app.exception_handler(OverflowError)
    async def capacity_error(request, error):
        return JSONResponse({"error": "INBOX_CAPACITY"}, status_code=503, headers={"Retry-After": "30"})

    @app.exception_handler(Exception)
    async def storage_error(request, error):
        return JSONResponse({"error": "STORAGE_UNAVAILABLE"}, status_code=503)

    @app.get("/health")
    def health():
        return {"status": "alive"}

    protected = [Depends(authenticate)]
    json_protected = [Depends(authenticate), Depends(json_type)]

    def notify_export(request):
        with request.app.state.store.lock:
            if request.app.state.store.readiness()["pendingRecords"] >= 1000:
                request.app.state.loop.call_soon_threadsafe(request.app.state.wake.set)

    @app.get("/ready", dependencies=protected)
    def ready(request: Request):
        with request.app.state.store.lock:
            return {**request.app.state.store.readiness(), "exporter": request.app.state.exporter.state}

    @app.post("/internal/served", dependencies=json_protected)
    def receive_served(request: Request, body: Records):
        result = request.app.state.store.intake_served(body.model_dump(), max_records=request.app.state.config.max_records)
        notify_export(request)
        return result

    @app.post("/events", dependencies=json_protected)
    def receive_events(request: Request, body: Events):
        result = request.app.state.store.intake_actions(body.model_dump(), request.headers.get("x-news-reader"),
            request.headers.get("x-collection-enabled") == "true", request.headers.get("x-news-source", "browser"), request.app.state.config.max_records)
        notify_export(request)
        return result

    @app.post("/internal/served-file", dependencies=protected)
    async def receive_file(request: Request, file: Annotated[UploadFile, File()], request_id: Annotated[str, Form()], expected_item_count: Annotated[int, Form()]):
        identifier(request_id)
        try:
            content = await file.read(MAX_BODY + 1)
            if len(content) > MAX_BODY:
                raise HTTPException(413, "BODY_TOO_LARGE")
            rows = [json.loads(line) for line in content.decode("utf-8").splitlines() if line.strip()]
        except (UnicodeError, ValueError):
            raise HTTPException(400, "INVALID_JSONL") from None
        finally:
            await file.close()
        if type(expected_item_count) is not int or not 1 <= expected_item_count <= 100 or len(rows) != expected_item_count:
            raise HTTPException(400, "ITEM_COUNT_MISMATCH")
        if any(not isinstance(r, dict) or r.get("request_id") != request_id for r in rows):
            raise HTTPException(400, "REQUEST_ID_MISMATCH")
        ids = [r.get("impression_id") for r in rows]
        if any(not isinstance(value, str) for value in ids) or len(set(ids)) != len(ids):
            raise HTTPException(400, "DUPLICATE_IMPRESSION")
        # The backend deletes the pending file on 200: require whole-file commit.
        result = await run_in_threadpool(request.app.state.store.intake_served, {"records": rows}, True, request.app.state.config.max_records)
        await run_in_threadpool(notify_export, request)
        return result

    @app.post("/internal/flush", dependencies=json_protected)
    def flush(request: Request, body: dict = Body(...)):
        return {"completed": request.app.state.exporter.flush(True)}

    @app.post("/internal/delete-user", dependencies=json_protected)
    def delete_user(request: Request, body: DeleteReader):
        request.app.state.exporter.delete(body.reader_id)
        return {"deleted": True}

    return app


app = create_app()
