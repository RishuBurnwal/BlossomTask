import unittest
import sys
from types import SimpleNamespace
from unittest.mock import patch
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import main


class MainHelperTests(unittest.TestCase):
    def test_parse_netstat_pids_filters_listening_rows(self):
        output = """
  TCP    0.0.0.0:8080           0.0.0.0:0              LISTENING       1200
  TCP    127.0.0.1:8080         127.0.0.1:54000        ESTABLISHED     1200
  TCP    [::]:8080              [::]:0                 LISTENING       1500
  TCP    0.0.0.0:8787           0.0.0.0:0              LISTENING       2200
"""
        pids = main._parse_netstat_pids(output, 8080)
        self.assertEqual(pids, {1200, 1500})

    def test_get_pids_on_port_windows_uses_netstat_parser(self):
        fake_output = "TCP    0.0.0.0:8787           0.0.0.0:0              LISTENING       4321\n"
        with patch.object(main.os, "name", "nt"):
            with patch.object(main.subprocess, "run", return_value=SimpleNamespace(stdout=fake_output)):
                pids = main._get_pids_on_port(8787)
        self.assertEqual(pids, {4321})

    def test_parse_netstat_pids_does_not_match_partial_port(self):
        output = """
  TCP    0.0.0.0:8080           0.0.0.0:0              LISTENING       1200
  TCP    [::]:8080              [::]:0                 LISTENING       1500
"""
        pids = main._parse_netstat_pids(output, 80)
        self.assertEqual(pids, set())

    def test_kill_pid_windows_success(self):
        with patch.object(main.os, "name", "nt"):
            with patch.object(main.subprocess, "run", return_value=SimpleNamespace(returncode=0)):
                self.assertTrue(main._kill_pid(9999))

    def test_get_pids_on_port_uses_ss_when_lsof_empty(self):
        lsof_result = SimpleNamespace(stdout="")
        ss_result = SimpleNamespace(
            stdout='LISTEN 0 128 127.0.0.1:8787 0.0.0.0:* users:(("node",pid=777,fd=24))\n'
        )
        with patch.object(main.os, "name", "posix"):
            with patch.object(main.subprocess, "run", side_effect=[lsof_result, ss_result]):
                pids = main._get_pids_on_port(8787)
        self.assertEqual(pids, {777})

    def test_kill_pid_rejects_non_positive_pid(self):
        self.assertFalse(main._kill_pid(0))
        self.assertFalse(main._kill_pid(-10))


if __name__ == "__main__":
    unittest.main()
