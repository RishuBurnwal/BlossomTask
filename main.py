#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parent
BACKEND_URL = "http://localhost:8787"
FRONTEND_URL = "http://localhost:8080"
REQUIRED_PORTS = (8787, 8080)
REQUIRED_SCRIPT_IDS = {"get-task", "get-order-inquiry", "funeral-finder", "updater", "closing-task"}


def _print(message: str) -> None:
    print(f"[main.py] {message}")


def ensure_command(name: str) -> str:
    path = shutil.which(name)
    if not path:
        raise RuntimeError(f"Required command not found in PATH: {name}")
    return path


def _find_pids_for_port(port: int) -> set[int]:
    pids: set[int] = set()

    lsof_bin = shutil.which("lsof")
    if lsof_bin:
        result = subprocess.run(
            [lsof_bin, "-t", f"-iTCP:{port}", "-sTCP:LISTEN"],
            capture_output=True,
            text=True,
            check=False,
        )
        for token in result.stdout.split():
            if token.isdigit():
                pids.add(int(token))

    if pids:
        return pids

    fuser_bin = shutil.which("fuser")
    if fuser_bin:
        result = subprocess.run(
            [fuser_bin, f"{port}/tcp"],
            capture_output=True,
            text=True,
            check=False,
        )
        for token in re.findall(r"\d+", (result.stdout or "") + " " + (result.stderr or "")):
            pids.add(int(token))

    return pids


