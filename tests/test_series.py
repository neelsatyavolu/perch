import pytest

from perchtools.series import SeriesError, read_series


def _series(tmp_path, text, files=("perch/a.patch",)):
    for name in files:
        (tmp_path / name).parent.mkdir(parents=True, exist_ok=True)
        (tmp_path / name).write_text("")
    (tmp_path / "series").write_text(text)
    return tmp_path / "series"


def test_read_series_skips_comments(tmp_path):
    assert read_series(_series(tmp_path, "# x\n\nperch/a.patch\n")) == ["perch/a.patch"]


def test_read_series_strips_whitespace(tmp_path):
    assert read_series(_series(tmp_path, "  perch/a.patch  \n")) == ["perch/a.patch"]


def test_read_series_rejects_duplicates(tmp_path):
    with pytest.raises(SeriesError):
        read_series(_series(tmp_path, "perch/a.patch\nperch/a.patch\n"))


def test_read_series_rejects_missing_file(tmp_path):
    with pytest.raises(SeriesError, match="perch/missing.patch"):
        read_series(_series(tmp_path, "perch/missing.patch\n"))


def test_read_series_missing_series_file_is_empty(tmp_path):
    assert read_series(tmp_path / "series") == []
