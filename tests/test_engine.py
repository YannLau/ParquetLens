import json

import pyarrow as pa
import pyarrow.parquet as pq
import pytest

from parquet_lens.engine import Filter, PageQuery, ViewerError, preview


def test_footer_schema_and_row_groups(engine, parquet):
    dataset = engine.register(parquet)
    assert dataset.summary()["rows"] == 73
    assert dataset.summary()["row_groups"] == 6
    assert dataset.schema.field("nested").type.num_fields == 2
    assert engine.row_groups(dataset.id, 4, 2)["groups"][-1]["rows"] == 8
    assert engine.column_stats(dataset.id, "value", 0, 1)["groups"][0]["nulls"] == 3
    assert engine.column_stats(dataset.id, "nested", 0, 1)["nested"] is True
    assert (
        engine.column_stats(dataset.id, "dotted.field", 0, 1)["groups"][0]["max"] == 12
    )


@pytest.mark.parametrize(
    "offset,limit",
    [(0, 10), (10, 10), (12, 8), (13, 13), (60, 13), (72, 10), (73, 10), (9999, 10)],
)
def test_page_boundaries_and_column_order(engine, parquet, offset, limit):
    dataset = engine.register(parquet)
    page = engine.page(
        dataset.id,
        PageQuery(offset=offset, limit=limit, columns=["name", "id", "dotted.field"]),
    )
    assert page["rows"] == [
        [f"客户 {i}", i, i] for i in range(offset, min(offset + limit, 73))
    ]
    assert page["has_more"] == (offset + limit < 73)
    assert page["total"] == 73


def test_deep_page_skips_previous_row_groups(engine, parquet, monkeypatch):
    dataset = engine.register(parquet)
    real_reader = pq.ParquetFile
    touched = []

    class Reader:
        def __init__(self, *args, **kwargs):
            self.reader = real_reader(*args, **kwargs)

        def __enter__(self):
            return self

        def __exit__(self, *args):
            self.reader.close()

        def iter_batches(self, **kwargs):
            touched.extend(kwargs["row_groups"])
            return self.reader.iter_batches(**kwargs)

    monkeypatch.setattr(pq, "ParquetFile", Reader)
    result = engine.page(dataset.id, PageQuery(offset=68, limit=3, columns=["id"]))
    assert result["rows"] == [[68], [69], [70]]
    assert touched == [5]


def test_exact_and_nested_types(engine, parquet):
    dataset = engine.register(parquet)
    page = engine.page(dataset.id, PageQuery(limit=1))
    record = dict(zip([c["name"] for c in page["columns"]], page["rows"][0]))
    assert record["large_int"] == str(2**63 - 1)
    assert record["decimal"] == "123456789012.123456"
    assert record["binary"] == "base64:AP8="
    assert record["nested"] == {"tags": ["one", "two"], "count": 0}
    json.dumps(page, allow_nan=False)


@pytest.mark.parametrize(
    "op,value,expected",
    [
        ("eq", "10", [10]),
        ("gt", "70", [71, 72]),
        ("gte", "71", [71, 72]),
        ("lt", "2", [0, 1]),
        ("lte", "1", [0, 1]),
        ("neq", "0", list(range(1, 73))),
    ],
)
def test_numeric_filters(engine, parquet, op, value, expected):
    dataset = engine.register(parquet)
    page = engine.page(
        dataset.id,
        PageQuery(columns=["id"], filters=[Filter(column="id", op=op, value=value)]),
    )
    assert [r[0] for r in page["rows"]] == expected
    assert page["total"] is None


def test_literal_filter_no_injection(engine, parquet):
    dataset = engine.register(parquet)
    result = engine.page(
        dataset.id,
        PageQuery(filters=[Filter(column="name", op="contains", value="%' OR 1=1 --")]),
    )
    assert result["rows"] == []
    with pytest.raises(ViewerError):
        engine.page(
            dataset.id, PageQuery(columns=["id\" FROM read_csv('/etc/passwd') --"])
        )


def test_sort_ties_stable_and_quoted_identifier(engine, parquet):
    dataset = engine.register(parquet)
    first = engine.page(
        dataset.id, PageQuery(columns=["id"], sort='quoted"field', limit=5)
    )
    second = engine.page(
        dataset.id, PageQuery(columns=["id"], sort='quoted"field', limit=5, offset=5)
    )
    assert first["rows"] == [[0], [3], [6], [9], [12]]
    assert second["rows"] == [[15], [18], [21], [24], [27]]


def test_null_contains_multiple_filters_and_lookahead(engine, parquet):
    dataset = engine.register(parquet)
    page = engine.page(
        dataset.id,
        PageQuery(
            columns=["id"],
            filters=[
                Filter(column="value", op="is_null"),
                Filter(column="name", op="contains", value="1"),
            ],
            limit=1,
        ),
    )
    assert page["rows"] == [[10]]
    assert page["has_more"]
    page = engine.page(
        dataset.id,
        PageQuery(
            columns=["id"],
            filters=[Filter(column="value", op="not_null")],
            sort="id",
            direction="desc",
            limit=2,
        ),
    )
    assert page["rows"] == [[72], [71]]


def test_reserved_row_number_name(engine, tmp_path):
    path = tmp_path / "reserved.parquet"
    pq.write_table(pa.table({"file_row_number": [9, 8, 7], "x": [1, 1, 1]}), path)
    dataset = engine.register(path)
    result = engine.page(
        dataset.id, PageQuery(sort="x", columns=["file_row_number"], offset=1, limit=1)
    )
    assert result["rows"] == [[8]]


def test_empty_file_and_changed_file(engine, tmp_path):
    path = tmp_path / "empty.parquet"
    pq.write_table(pa.table({"x": pa.array([], type=pa.int64())}), path)
    dataset = engine.register(path)
    assert engine.page(dataset.id, PageQuery())["rows"] == []
    path.write_bytes(b"PAR1")
    with pytest.raises(ViewerError, match="变化"):
        engine.get(dataset.id)


def test_cell_budget(engine, tmp_path):
    path = tmp_path / "long.parquet"
    pq.write_table(pa.table({"long": ["x" * 10000], "f": [float("nan")]}), path)
    dataset = engine.register(path)
    result = engine.page(dataset.id, PageQuery())
    assert result["truncated"] == [[0, 0]]
    assert len(result["rows"][0][0]) == 4096
    assert result["rows"][0][1] == "nan"
    assert preview(list(range(1000)))[1] is True


def test_resource_slot_limit(engine, parquet):
    dataset = engine.register(parquet)
    engine.slots.acquire()
    engine.slots.acquire()
    try:
        with pytest.raises(ViewerError) as error:
            engine.page(dataset.id, PageQuery())
        assert error.value.status == 429
    finally:
        engine.slots.release()
        engine.slots.release()


def test_invalid_and_local_file_not_deleted(engine, parquet, tmp_path):
    bad = tmp_path / "bad.parquet"
    bad.write_text("not parquet")
    with pytest.raises(ViewerError):
        engine.register(bad)
    dataset = engine.register(parquet)
    assert engine.register(parquet).id == dataset.id
    engine.remove(dataset.id)
    assert parquet.exists()
