"""Generate a deterministic nested, nullable, multi-row-group demo on demand."""

from datetime import datetime, timedelta
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq


def create_sample(path: Path, rows: int = 240_000):
    regions = ["华东", "华南", "华北", "西南", "华中", "西北"]
    statuses = ["已完成", "已完成", "配送中", "已完成", "待付款", "已取消"]
    schema = pa.schema(
        [
            pa.field("order_id", pa.int64(), nullable=False),
            pa.field("customer", pa.string()),
            pa.field("region", pa.string()),
            pa.field("amount", pa.float64()),
            pa.field("status", pa.string()),
            pa.field("created_at", pa.timestamp("us")),
            pa.field("is_member", pa.bool_()),
            pa.field("discount", pa.float64()),
            pa.field(
                "items",
                pa.list_(pa.struct([("sku", pa.string()), ("quantity", pa.int32())])),
            ),
            pa.field(
                "metadata",
                pa.struct([("channel", pa.string()), ("campaign", pa.string())]),
            ),
        ],
        metadata={
            b"description": "电商订单演示数据 / Synthetic demo".encode(),
            b"source": b"Parquet Lens deterministic generator",
        },
    )
    with pq.ParquetWriter(path, schema, compression="zstd") as writer:
        for start in range(0, rows, 20_000):
            values = []
            for i in range(start, min(rows, start + 20_000)):
                values.append(
                    {
                        "order_id": 2026000001 + i,
                        "customer": [
                            "林晓",
                            "陈一鸣",
                            "王可",
                            "张若宁",
                            "李沐",
                            "刘洋",
                        ][i % 6]
                        + f" {i % 997:03}",
                        "region": regions[i % 6],
                        "amount": round(39 + ((i * 173) % 199900) / 100, 2),
                        "status": statuses[i % 6],
                        "created_at": datetime(2026, 1, 1, 9) + timedelta(minutes=i),
                        "is_member": i % 3 != 0,
                        "discount": None if i % 7 == 0 else round((i % 8) * 0.05, 2),
                        "items": [{"sku": f"SKU-{i % 350:04}", "quantity": i % 4 + 1}],
                        "metadata": {
                            "channel": ["小程序", "网页", "App"][i % 3],
                            "campaign": None if i % 5 == 0 else "秋日精选",
                        },
                    }
                )
            writer.write_table(
                pa.Table.from_pylist(values, schema=schema), row_group_size=20_000
            )
