from __future__ import annotations

import hmac
import ipaddress
import json
import os
import tempfile
import threading
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Query, Request
from fastapi.responses import JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool

from .engine import Engine, PageQuery, ViewerError, schema_field
from .i18n import language_from_header, translate


class LocalFile(BaseModel):
    path: str = Field(min_length=1, max_length=8192)


def create_app(
    token: str,
    data_dir: Path | None = None,
    memory_limit: str = "256MB",
    timeout: float = 20,
    max_upload: int = 20 * 1024**3,
):
    if not token:
        raise ValueError("An access token is required")
    temporary = tempfile.TemporaryDirectory(prefix="parquet-lens-", dir=data_dir)
    root = Path(temporary.name)
    engine = Engine(root / "spill", memory_limit, timeout)
    demo_lock = threading.Lock()

    @asynccontextmanager
    async def lifespan(app):
        yield
        temporary.cleanup()

    app = FastAPI(
        title="Parquet Lens",
        lifespan=lifespan,
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )
    app.state.engine = engine
    app.state.storage = root

    def error_response(request: Request, message: str, status: int):
        header = request.headers.get("accept-language", "")
        return JSONResponse(
            {"detail": translate(message, header)},
            status_code=status,
            headers={"Content-Language": language_from_header(header)},
        )

    @app.middleware("http")
    async def access(request: Request, call_next):
        supplied = request.cookies.get("parquet_lens_session", "")
        authenticated = hmac.compare_digest(supplied.encode(), token.encode())
        launch_token = (
            request.query_params.get("token", "") if request.url.path == "/" else ""
        )
        if launch_token and hmac.compare_digest(launch_token.encode(), token.encode()):
            response = RedirectResponse("/", status_code=303)
            response.set_cookie(
                "parquet_lens_session",
                token,
                httponly=True,
                samesite="strict",
                secure=request.url.scheme == "https",
            )
        elif not authenticated:
            return error_response(
                request, "请使用启动时显示的完整访问链接打开软件。", 401
            )
        else:
            origin = request.headers.get("origin")
            if (
                request.method not in ("GET", "HEAD")
                and origin
                and origin != str(request.base_url).rstrip("/")
            ):
                return error_response(request, "已阻止跨站请求。", 403)
            response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["Cache-Control"] = "no-store"
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
        )
        return response

    @app.exception_handler(ViewerError)
    async def viewer_error(request, exc):
        return error_response(request, exc.message, exc.status)

    @app.get("/api/config")
    def config(request: Request):
        return {
            "local_path": is_loopback(request),
            "max_upload": max_upload,
            "query_timeout": timeout,
            "version": "0.1.0",
        }

    @app.get("/api/files")
    def files():
        with engine.lock:
            return [dataset.summary() for dataset in engine.datasets.values()]

    @app.post("/api/files/local")
    def local_file(body: LocalFile, request: Request):
        if not is_loopback(request):
            raise ViewerError(
                "本机路径只允许在运行服务的电脑上打开；其他设备请上传文件。", 403
            )
        return engine.register(Path(body.path)).summary()

    @app.post("/api/files/upload")
    async def upload(request: Request, name: str = Query(min_length=1, max_length=255)):
        if not name.lower().endswith((".parquet", ".pq")):
            raise ViewerError("请选择 .parquet 或 .pq 文件。")
        length = request.headers.get("content-length")
        if length and int(length) > max_upload:
            raise ViewerError("文件超过上传大小限制，请使用本机路径直接打开。", 413)
        descriptor, filename = tempfile.mkstemp(suffix=".parquet", dir=root)
        path = Path(filename)
        transferred = 0
        try:
            with os.fdopen(descriptor, "wb") as output:
                async for chunk in request.stream():
                    transferred += len(chunk)
                    if transferred > max_upload:
                        raise ViewerError(
                            "文件超过上传大小限制，请使用本机路径直接打开。", 413
                        )
                    await run_in_threadpool(output.write, chunk)
            if not transferred:
                raise ViewerError("文件为空。")
            dataset = await run_in_threadpool(
                engine.register, path, name.replace("\\", "/").split("/")[-1], True
            )
            return dataset.summary()
        except BaseException:
            path.unlink(missing_ok=True)
            raise

    @app.post("/api/demo")
    def demo():
        from .sample import create_sample

        with demo_lock:
            path = root / "commerce_demo.parquet"
            if not path.exists():
                create_sample(path)
            return engine.register(path, "commerce_demo.parquet").summary()

    @app.get("/api/files/{dataset_id}")
    def file_details(dataset_id: str):
        dataset = engine.get(dataset_id)
        metadata = dataset.schema.metadata or {}
        return {
            **dataset.summary(),
            "schema": [schema_field(field, field.name) for field in dataset.schema],
            "metadata": {
                key.decode(errors="replace")[:200]: value.decode(errors="replace")[
                    :4096
                ]
                for key, value in list(metadata.items())[:50]
                if key != b"ARROW:schema"
            },
        }

    @app.delete("/api/files/{dataset_id}")
    def close(dataset_id: str):
        engine.remove(dataset_id)
        return {"ok": True}

    @app.get("/api/files/{dataset_id}/groups")
    def groups(
        dataset_id: str,
        offset: int = Query(0, ge=0),
        limit: int = Query(30, ge=1, le=100),
    ):
        return engine.row_groups(dataset_id, offset, limit)

    @app.get("/api/files/{dataset_id}/stats")
    def stats(
        dataset_id: str,
        column: str,
        offset: int = Query(0, ge=0),
        limit: int = Query(30, ge=1, le=100),
    ):
        return engine.column_stats(dataset_id, column, offset, limit)

    @app.post("/api/files/{dataset_id}/page")
    def page(dataset_id: str, body: PageQuery):
        result = engine.page(dataset_id, body)
        encoded = json.dumps(result, ensure_ascii=False, allow_nan=False)
        if len(encoded.encode()) > 8 * 1024**2:
            raise ViewerError("当前页内容过大，请减少每页行数或所选字段。", 413)
        return JSONResponse(result)

    app.mount(
        "/",
        StaticFiles(directory=Path(__file__).parent / "static", html=True),
        name="ui",
    )
    return app


def is_loopback(request: Request):
    try:
        address = ipaddress.ip_address(request.client.host)
        return address.is_loopback or (
            getattr(address, "ipv4_mapped", None) is not None
            and address.ipv4_mapped.is_loopback
        )
    except (ValueError, AttributeError):
        return False
