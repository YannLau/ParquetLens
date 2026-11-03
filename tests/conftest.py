from decimal import Decimal

import pyarrow as pa
import pyarrow.parquet as pq
import pytest
from fastapi.testclient import TestClient

from parquet_lens.engine import Engine
from parquet_lens.server import create_app


@pytest.fixture
def parquet(tmp_path):
    path = tmp_path / "sample.parquet"
    table = pa.table(
        {
            "id": list(range(73)),
            "name": [f"客户 {i}" for i in range(73)],
            "value": [None if i % 5 == 0 else i / 10 for i in range(73)],
            "nested": [{"tags": ["one", "two"], "count": i} for i in range(73)],
            "large_int": [2**63 - 1] * 73,
            "decimal": pa.array(
                [Decimal("123456789012.123456")] * 73, type=pa.decimal128(20, 6)
            ),
            'quoted"field': [i % 3 for i in range(73)],
            "dotted.field": list(range(73)),
            "binary": [b"\x00\xff"] * 73,
        }
    )
    pq.write_table(table, path, row_group_size=13)
    return path


@pytest.fixture
def engine(tmp_path):
    return Engine(tmp_path / "spill")


@pytest.fixture
def client(tmp_path):
    app = create_app("test-secret", tmp_path)
    with TestClient(app, client=("127.0.0.1", 50000)) as client:
        assert client.get("/?token=test-secret").status_code == 200
        yield client