def kill_required_ports(ports: tuple[int, ...] = REQUIRED_PORTS) -> None:
    own_pid = os.getpid()
    for port in ports:
        pids = {pid for pid in _find_pids_for_port(port) if pid != own_pid}
        if not pids:
            continue

        _print(f"Port {port} busy. Stopping processes: {sorted(pids)}")
        for pid in pids:
            try:
                os.kill(pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            except PermissionError:
                _print(f"Permission denied while terminating PID {pid} on port {port}")

        time.sleep(0.8)

        survivors = {pid for pid in pids if Path(f"/proc/{pid}").exists()}
        for pid in survivors:
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            except PermissionError:
                _print(f"Permission denied while force-killing PID {pid} on port {port}")


def wait_for_backend(timeout_seconds: float = 20.0) -> bool:
    deadline = time.time() + timeout_seconds
    while time.time() < deadline:
        try:
            data = http_json("GET", "/api/health")
            if data.get("ok") is True:
                return True
        except Exception:
            pass
        time.sleep(0.4)
    return False


def is_backend_running() -> bool:
    try:
        data = http_json("GET", "/api/health")
        return data.get("ok") is True
    except Exception:
        return False


def launch_ui() -> int:
    node_bin = ensure_command("node")
    backend = None

    kill_required_ports()

    _print("Starting backend server...")
    backend = subprocess.Popen(
        [node_bin, "backend/server.js"],
        cwd=str(ROOT),
        stdout=sys.stdout,
        stderr=sys.stderr,
    )

    try:
        if not wait_for_backend(20):
            _print("Backend failed to become healthy within timeout")
            if backend and backend.poll() is None:
                backend.terminate()
            return 1

        _print("Starting frontend dev server (Vite)...")
        vite_cli = ROOT / "node_modules" / "vite" / "bin" / "vite.js"
        if not vite_cli.exists():
            _print("Vite CLI not found in node_modules. Installing dependencies with npm install...")
            npm_bin = ensure_command("npm")
            install = subprocess.run([npm_bin, "install"], cwd=str(ROOT), check=False)
            if install.returncode != 0:
                _print("npm install failed; cannot start frontend")
                return int(install.returncode)
            if not vite_cli.exists():
                _print(f"Vite CLI is still missing after install: {vite_cli}")
                return 1

        frontend_cmd = [node_bin, str(vite_cli)]
        _print(f"Frontend command: {' '.join(frontend_cmd)}")
        frontend = subprocess.Popen(
            frontend_cmd,
            cwd=str(ROOT),
            stdout=sys.stdout,
            stderr=sys.stderr,
        )

        _print(f"Opening UI in browser: {FRONTEND_URL}")
        webbrowser.open(FRONTEND_URL)
        _print("UI stack is running. Press Ctrl+C to stop backend + frontend.")

        while True:
            if backend.poll() is not None:
                _print("Backend process exited")
                return int(backend.returncode or 1)
            if frontend.poll() is not None:
                _print("Frontend process exited")
                return int(frontend.returncode or 1)
            time.sleep(1)
    except KeyboardInterrupt:
        _print("Stopping UI stack...")
        return 0
    finally:
        owned_processes = [locals().get("frontend")]
        owned_processes.append(backend)

        for proc in owned_processes:
            if proc and proc.poll() is None:
                proc.send_signal(signal.SIGTERM)
        time.sleep(0.6)
        for proc in owned_processes:
            if proc and proc.poll() is None:
                proc.kill()


def http_json(method: str, path: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
    url = f"{BACKEND_URL}{path}"
    data = None
    headers = {"Content-Type": "application/json"}
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")

    req = urllib.request.Request(url, method=method.upper(), data=data, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=15) as response:
            body = response.read().decode("utf-8")
            return json.loads(body) if body else {}
    except urllib.error.HTTPError as exc:
        message = exc.read().decode("utf-8", errors="ignore")
        raise RuntimeError(f"HTTP {exc.code} for {path}: {message}") from exc


def verify_frontend_connections() -> int:
    ensure_command("node")

    _print("Verifying frontend/backend/script integration...")
    backend = None
    if not is_backend_running():
        backend = subprocess.Popen(
            ["node", "backend/server.js"],
            cwd=str(ROOT),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )

    try:
        if not wait_for_backend(20):
            _print("FAIL: backend health endpoint not ready")
            return 1

        scripts = http_json("GET", "/api/scripts").get("scripts", [])
        script_ids = {item.get("id") for item in scripts}
        required_ids = REQUIRED_SCRIPT_IDS
        if script_ids != required_ids:
            _print(f"FAIL: script catalog mismatch. expected={required_ids}, actual={script_ids}")
            return 1
        _print("PASS: script catalog is connected")

        datasets = http_json("GET", "/api/data/datasets").get("datasets", {})
        for key in ("main", "error", "low", "review"):
            if key not in datasets:
                _print(f"FAIL: dataset key missing -> {key}")
                return 1
        _print("PASS: data viewer datasets endpoint is connected")

        entries = http_json("GET", "/api/files/tree?path=&recursive=1").get("entries", [])
        if not entries:
            _print("FAIL: file tree is empty")
            return 1
        _print("PASS: recursive file navigation endpoint is connected")

        content = http_json("GET", "/api/files/content?path=Funeral_Finder/Funeral_data.csv&limit=1")
        parsed = content.get("parsed", [])
        order_id = ""
        if parsed:
            row = parsed[0]
            order_id = str(row.get("ord_id") or row.get("orderId") or "").strip()

        if not order_id:
            _print("FAIL: could not read a test order id for compare endpoint")
            return 1

        compare = http_json(
            "POST",
            "/api/compare/order-id",
            {
                "orderId": order_id,
                "files": ["Funeral_Finder/Funeral_data.csv", "Funeral_Finder/Funeral_data.csv"],
            },
        )
        if not isinstance(compare.get("matches"), list) or not isinstance(compare.get("differences"), list):
            _print("FAIL: comparison endpoint payload is invalid")
            return 1
        _print(
            f"PASS: live comparison endpoint is connected (orderId={order_id}, matches={len(compare['matches'])}, differences={len(compare['differences'])})"
        )

        _print("Integration verification PASSED")
        return 0
    finally:
        if backend and backend.poll() is None:
            backend.terminate()
            try:
                backend.wait(timeout=3)
            except subprocess.TimeoutExpired:
                backend.kill()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="UI launcher (backend + frontend)")
    parser.add_argument("--ui", action="store_true", help="Launch backend + frontend UI")
    parser.add_argument("--verify", action="store_true", help="Run API integration verification checks")
    return parser.parse_args()


def main() -> int:
    args = parse_args()

    if args.verify:
        return verify_frontend_connections()

    if args.ui:
        return launch_ui()

    return launch_ui()


if __name__ == "__main__":
    raise SystemExit(main())
