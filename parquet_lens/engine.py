"""Footer-only inspection, row-group-aware paging, and bounded SQL queries."""

from __future__ import annotations

import base64
import bisect
import datetime as dt
import decimal
import math
import shutil
import threading
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

import duckdb
import pyarrow as pa
import pyarrow.parquet as pq
from pydantic import BaseModel, Field


class ViewerError(Exception):
    def __init__(self, message: str, status: int = 400):
        self.message, self.status = message, status
        super().__init__(message)


class Filter(BaseModel):
    column: str
    op: Literal[
        "eq", "neq", "gt", "gte", "lt", "lte", "contains", "is_null", "not_null"
    ]
    value: str = Field(default="", max_length=2000)


class PageQuery(BaseModel):
    offset: int = Field(default=0, ge=0, le=10**15)
    limit: int = Field(default=100, ge=1, le=200)
    columns: list[str] | None = Field(default=None, max_length=80)
    filters: list[Filter] = Field(default_factory=list, max_length=12)
    sort: str | None = None
    direction: Literal["asc", "desc"] = "asc"


def preview(value: Any, budget: int = 4096, depth: int = 0) -> tuple[Any, bool]:
    """Keep JSON exact for integers/decimals, and put a bound on large cells."""
    if value is None or isinstance(value, bool):
        return value, False
    if isinstance(value, int):
        return (str(value) if abs(value) > 2**53 - 1 else value), False
    if isinstance(value, float):
        return (value if math.isfinite(value) else str(value)), False
    if isinstance(value, (dt.datetime, dt.date, dt.time)):
        return value.isoformat(), False
    if isinstance(value, (decimal.Decimal, dt.timedelta, uuid.UUID)):
        return str(value), False
    if isinstance(value, bytes):
        return "base64:" + base64.b64encode(value[: budget // 2]).decode(), len(
            value
        ) > budget // 2
    if isinstance(value, str):
        return value[:budget], len(value) > budget
    if depth >= 5:
        return "…", True
    if isinstance(value, (dict, list, tuple)):
        mapping = isinstance(value, dict)
        items = list(value.items())[:51] if mapping else value[:51]
        out: Any = {} if mapping else []
        truncated = len(value) > 50
        remaining = budget
        for item in items[:50]:
            key, child = item if mapping else (None, item)
            converted, cut = preview(child, max(32, remaining), depth + 1)
            truncated |= cut
            if mapping:
                out[str(key)] = converted
            else:
                out.append(converted)
            remaining -= len(str(converted)) + len(str(key or ""))
            if remaining <= 0:
                truncated = True
                break
        return out, truncated
    text = str(value)
    return text[:budget], len(text) > budget


def schema_field(field: pa.Field, path: str) -> dict:
    children = []
    if pa.types.is_struct(field.type):
        children = [schema_field(child, f"{path}.{child.name}") for child in field.type]
    elif (
        pa.types.is_list(field.type)
        or pa.types.is_large_list(field.type)
        or pa.types.is_fixed_size_list(field.type)
    ):
        child = field.type.value_field
        children = [schema_field(child, f"{path}[]")]
    elif pa.types.is_map(field.type):
        children = [
            schema_field(field.type.key_field, f"{path}.key"),
            schema_field(field.type.item_field, f"{path}.value"),
        ]
    return {
        "name": field.name,
        "path": path,
        "type": str(field.type),
        "nullable": field.nullable,
        "children": children,
    }


@dataclass
class Dataset:
    id: str
    path: Path
    name: str
    owned: bool
    size: int
    mtime: int
    metadata: Any
    schema: pa.Schema
    starts: list[int]

    def check(self):
        try:
            stat = self.path.stat()
        except OSError as exc:
            raise ViewerError("文件已被移动或删除，请重新打开。", 409) from exc
        if stat.st_size != self.size or stat.st_mtime_ns != self.mtime:
            raise ViewerError("文件已发生变化，请关闭后重新打开。", 409)

    def summary(self):
        codecs = set()
        if self.metadata.num_row_groups:
            group = self.metadata.row_group(0)
            codecs = {group.column(i).compression for i in range(group.num_columns)}
        return {
            "id": self.id,
            "name": self.name,
            "size": self.size,
            "rows": self.metadata.num_rows,
            "columns": len(self.schema),
            "row_groups": self.metadata.num_row_groups,
            "compression": sorted(codecs),
            "source": "upload" if self.owned else "local",
            "created_by": self.metadata.created_by,
            "format_version": self.metadata.format_version,
            "footer_size": self.metadata.serialized_size,
        }


class Engine:
    def __init__(
        self, temp_dir: Path, memory_limit: str = "256MB", timeout: float = 20
    ):
        self.temp_dir = temp_dir
        self.memory_limit = memory_limit
        self.timeout = timeout
        self.datasets: dict[str, Dataset] = {}
        self.lock = threading.RLock()
        self.slots = threading.BoundedSemaphore(2)

    def register(
        self, path: Path, name: str | None = None, owned: bool = False
    ) -> Dataset:
        try:
            path = path.expanduser().resolve(strict=True)
            if not path.is_file():
                raise ViewerError("请选择一个 Parquet 文件。")
            stat = path.stat()
            with pq.ParquetFile(path) as reader:
                metadata, schema = reader.metadata, reader.schema_arrow
            if len({name.casefold() for name in schema.names}) != len(schema.names):
                raise ViewerError(
                    "文件含有重名或仅大小写不同的顶层字段，暂不支持，请先重命名字段。"
                )
            starts = [0]
            for i in range(metadata.num_row_groups):
                starts.append(starts[-1] + metadata.row_group(i).num_rows)
        except ViewerError:
            raise
        except (OSError, ValueError, pa.ArrowException) as exc:
            raise ViewerError(
                "无法打开文件：请检查权限，并确认文件是完整、未加密的 Parquet 文件。"
            ) from exc
        with self.lock:
            if not owned:
                for dataset in self.datasets.values():
                    if (
                        dataset.path == path
                        and dataset.mtime == stat.st_mtime_ns
                        and dataset.size == stat.st_size
                    ):
                        return dataset
            if len(self.datasets) >= 24:
                raise ViewerError("最多同时打开 24 个文件，请先关闭不需要的文件。", 429)
            dataset = Dataset(
                uuid.uuid4().hex,
                path,
                name or path.name,
                owned,
                stat.st_size,
                stat.st_mtime_ns,
                metadata,
                schema,
                starts,
            )
            self.datasets[dataset.id] = dataset
            return dataset

    def get(self, dataset_id: str) -> Dataset:
        with self.lock:
            dataset = self.datasets.get(dataset_id)
        if dataset is None:
            raise ViewerError("文件会话不存在，请重新打开。", 404)
        dataset.check()
        return dataset

    def remove(self, dataset_id: str):
        with self.lock:
            dataset = self.datasets.pop(dataset_id, None)
        if dataset and dataset.owned:
            try:
                dataset.path.unlink(missing_ok=True)
            except OSError:
                # Windows cannot unlink an active reader; session cleanup retries.
                pass

    def row_groups(self, dataset_id: str, offset: int, limit: int):
        dataset = self.get(dataset_id)
        groups = []
        for i in range(offset, min(offset + limit, dataset.metadata.num_row_groups)):
            group = dataset.metadata.row_group(i)
            groups.append(
                {
                    "id": i,
                    "start": dataset.starts[i],
                    "rows": group.num_rows,
                    "compressed": sum(
                        group.column(j).total_compressed_size
                        for j in range(group.num_columns)
                    ),
                    "uncompressed": group.total_byte_size,
                }
            )
        return {"groups": groups, "total": dataset.metadata.num_row_groups}

    def column_stats(self, dataset_id: str, column: str, offset: int, limit: int):
        dataset = self.get(dataset_id)
        if column not in dataset.schema.names:
            raise ViewerError("字段不存在。")
        # Top-level scalars map one-to-one to physical leaves; nested fields have
        # different null-count semantics and are deliberately not flattened here.
        field = dataset.schema.field(column)
        if pa.types.is_nested(field.type):
            return {
                "nested": True,
                "groups": [],
                "total": dataset.metadata.num_row_groups,
            }
        # Use Parquet's physical schema mapping, which also handles nested lists/maps.
        candidates = [
            i
            for i in range(len(dataset.metadata.schema))
            if dataset.metadata.schema.column(i).path == column
        ]
        if not candidates:
            return {
                "nested": False,
                "groups": [],
                "total": dataset.metadata.num_row_groups,
            }
        leaf = candidates[0]
        groups = []
        for i in range(offset, min(offset + limit, dataset.metadata.num_row_groups)):
            chunk = dataset.metadata.row_group(i).column(leaf)
            stats = chunk.statistics
            groups.append(
                {
                    "id": i,
                    "nulls": stats.null_count
                    if stats and stats.has_null_count
                    else None,
                    "min": preview(stats.min)[0]
                    if stats and stats.has_min_max
                    else None,
                    "max": preview(stats.max)[0]
                    if stats and stats.has_min_max
                    else None,
                    "compression": chunk.compression,
                    "compressed": chunk.total_compressed_size,
                }
            )
        return {
            "nested": False,
            "groups": groups,
            "total": dataset.metadata.num_row_groups,
        }

    def page(self, dataset_id: str, query: PageQuery):
        dataset = self.get(dataset_id)
        columns = (
            query.columns if query.columns is not None else dataset.schema.names[:20]
        )
        if not columns or len(set(columns)) != len(columns):
            raise ViewerError("请至少选择一个字段，且不能重复。")
        if any(col not in dataset.schema.names for col in columns):
            raise ViewerError("所选字段不存在。")
        if query.sort is not None and query.sort not in dataset.schema.names:
            raise ViewerError("排序字段不存在。")
        if any(item.column not in dataset.schema.names for item in query.filters):
            raise ViewerError("筛选字段不存在。")
        if not self.slots.acquire(blocking=False):
            raise ViewerError("正在处理其他查询，请稍后重试。", 429)
        start = time.perf_counter()
        try:
            if query.filters or query.sort:
                rows, has_more = self._query(dataset, columns, query)
                total = None
                mode = "query"
            else:
                rows = self._read_page(dataset, columns, query.offset, query.limit)
                has_more = query.offset + len(rows) < dataset.metadata.num_rows
                total = dataset.metadata.num_rows
                mode = "row_group"
            converted, truncated = [], []
            for ri, row in enumerate(rows):
                output = []
                for ci, value in enumerate(row):
                    cell, cut = preview(value)
                    output.append(cell)
                    if cut:
                        truncated.append([ri, ci])
                converted.append(output)
            return {
                "columns": [
                    {"name": col, "type": str(dataset.schema.field(col).type)}
                    for col in columns
                ],
                "rows": converted,
                "offset": query.offset,
                "total": total,
                "has_more": has_more,
                "truncated": truncated,
                "elapsed_ms": round((time.perf_counter() - start) * 1000, 1),
                "mode": mode,
            }
        except (duckdb.Error, pa.ArrowException, OSError) as exc:
            message = str(exc).lower()
            if "interrupt" in message:
                raise ViewerError(
                    "查询超过时间限制，已停止。请减少筛选范围或取消排序。", 408
                ) from exc
            if "memory" in message or "out of" in message:
                raise ViewerError(
                    "查询达到资源限制。请减少所选字段、缩小范围或取消排序。", 422
                ) from exc
            raise ViewerError(
                "读取失败，请检查筛选值是否匹配字段类型，或重新打开文件。", 422
            ) from exc
        finally:
            self.slots.release()

    @staticmethod
    def _read_page(dataset: Dataset, columns: list[str], offset: int, limit: int):
        """Jump to the relevant row group instead of scanning all preceding rows."""
        if offset >= dataset.metadata.num_rows:
            return []
        group_index = bisect.bisect_right(dataset.starts, offset) - 1
        rows = []
        with pq.ParquetFile(dataset.path) as reader:
            for group in range(group_index, dataset.metadata.num_row_groups):
                skip = max(0, offset - dataset.starts[group])
                for batch in reader.iter_batches(
                    batch_size=256,
                    row_groups=[group],
                    columns=columns,
                    use_threads=False,
                ):
                    if skip >= batch.num_rows:
                        skip -= batch.num_rows
                        continue
                    part = batch.slice(
                        skip, min(limit - len(rows), batch.num_rows - skip)
                    )
                    # Parquet's projection can preserve physical ordering: explicitly
                    # reselect so each value matches the requested column order.
                    arrays = [
                        part.column(part.schema.get_field_index(col)).to_pylist()
                        for col in columns
                    ]
                    rows.extend(zip(*arrays))
                    skip = 0
                    if len(rows) >= limit:
                        return rows
        return rows

    def _query(self, dataset: Dataset, columns: list[str], query: PageQuery):
        def quote(name):
            return '"' + name.replace('"', '""') + '"'

        parameters: list[Any] = [str(dataset.path)]
        conditions = []
        operators = {
            "eq": "=",
            "neq": "!=",
            "gt": ">",
            "gte": ">=",
            "lt": "<",
            "lte": "<=",
        }
        for item in query.filters:
            col = quote(item.column)
            if item.op in ("is_null", "not_null"):
                conditions.append(
                    f"{col} IS {'NOT ' if item.op == 'not_null' else ''}NULL"
                )
            elif item.op == "contains":
                conditions.append(f"contains(CAST({col} AS VARCHAR), ?)")
                parameters.append(item.value)
            else:
                conditions.append(f"{col} {operators[item.op]} ?")
                parameters.append(item.value)
        tie = "__parquet_lens_row__"
        while tie in dataset.schema.names:
            tie += "_"
        if query.sort and "file_row_number" not in {
            name.casefold() for name in dataset.schema.names
        }:
            source = (
                "read_parquet(?, hive_partitioning = false, file_row_number = true)"
            )
            tie = "file_row_number"
        elif query.sort:
            source = f"(SELECT *, row_number() OVER () AS {quote(tie)} FROM read_parquet(?, hive_partitioning = false))"
        else:
            source = "read_parquet(?, hive_partitioning = false)"
        sql = f"SELECT {', '.join(map(quote, columns))} FROM {source}"
        if conditions:
            sql += " WHERE " + " AND ".join(conditions)
        if query.sort:
            sql += f" ORDER BY {quote(query.sort)} {query.direction.upper()} NULLS LAST, {quote(tie)} ASC"
        sql += " LIMIT ? OFFSET ?"
        parameters.extend([query.limit + 1, query.offset])
        spill = self.temp_dir / uuid.uuid4().hex
        con = duckdb.connect(
            config={
                "memory_limit": self.memory_limit,
                "threads": "1",
                "external_threads": "1",
                "temp_directory": str(spill),
                "max_temp_directory_size": "2GB",
                "enable_external_access": "true",
            }
        )
        timer = threading.Timer(self.timeout, con.interrupt)
        timer.daemon = True
        try:
            con.execute("SET preserve_insertion_order = true")
            timer.start()
            result = con.execute(sql, parameters).fetchmany(query.limit + 1)
            return result[: query.limit], len(result) > query.limit
        finally:
            timer.cancel()
            timer.join() if timer.ident is not None else None
            con.close()
            shutil.rmtree(spill, ignore_errors=True)
