"""Reproducible large-file generation and isolated, bounded paging measurement.

python scripts/benchmark.py --rows 10000000
python scripts/benchmark.py --rows 50000000 --output /path/benchmark.parquet
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


def probe(path: Path):
    from parquet_lens.engine import Engine, PageQuery

    with tempfile.TemporaryDirectory() as temp:
        engine = Engine(Path(temp) / "spill")
        start = time.perf_counter()
        file = engine.register(path)
        opened = time.perf_counter() - start
        results = {}
        for label, offset in [
            ("first", 0),
            ("middle", file.metadata.num_rows // 2),
            ("last", max(0, file.metadata.num_rows - 100)),
        ]:
            start = time.perf_counter()
            result = engine.page(file.id, PageQuery(offset=offset, limit=100))
            assert result["rows"][0][0] == offset
            assert len(result["rows"]) == min(100, file.metadata.num_rows - offset)
            results[label + "_page_ms"] = round((time.perf_counter() - start) * 1000, 1)
        peak = None
        try:
            import resource

            usage = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
            peak = round(usage / (1024**2 if sys.platform == "darwin" else 1024), 1)
        except ImportError:
            pass
        print(
            json.dumps(
                {
                    "rows": file.metadata.num_rows,
                    "file_mb": round(file.size / 1024**2, 1),
                    "row_groups": file.metadata.num_row_groups,
                    "open_ms": round(opened * 1000, 1),
                    **results,
                    "probe_peak_rss_mb": peak,
                },
                indent=2,
            )
        )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--rows", type=int, default=10_000_000)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--probe", type=Path, help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.probe:
        return probe(args.probe)
    if args.rows < 100:
        parser.error("rows must be at least 100")
    import duckdb

    with tempfile.TemporaryDirectory(prefix="parquet-lens-bench-") as temp:
        path = (args.output or Path(temp) / "benchmark.parquet").resolve()
        if path.exists():
            parser.error("Output already exists; choose a new path")
        path.parent.mkdir(parents=True, exist_ok=True)
        con = duckdb.connect(
            config={
                "memory_limit": "256MB",
                "threads": "2",
                "temp_directory": str(Path(temp) / "spill"),
            }
        )
        start = time.perf_counter()
        # Hash columns resist compression, giving a realistic on-disk file size.
        output_literal = "'" + path.as_posix().replace("'", "''") + "'"
        con.execute(f"""COPY (SELECT i AS id, md5(i::VARCHAR) AS customer,
            md5((i+1000000000)::VARCHAR) AS reference,
            (i % 6)::INTEGER AS region, (i % 200000) / 100.0 AS amount,
            timestamp '2026-01-01' + (i % 31536000) * interval 1 second AS created_at,
            i % 3 = 0 AS active, struct_pack(channel := 'web', sequence := i) AS metadata
            FROM range({args.rows}) t(i)) TO {output_literal} (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 122880)""")
        con.close()
        print(f"Generated in {time.perf_counter() - start:.1f}s", flush=True)
        # Generation memory is deliberately excluded from reader peak RSS.
        subprocess.run([sys.executable, __file__, "--probe", str(path)], check=True)


if __name__ == "__main__":
    main()
