from pathlib import Path

from unittest.mock import MagicMock, patch

import Scripts.GetOrderInquiry as get_order_inquiry


def test_bootstrap_gettask_output_runs_gettask_when_missing(tmp_path: Path, monkeypatch):
    scripts_dir = tmp_path / "Scripts"
    outputs_dir = scripts_dir / "outputs" / "GetTask"
    outputs_dir.mkdir(parents=True)
    gettask_script = scripts_dir / "GetTask.py"
    gettask_script.write_text("print('ok')", encoding="utf-8")

    monkeypatch.setattr(get_order_inquiry, "SCRIPTS_DIR", scripts_dir)
    monkeypatch.setattr(get_order_inquiry, "GETTASK_CSV", outputs_dir / "data.csv")

    completed = MagicMock()
    completed.stdout = "bootstrap ok\n"
    completed.stderr = ""
    completed.returncode = 0

    with patch.object(get_order_inquiry.subprocess, "run", return_value=completed) as mocked_run:
        result = get_order_inquiry._bootstrap_gettask_output()

    assert result is False
    mocked_run.assert_called_once()
