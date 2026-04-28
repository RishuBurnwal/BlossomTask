import unittest
import sys
import tempfile
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

    def test_kill_ports_for_server_restart_counts_results(self):
        with patch.object(main, "_get_pids_on_port", side_effect=[{101, 202}, {202, 303}]):
            with patch.object(main, "_kill_pid", side_effect=lambda pid: pid != 303):
                killed, failed = main._kill_ports_for_server_restart([8787, 8080])
        self.assertEqual(killed, 2)
        self.assertEqual(failed, 1)

    def test_wait_for_http_health_success_with_curl(self):
        fake_result = SimpleNamespace(returncode=0, stdout='{"ok":true}')
        with patch.object(main.shutil, "which", return_value="curl"):
            with patch.object(main.subprocess, "run", return_value=fake_result):
                ok, body = main._wait_for_http_health("http://localhost:8787/api/health", timeout_seconds=1)
        self.assertTrue(ok)
        self.assertEqual(body, '{"ok":true}')

    def test_kill_pid_rejects_non_positive_pid(self):
        self.assertFalse(main._kill_pid(0))
        self.assertFalse(main._kill_pid(-10))

    def test_access_control_command_can_set_reverify_provider(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            temp_db_path = Path(temp_dir) / "blossomtask.sqlite"
            original_auth_db_connection = main._auth_db_connection
            with patch.object(main, "AUTH_DB_PATH", temp_db_path):
                bootstrap_conn = original_auth_db_connection()
                try:
                    self.assertEqual(main._get_setting(bootstrap_conn, "reverify_default_provider", "perplexity"), "perplexity")
                finally:
                    bootstrap_conn.close()

                provider_conn = original_auth_db_connection()
                try:
                    main._set_reverify_default_provider(provider_conn, "openai")
                    provider = main._get_setting(provider_conn, "reverify_default_provider", "perplexity")
                finally:
                    provider_conn.close()

        self.assertEqual(provider, "openai")

    def test_run_script_injects_active_model_and_reverify_provider(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            temp_path = Path(temp_dir)
            script_path = temp_path / "reverify.py"
            script_path.write_text("print('ok')", encoding="utf-8")
            temp_db_path = temp_path / "blossomtask.sqlite"
            original_auth_db_connection = main._auth_db_connection

            with patch.object(main, "SCRIPTS_DIR", temp_path), patch.object(main, "AUTH_DB_PATH", temp_db_path):
                conn = original_auth_db_connection()
                try:
                    main._set_active_model(conn, "gpt-4o-search-preview")
                    main._ensure_setting(conn, "reverify_default_provider", "openai")
                finally:
                    conn.close()

                captured = {}

                def fake_run(cmd, cwd=None, env=None):
                    captured["cmd"] = cmd
                    captured["cwd"] = cwd
                    captured["env"] = env
                    return SimpleNamespace(returncode=0)

                with patch.object(main.subprocess, "run", side_effect=fake_run), patch.object(main, "find_python", return_value="python"):
                    result = main.run_script("reverify", ["--source", "both"])

        self.assertTrue(result)
        self.assertEqual(captured["env"]["OPENAI_MODEL"], "gpt-4o-search-preview")
        self.assertEqual(captured["env"]["PERPLEXITY_MODEL"], "sonar-pro")
        self.assertEqual(captured["env"]["REVERIFY_DEFAULT_PROVIDER"], "openai")


if __name__ == "__main__":
    unittest.main()
