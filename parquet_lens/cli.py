from __future__ import annotations

import argparse
import math
import secrets
import threading
import webbrowser
from pathlib import Path
from urllib.parse import quote

import uvicorn

from .engine import ViewerError
from .server import create_app


def main():
    parser = argparse.ArgumentParser(
        description="Parquet Lens · 跨平台 Parquet 可视化浏览器"
    )
    parser.add_argument("file", nargs="?", help="启动时打开的 Parquet 文件")
    parser.add_argument(
        "--host", default="127.0.0.1", help="监听地址，局域网访问使用 0.0.0.0"
    )
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--no-browser", action="store_true")
    parser.add_argument(
        "--memory-limit", default="256MB", help="每个筛选/排序查询的 DuckDB 内存上限"
    )
    parser.add_argument("--query-timeout", type=float, default=20)
    parser.add_argument("--max-upload-gb", type=float, default=20)
    args = parser.parse_args()
    if (
        not (math.isfinite(args.query_timeout) and math.isfinite(args.max_upload_gb))
        or args.query_timeout <= 0
        or args.max_upload_gb <= 0
    ):
        parser.error("查询时间和上传大小必须大于 0")
    if not 1 <= args.port <= 65535:
        parser.error("端口必须在 1–65535 之间")
    token = secrets.token_urlsafe(32)
    app = create_app(
        token,
        memory_limit=args.memory_limit,
        timeout=args.query_timeout,
        max_upload=int(args.max_upload_gb * 1024**3),
    )
    if args.file:
        try:
            app.state.engine.register(Path(args.file))
        except ViewerError as exc:
            parser.error(str(exc))
    host = "127.0.0.1" if args.host in ("0.0.0.0", "::") else args.host
    if ":" in host:
        host = f"[{host}]"
    url = f"http://{host}:{args.port}/?token={quote(token)}"
    print(f"\n  Parquet Lens\n  访问链接：{url}\n")
    if args.host in ("0.0.0.0", "::"):
        print(
            "  局域网设备：将链接中的 127.0.0.1 替换为本机局域网 IP。\n  完整链接含访问密钥，请只分享给可信设备；HTTP 模式适用于可信局域网。\n"
        )
    if not args.no_browser:
        timer = threading.Timer(1.2, webbrowser.open, args=[url])
        timer.daemon = True
        timer.start()
    uvicorn.run(
        app, host=args.host, port=args.port, proxy_headers=False, log_level="warning"
    )
