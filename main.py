#!/usr/bin/env python3
"""
BlossomTask – Professional CLI Launcher & Pipeline Orchestrator
===============================================================
Interactive menu-driven interface for managing the BlossomTask
funeral order automation pipeline.

Usage:
    python main.py                   # Interactive menu (default)
    python main.py --ui              # Launch full-stack UI directly
    python main.py --ui --background # Launch UI servers detached
    python main.py --stage search    # Run a specific pipeline stage
    python main.py --help            # Show all CLI options
"""

import argparse
import builtins
import json
import hashlib
import subprocess
import sys
import os
import time
import webbrowser
import signal
import shutil
import platform
import socket
import sqlite3
import secrets
import stat
from urllib.parse import urlparse
from urllib.request import urlopen
from pathlib import Path

# ── Paths ────────────────────────────────────────────────────────────────────
ROOT = Path(__file__).resolve().parent
SCRIPTS_DIR = ROOT / "Scripts"
BACKEND_DIR = ROOT / "backend"
REQUIREMENTS_TXT = ROOT / "requirements.txt"
PACKAGE_JSON = ROOT / "package.json"
ENV_FILE = ROOT / ".env"
DOCKERFILE = ROOT / "Dockerfile"
DOCKER_COMPOSE = ROOT / "docker-compose.yml"
AUTH_DB_PATH = BACKEND_DIR / "data" / "blossomtask.sqlite"
DEFAULT_SESSION_MINUTES = int(os.getenv("SESSION_TTL_MINUTES", "480"))
AVAILABLE_MODELS = [
    "sonar-pro",
    "sonar",
    "sonar-reasoning",
    "gpt-4o-search-preview",
    "gpt-4.1-mini",
]
DEFAULT_OPENAI_MODEL = "gpt-4o-search-preview"
DEFAULT_PERPLEXITY_MODEL = "sonar-pro"
REVERIFY_PROVIDER_OPTIONS = ["perplexity", "openai"]


def _safe_input(prompt=""):
    try:
        return builtins.input(prompt)
    except (KeyboardInterrupt, EOFError):
        print(f"\n  {C.CYAN}👋 Goodbye!{C.RESET}\n")
        sys.exit(0)


input = _safe_input

# ── Version & Branding ──────────────────────────────────────────────────────
VERSION = "2.0.0"
APP_NAME = "BlossomTask"
TAGLINE = "Funeral Order Automation Pipeline"

# ── Default Ports ────────────────────────────────────────────────────────────
DEFAULT_FRONTEND_PORT = 8080
DEFAULT_BACKEND_PORT = 8787
LOGS_DIR = ROOT / "outputs" / "logs"
BG_STATE_FILE = LOGS_DIR / "background_servers.json"
PROJECT_REMOTE_URL = "https://github.com/RishuBurnwal/BlossomTask"
UPDATE_MANIFEST_PATH = ROOT / "project_update_manifest.json"

# ── Colors (ANSI) ───────────────────────────────────────────────────────────
class C:
    """ANSI color codes for terminal output."""
    RESET   = "\033[0m"
    BOLD    = "\033[1m"
    DIM     = "\033[2m"
    RED     = "\033[91m"
    GREEN   = "\033[92m"
    YELLOW  = "\033[93m"
    BLUE    = "\033[94m"
    MAGENTA = "\033[95m"
    CYAN    = "\033[96m"
    WHITE   = "\033[97m"
    BG_BLUE = "\033[44m"
    BG_GREEN = "\033[42m"

    @staticmethod
    def supports_color():
        """Check if the terminal supports ANSI colors."""
        if os.name == 'nt':
            # Enable ANSI on Windows 10+
            try:
                import ctypes
                kernel32 = ctypes.windll.kernel32
                kernel32.SetConsoleMode(kernel32.GetStdHandle(-11), 7)
                return True
            except Exception:
                return False
        return hasattr(sys.stdout, 'isatty') and sys.stdout.isatty()


# Disable colors if terminal doesn't support them
if not C.supports_color():
    for attr in dir(C):
        if attr.isupper() and not attr.startswith('_'):
            setattr(C, attr, '')


# ── Utility Functions ────────────────────────────────────────────────────────

def clear_screen():
    os.system('cls' if os.name == 'nt' else 'clear')


def print_banner():
    """Display the application banner."""
    banner = f"""
{C.CYAN}{C.BOLD}╔══════════════════════════════════════════════════════════════╗
║                                                              ║
║   🌸  {APP_NAME} v{VERSION}                                     ║
║       {TAGLINE}                        ║
║                                                              ║
║   Platform : {platform.system()} {platform.release():<20}                 ║
║   Python   : {platform.python_version():<20}                         ║
║   Node     : {get_node_version():<20}                         ║
║                                                              ║
╚══════════════════════════════════════════════════════════════╝{C.RESET}
"""
    print(banner)


def print_section(title, icon="📋"):
    """Print a section header."""
    print(f"\n{C.BOLD}{C.BLUE}{'─' * 60}{C.RESET}")
    print(f"  {icon}  {C.BOLD}{title}{C.RESET}")
    print(f"{C.BLUE}{'─' * 60}{C.RESET}\n")


def print_success(msg):
    print(f"  {C.GREEN}✅ {msg}{C.RESET}")


def print_error(msg):
    print(f"  {C.RED}❌ {msg}{C.RESET}")


def print_warn(msg):
    print(f"  {C.YELLOW}⚠️  {msg}{C.RESET}")


def print_info(msg):
    print(f"  {C.CYAN}ℹ️  {msg}{C.RESET}")


def print_step(num, msg):
    print(f"  {C.MAGENTA}[{num}]{C.RESET} {msg}")


def get_node_version():
    """Get installed Node.js version."""
    try:
        result = subprocess.run(
            ["node", "--version"],
            capture_output=True, text=True, timeout=5
        )
        return result.stdout.strip() if result.returncode == 0 else "Not installed"
    except Exception:
        return "Not installed"


def get_npm_version():
    """Get installed npm version."""
    try:
        result = subprocess.run(
            ["npm", "--version"],
            capture_output=True, text=True, timeout=5,
            shell=(sys.platform == "win32")
        )
        return result.stdout.strip() if result.returncode == 0 else "Not installed"
    except Exception:
        return "Not installed"


def get_docker_version():
    """Get installed Docker version."""
    try:
        result = subprocess.run(
            ["docker", "--version"],
            capture_output=True, text=True, timeout=5
        )
        return result.stdout.strip() if result.returncode == 0 else None
    except Exception:
        return None


def is_port_in_use(port):
    """Check if a port is currently in use."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        return s.connect_ex(('localhost', port)) == 0


def _record_background_servers(frontend_port, backend_port, frontend_pid, backend_pid):
    """Persist background server PIDs so they can be stopped later."""
    LOGS_DIR.mkdir(parents=True, exist_ok=True)
    payload = {
        "frontend_port": frontend_port,
        "backend_port": backend_port,
        "frontend_pid": frontend_pid,
        "backend_pid": backend_pid,
        "updated_at": int(time.time()),
    }
    with open(BG_STATE_FILE, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2)


def _load_background_servers():
    """Load persisted background server metadata, if available."""
    if not BG_STATE_FILE.exists():
        return None
    try:
        with open(BG_STATE_FILE, "r", encoding="utf-8") as handle:
            return json.load(handle)
    except Exception:
        return None


def _clear_background_servers():
    """Remove persisted background server metadata."""
    try:
        BG_STATE_FILE.unlink(missing_ok=True)
    except Exception:
        pass


def _parse_netstat_pids(netstat_output, port):
    """Parse Windows netstat output and extract listening PIDs for a TCP port."""
    pids = set()
    for line in netstat_output.splitlines():
        parts = line.split()
        if len(parts) < 5:
            continue
        local_addr = parts[1]
        state = parts[3]
        pid_value = parts[4]

        if ":" not in local_addr:
            continue
        local_port = local_addr.rsplit(":", 1)[-1]
        if not local_port.isdigit() or int(local_port) != int(port):
            continue
        if state.upper() != "LISTENING":
            continue
        if pid_value.isdigit():
            pids.add(int(pid_value))
    return pids


def _get_pids_on_port(port):
    """Return a set of PIDs listening on the requested port."""
    if os.name == "nt":
        try:
            result = subprocess.run(
                ["netstat", "-ano", "-p", "tcp"],
                capture_output=True,
                text=True,
                timeout=8,
                check=False,
            )
            return _parse_netstat_pids(result.stdout, port)
        except Exception:
            return set()

    probes = [
        ["lsof", "-ti", f"tcp:{port}"],
        ["ss", "-ltnp"],
    ]
    for cmd in probes:
        try:
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=8,
                check=False,
            )
        except Exception:
            continue

        if cmd[0] == "lsof":
            lsof_pids = {int(line.strip()) for line in result.stdout.splitlines() if line.strip().isdigit()}
            if lsof_pids:
                return lsof_pids
            continue

        pids = set()
        for line in result.stdout.splitlines():
            if f":{port} " not in line and not line.rstrip().endswith(f":{port}"):
                continue
            if "pid=" not in line:
                continue
            pid_frag = line.split("pid=", 1)[1].split(",", 1)[0].strip()
            if pid_frag.isdigit():
                pids.add(int(pid_frag))
        if pids:
            return pids

    return set()


def _kill_pid(pid):
    """Force kill a process tree for a PID."""
    if pid <= 0:
        return False
    try:
        if os.name == "nt":
            result = subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"], check=False)
            return result.returncode == 0

        os.kill(pid, signal.SIGTERM)
        return True
    except Exception:
        return False


def _run_git_command(args, *, capture_output=True, check=False):
    """Run a git command from the project root."""
    return subprocess.run(
        ["git", *args],
        cwd=str(ROOT),
        capture_output=capture_output,
        text=True,
        check=check,
    )


def _git_available():
    try:
        result = _run_git_command(["--version"])
        return result.returncode == 0
    except Exception:
        return False


def _is_git_repo():
    try:
        result = _run_git_command(["rev-parse", "--is-inside-work-tree"])
        return result.returncode == 0 and result.stdout.strip().lower() == "true"
    except Exception:
        return False


def _sha256_file(path_obj):
    digest = hashlib.sha256()
    with open(path_obj, "rb") as handle:
        while True:
            chunk = handle.read(1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


def _tracked_file_hash_entries():
    result = _run_git_command(["ls-files", "-z"])
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or "Unable to enumerate tracked files")
    entries = []
    for rel_path in [item for item in result.stdout.split("\0") if item]:
        absolute_path = ROOT / rel_path
        if not absolute_path.exists() or not absolute_path.is_file():
            continue
        entries.append({
            "path": rel_path.replace("\\", "/"),
            "size": absolute_path.stat().st_size,
            "sha256": _sha256_file(absolute_path),
        })
    entries.sort(key=lambda item: item["path"])
    manifest_digest = hashlib.sha256(
        "\n".join(f"{item['path']}:{item['sha256']}" for item in entries).encode("utf-8")
    ).hexdigest()
    return entries, manifest_digest


def _write_update_manifest(payload):
    with open(UPDATE_MANIFEST_PATH, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2)


def _project_update_manager(remote_name="origin", remote_url=PROJECT_REMOTE_URL, allow_dirty=False, auto_confirm=False):
    """Verify git state, sync from GitHub, and generate a hash manifest."""
    print_section("Project Update Manager", "🔄")

    if not _git_available():
        print_error("Git is not installed or not available in PATH.")
        return False
    if not _is_git_repo():
        print_error("This folder is not a git repository.")
        return False

    current_branch_result = _run_git_command(["branch", "--show-current"])
    current_branch = current_branch_result.stdout.strip() or "main"

    existing_remote_result = _run_git_command(["remote", "get-url", remote_name])
    if existing_remote_result.returncode != 0:
        add_remote_result = _run_git_command(["remote", "add", remote_name, remote_url], capture_output=True)
        if add_remote_result.returncode != 0:
            print_error(add_remote_result.stderr.strip() or f"Failed to add remote '{remote_name}'")
            return False
        print_success(f"Added remote '{remote_name}' -> {remote_url}")
    else:
        existing_remote = existing_remote_result.stdout.strip()
        if existing_remote != remote_url:
            set_remote_result = _run_git_command(["remote", "set-url", remote_name, remote_url], capture_output=True)
            if set_remote_result.returncode != 0:
                print_error(set_remote_result.stderr.strip() or f"Failed to update remote '{remote_name}'")
                return False
            print_warn(f"Remote '{remote_name}' URL was updated to {remote_url}")

    status_result = _run_git_command(["status", "--short"])
    dirty_entries = [line for line in status_result.stdout.splitlines() if line.strip()]
    if dirty_entries and not allow_dirty:
        print_warn("Working tree has local changes. Update aborted to protect in-progress work.")
        for line in dirty_entries[:15]:
            print(f"    {line}")
        print_info("Use a clean worktree before pulling updates.")
        return False

    local_head_before = _run_git_command(["rev-parse", "HEAD"]).stdout.strip()
    fetch_result = _run_git_command(["fetch", remote_name, "--prune"], capture_output=True)
    if fetch_result.returncode != 0:
        print_error(fetch_result.stderr.strip() or "git fetch failed")
        return False

    remote_head_ref_result = _run_git_command(["symbolic-ref", f"refs/remotes/{remote_name}/HEAD"])
    if remote_head_ref_result.returncode == 0 and remote_head_ref_result.stdout.strip():
        remote_ref = remote_head_ref_result.stdout.strip().replace("refs/remotes/", "")
    else:
        remote_ref = f"{remote_name}/{current_branch}"

    remote_branch = remote_ref.split("/", 1)[1] if "/" in remote_ref else current_branch
    remote_head_result = _run_git_command(["rev-parse", remote_ref])
    if remote_head_result.returncode != 0:
        print_error(remote_head_result.stderr.strip() or f"Unable to resolve {remote_ref}")
        return False
    remote_head = remote_head_result.stdout.strip()

    ahead_behind_result = _run_git_command(["rev-list", "--left-right", "--count", f"HEAD...{remote_ref}"])
    ahead = 0
    behind = 0
    if ahead_behind_result.returncode == 0:
        counts = ahead_behind_result.stdout.strip().split()
        if len(counts) == 2:
            ahead = int(counts[0] or 0)
            behind = int(counts[1] or 0)

    changed_files_result = _run_git_command(["diff", "--name-only", f"HEAD..{remote_ref}"])
    changed_files = [line.strip() for line in changed_files_result.stdout.splitlines() if line.strip()]

    print_info(f"Branch: {current_branch}")
    print_info(f"Remote: {remote_name} -> {remote_url}")
    print_info(f"Remote branch: {remote_branch}")
    print_info(f"Local HEAD:  {local_head_before}")
    print_info(f"Remote HEAD: {remote_head}")
    print_info(f"Ahead: {ahead} | Behind: {behind}")

    if ahead > 0 and behind == 0:
        print_warn("Local branch is ahead of remote. Auto-pull skipped to avoid overwriting unpublished local commits.")
    elif ahead > 0 and behind > 0:
        print_warn("Local branch has diverged from remote. Resolve divergence manually before updating.")
        return False

    should_pull = behind > 0 and ahead == 0
    if should_pull and not auto_confirm:
        confirm = _ask_yes_no(f"Pull {behind} remote update(s) from {remote_name}/{remote_branch}?", default=True)
        if not confirm:
            print_warn("Update cancelled by user.")
            return False

    pulled = False
    if should_pull:
        pull_result = _run_git_command(["pull", "--ff-only", remote_name, remote_branch], capture_output=True)
        if pull_result.returncode != 0:
            print_error(pull_result.stderr.strip() or "git pull --ff-only failed")
            return False
        pulled = True
        print_success(f"Fast-forward pull completed from {remote_name}/{remote_branch}")
    else:
        print_info("No pull needed. Repository is already up to date or requires manual reconciliation.")

    local_head_after = _run_git_command(["rev-parse", "HEAD"]).stdout.strip()
    fsck_result = _run_git_command(["fsck", "--full"], capture_output=True)
    fsck_ok = fsck_result.returncode == 0
    if fsck_ok:
        print_success("git fsck verification passed")
    else:
        print_warn(fsck_result.stderr.strip() or fsck_result.stdout.strip() or "git fsck reported issues")

    tracked_entries, manifest_digest = _tracked_file_hash_entries()
    changed_file_hashes = []
    for rel_path in changed_files:
        file_path = ROOT / rel_path
        if file_path.exists() and file_path.is_file():
            changed_file_hashes.append({
                "path": rel_path.replace("\\", "/"),
                "sha256": _sha256_file(file_path),
                "size": file_path.stat().st_size,
            })

    manifest_payload = {
        "generated_at": int(time.time()),
        "remote_name": remote_name,
        "remote_url": remote_url,
        "branch": current_branch,
        "remote_branch": remote_branch,
        "local_head_before": local_head_before,
        "local_head_after": local_head_after,
        "remote_head": remote_head,
        "pulled": pulled,
        "ahead_before": ahead,
        "behind_before": behind,
        "dirty_before": dirty_entries,
        "changed_files_from_remote": changed_files,
        "changed_file_hashes": changed_file_hashes,
        "tracked_file_count": len(tracked_entries),
        "tracked_manifest_sha256": manifest_digest,
        "tracked_files": tracked_entries,
        "git_fsck_ok": fsck_ok,
    }
    _write_update_manifest(manifest_payload)
    print_success(f"Update manifest written to {UPDATE_MANIFEST_PATH.name}")
    return True


def _background_start_menu():
    """Start dashboard servers detached and return control immediately."""
    print_section("Background Dashboard Mode", "🧵")
    print_info("Starting frontend + backend in detached mode...")
    success = launch_ui(background=True)
    if success:
        print_success("Terminal control returned. Servers are running in background.")
    else:
        print_error("Could not start background servers.")


def _run_shell_command(cmd, *, cwd=None, shell=False):
    """Run a command and return True when it exits with code 0."""
    result = subprocess.run(cmd, cwd=cwd or str(ROOT), shell=shell)
    return result.returncode == 0


def _wait_for_http_health(url, timeout_seconds=30):
    """Poll a local HTTP endpoint until it responds successfully or times out."""
    curl_bin = shutil.which("curl")
    deadline = time.time() + timeout_seconds
    while time.time() < deadline:
        try:
            if curl_bin:
                result = subprocess.run(
                    [curl_bin, "-fsS", url],
                    capture_output=True,
                    text=True,
                    timeout=5,
                    check=False,
                )
                if result.returncode == 0:
                    return True, result.stdout.strip()
            else:
                parsed = urlparse(url)
                host = parsed.hostname or "127.0.0.1"
                port = parsed.port or (443 if parsed.scheme == "https" else 80)
                path = parsed.path or "/"
                query = f"?{parsed.query}" if parsed.query else ""
                target = f"{parsed.scheme or 'http'}://{host}:{port}{path}{query}"
                with urlopen(target, timeout=5) as response:
                    if response.status < 400:
                        return True, response.read().decode("utf-8", errors="replace").strip()
        except Exception:
            pass
        time.sleep(1)
    return False, "health check timeout"


def _sync_dist_to_root():
    """Copy built frontend artifacts from dist/ into project root for static serving."""
    dist_dir = ROOT / "dist"
    if not dist_dir.exists():
        return False, "dist directory not found"

    copied = 0
    for item in dist_dir.iterdir():
        target = ROOT / item.name
        try:
            if item.is_dir():
                if target.exists():
                    shutil.rmtree(target)
                shutil.copytree(item, target)
            else:
                shutil.copy2(item, target)
            copied += 1
        except Exception as exc:
            return False, f"Failed to copy {item.name}: {exc}"

    if copied == 0:
        return False, "dist is empty"
    return True, f"Copied {copied} artifact(s)"


def _kill_ports_for_server_restart(ports):
    """Kill listener PIDs for selected ports and return summary counts."""
    killed = 0
    failed = 0
    seen = set()
    for port in ports:
        pids = _get_pids_on_port(port)
        for pid in sorted(pids):
            if pid in seen:
                continue
            seen.add(pid)
            if _kill_pid(pid):
                killed += 1
            else:
                failed += 1
    return killed, failed


def _wait_for_pid_on_port(port, pid, timeout_seconds=15):
    """Wait until a specific PID is observed listening on a target port."""
    deadline = time.time() + timeout_seconds
    while time.time() < deadline:
        if pid in _get_pids_on_port(port):
            return True
        time.sleep(0.5)
    return False


def _one_click_server_setup_menu():
    """Install, build, and run backend with conflict-safe startup for server use."""
    print_section("One-Click Server Setup", "🚀")
    print_info("This will install dependencies, build frontend, sync dist, and start backend.")

    confirm = input(f"  {C.YELLOW}Proceed with one-click setup? (y/N): {C.RESET}").strip().lower()
    if confirm not in ["y", "yes"]:
        print_info("Cancelled")
        return

    # On Linux servers, keep 8080 reserved for Apache/Nginx stack and only recycle backend port.
    ports_to_kill = [DEFAULT_BACKEND_PORT] if os.name != "nt" else [DEFAULT_FRONTEND_PORT, DEFAULT_BACKEND_PORT]
    print_info(f"Clearing required ports: {', '.join(str(p) for p in ports_to_kill)}")
    killed, failed = _kill_ports_for_server_restart(ports_to_kill)
    print_info(f"Port cleanup summary: killed={killed}, failed={failed}")
    if DEFAULT_BACKEND_PORT in ports_to_kill and is_port_in_use(DEFAULT_BACKEND_PORT):
        print_error(
            f"Port {DEFAULT_BACKEND_PORT} is still in use after cleanup; refusing to continue to avoid false success."
        )
        return

    print_step(1, "Installing Python dependencies")
    if REQUIREMENTS_TXT.exists():
        if not _run_shell_command([find_python(), "-m", "pip", "install", "-r", str(REQUIREMENTS_TXT)]):
            print_error("Python dependency installation failed")
            return
    else:
        print_warn("requirements.txt not found, skipping Python install")

    print_step(2, "Installing Node.js dependencies")
    npm_bin = shutil.which("npm") or "npm"
    use_shell = sys.platform == "win32"
    if not _run_shell_command([npm_bin, "install"], shell=use_shell):
        print_error("Node.js dependency installation failed")
        return

    print_step(3, "Building frontend production bundle")
    if not _run_shell_command([npm_bin, "run", "build"], shell=use_shell):
        print_error("Frontend build failed")
        return

    print_step(4, "Syncing dist artifacts for static serving")
    copied_ok, copied_message = _sync_dist_to_root()
    if not copied_ok:
        print_error(copied_message)
        return
    print_success(copied_message)

    print_step(5, "Starting backend in background")
    backend = launch_backend(DEFAULT_BACKEND_PORT, background=True)
    if backend is None or backend.poll() is not None:
        print_error("Backend failed to start")
        return

    if not _wait_for_pid_on_port(DEFAULT_BACKEND_PORT, backend.pid, timeout_seconds=15):
        _stop_process(backend)
        print_error(
            f"Backend PID {backend.pid} did not take ownership of port {DEFAULT_BACKEND_PORT}; another process may be active."
        )
        return

    print_step(6, "Verifying backend health")
    health_ok, health_response = _wait_for_http_health(f"http://localhost:{DEFAULT_BACKEND_PORT}/api/health")
    if not health_ok:
        _stop_process(backend)
        print_error(f"Backend health check failed: {health_response}")
        return

    print_success("One-click server setup completed")
    print_info(f"Backend health: {health_response}")
    print_info(f"Backend URL: http://localhost:{DEFAULT_BACKEND_PORT}/api/health")
    print_info("Frontend static root ready from built dist artifacts")


def _program_killer_menu():
    """Stop tracked dashboard processes and clear selected ports."""
    print_section("Program Killer", "☠️")

    tracked = _load_background_servers()
    tracked_fe = tracked.get("frontend_pid") if isinstance(tracked, dict) else None
    tracked_be = tracked.get("backend_pid") if isinstance(tracked, dict) else None

    print(f"  {C.BOLD}Tracked background PIDs:{C.RESET}")
    print(f"    Frontend PID : {tracked_fe or 'n/a'}")
    print(f"    Backend PID  : {tracked_be or 'n/a'}")
    print()
    print(f"  {C.BOLD}Options:{C.RESET}")
    print(f"    {C.CYAN}[1]{C.RESET} Kill tracked dashboard programs + default ports ({DEFAULT_FRONTEND_PORT}, {DEFAULT_BACKEND_PORT})")
    print(f"    {C.CYAN}[2]{C.RESET} Kill custom ports + tracked programs")
    print(f"    {C.CYAN}[0]{C.RESET} Back to main menu")
    print()

    choice = input(f"  {C.BOLD}Select option: {C.RESET}").strip()
    if choice == "0":
        return

    if choice == "1":
        ports = [DEFAULT_FRONTEND_PORT, DEFAULT_BACKEND_PORT]
    elif choice == "2":
        raw_ports = input("  Enter ports (comma separated): ").strip()
        try:
            ports = [int(item.strip()) for item in raw_ports.split(",") if item.strip()]
        except ValueError:
            print_error("Invalid port list")
            return
        if not ports:
            print_warn("No ports provided")
            return
    else:
        print_error("Invalid option")
        return

    confirm = input(f"  {C.YELLOW}This will force kill processes. Continue? (y/N): {C.RESET}").strip().lower()
    if confirm not in ["y", "yes"]:
        print_info("Cancelled")
        return

    to_kill = set()
    if isinstance(tracked_fe, int):
        to_kill.add(tracked_fe)
    if isinstance(tracked_be, int):
        to_kill.add(tracked_be)

    for port in ports:
        to_kill.update(_get_pids_on_port(port))

    if not to_kill:
        print_warn("No matching processes found")
        _clear_background_servers()
        return

    killed = 0
    failed = 0
    for pid in sorted(to_kill):
        if _kill_pid(pid):
            killed += 1
            print_success(f"Killed PID {pid}")
        else:
            failed += 1
            print_warn(f"Could not kill PID {pid}")

    _clear_background_servers()
    print_info(f"Requested ports: {', '.join(str(p) for p in ports)}")
    print_info(f"Summary: killed={killed}, failed={failed}")


def load_dotenv(path=".env"):
    """Load .env file into environment."""
    env_path = Path(path) if not isinstance(path, Path) else path
    if not env_path.exists():
        return
    with open(env_path, "r", encoding="utf-8") as f:
        for raw_line in f:
            line = raw_line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            key = key.strip()
            value = value.strip().strip('"').strip("'")
            if key:
                os.environ[key] = value


def find_python():
    """Find the best Python executable."""
    if sys.platform == "win32":
        return sys.executable
    for candidate in ["python3", "python"]:
        if shutil.which(candidate):
            return candidate
    return sys.executable


def _utc_now_iso():
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()) + ".000Z"


def _auth_db_connection():
    AUTH_DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(AUTH_DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS users (
          id TEXT PRIMARY KEY,
          username TEXT NOT NULL UNIQUE,
          password_hash TEXT NOT NULL,
          role TEXT NOT NULL CHECK (role IN ('admin', 'user')),
          active INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS sessions (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          last_seen_at TEXT NOT NULL,
          revoked_at TEXT,
          user_agent TEXT,
          ip_address TEXT,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        """
    )
    _seed_default_admin(conn)
    _ensure_setting(conn, "default_model", _get_setting(conn, "default_model", AVAILABLE_MODELS[0]))
    _ensure_setting(conn, "session_ttl_minutes", str(DEFAULT_SESSION_MINUTES))
    _ensure_setting(conn, "reverify_default_provider", _get_setting(conn, "reverify_default_provider", REVERIFY_PROVIDER_OPTIONS[0]))
    return conn


def _hash_password(password, salt=None):
    salt = salt or secrets.token_hex(16)
    derived = hashlib.pbkdf2_hmac("sha256", str(password).encode("utf-8"), bytes.fromhex(salt), 120000).hex()
    return f"{salt}:{derived}"


def _verify_password(password, stored_hash):
    try:
        salt, digest = str(stored_hash).split(":", 1)
    except ValueError:
        return False
    return _hash_password(password, salt) == f"{salt}:{digest}"


def _ensure_setting(conn, key, value):
    existing = conn.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
    if existing is None:
        conn.execute(
            "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)",
            (key, str(value), _utc_now_iso()),
        )
    else:
        conn.execute(
            "UPDATE settings SET value = ?, updated_at = ? WHERE key = ?",
            (str(value), _utc_now_iso(), key),
        )
    conn.commit()


def _get_setting(conn, key, default=""):
    row = conn.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
    return str(row["value"]) if row else default


def _seed_default_admin(conn):
    count = conn.execute("SELECT COUNT(*) AS count FROM users").fetchone()["count"]
    if count:
        creds_file = AUTH_DB_PATH.parent / "INITIAL_CREDENTIALS.txt"
        if creds_file.exists():
            print_warn(f"Initial admin credentials file still exists: {creds_file}")
            print_warn("Delete INITIAL_CREDENTIALS.txt after confirming admin access.")
        return
    username = os.getenv("BLOSSOMTASK_ADMIN_USERNAME", "admin").strip() or "admin"
    configured_password = os.getenv("BLOSSOMTASK_ADMIN_PASSWORD")
    password = configured_password or secrets.token_urlsafe(18)
    timestamp = _utc_now_iso()
    conn.execute(
        "INSERT INTO users (id, username, password_hash, role, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        (f"user_{int(time.time() * 1000)}", username.lower(), _hash_password(password), "admin", 1, timestamp, timestamp),
    )
    conn.commit()
    print_warn(f"Bootstrapped default admin user '{username.lower()}'")
    if not configured_password:
        creds_file = AUTH_DB_PATH.parent / "INITIAL_CREDENTIALS.txt"
        creds_file.write_text(
            "\n".join(
                [
                    "=== BlossomTask Initial Admin Credentials ===",
                    f"Username: {username.lower()}",
                    f"Password: {password}",
                    "",
                    "DELETE THIS FILE IMMEDIATELY AFTER FIRST LOGIN.",
                    "Do not share or commit this file.",
                    f"Generated: {timestamp}",
                    "",
                ]
            ),
            encoding="utf-8",
        )
        try:
            creds_file.chmod(stat.S_IRUSR | stat.S_IWUSR)
        except Exception:
            pass
        print_warn(f"Generated admin credentials saved to: {creds_file}")
        print_warn("Delete INITIAL_CREDENTIALS.txt after first login.")


def _list_users(conn):
    return conn.execute(
        "SELECT id, username, role, active, created_at AS createdAt, updated_at AS updatedAt FROM users ORDER BY created_at ASC",
    ).fetchall()


def _list_sessions(conn):
    return conn.execute(
        """
        SELECT s.id, s.user_id AS userId, s.created_at AS createdAt, s.expires_at AS expiresAt,
               s.last_seen_at AS lastSeenAt, s.revoked_at AS revokedAt,
               u.username, u.role
        FROM sessions s
        JOIN users u ON u.id = s.user_id
        ORDER BY s.created_at DESC
        """
    ).fetchall()


def _create_user(conn, username, password, role="user"):
    normalized_username = str(username or "").strip().lower()
    if not normalized_username:
        raise ValueError("username is required")
    if not str(password or "").strip():
        raise ValueError("password is required")
    if conn.execute("SELECT 1 FROM users WHERE username = ?", (normalized_username,)).fetchone():
        raise ValueError("username already exists")
    timestamp = _utc_now_iso()
    conn.execute(
        "INSERT INTO users (id, username, password_hash, role, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        (f"user_{int(time.time() * 1000)}", normalized_username, _hash_password(password), role, 1, timestamp, timestamp),
    )
    conn.commit()


def _delete_user(conn, username):
    normalized_username = str(username or "").strip().lower()
    if not normalized_username:
        raise ValueError("username is required")
    row = conn.execute("SELECT id, role FROM users WHERE username = ?", (normalized_username,)).fetchone()
    if row is None:
        raise ValueError("user not found")
    admins_remaining = conn.execute(
        "SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND id != ?",
        (row["id"],),
    ).fetchone()["count"]
    if row["role"] == "admin" and admins_remaining <= 0:
        raise ValueError("at least one admin account must remain")
    conn.execute("DELETE FROM users WHERE id = ?", (row["id"],))
    conn.commit()


def _update_user_password(conn, username, password):
    normalized_username = str(username or "").strip().lower()
    if not normalized_username:
        raise ValueError("username is required")
    if not str(password or "").strip():
        raise ValueError("password is required")
    row = conn.execute("SELECT id FROM users WHERE username = ?", (normalized_username,)).fetchone()
    if row is None:
        raise ValueError("user not found")
    timestamp = _utc_now_iso()
    conn.execute(
        "UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL",
        (timestamp, row["id"]),
    )
    conn.execute(
        "UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?",
        (_hash_password(password), timestamp, row["id"]),
    )
    conn.commit()


def _set_active_model(conn, model_name):
    normalized = str(model_name or "").strip()
    if normalized not in AVAILABLE_MODELS:
        raise ValueError("unsupported model")
    _ensure_setting(conn, "default_model", normalized)


def _is_openai_model(model_name):
    normalized = str(model_name or "").strip().lower()
    return normalized.startswith("gpt-") or normalized.startswith("o")


def _resolve_provider_model(provider, selected_model):
    normalized_provider = str(provider or "").strip().lower()
    normalized_model = str(selected_model or "").strip()
    if normalized_provider == "openai":
        return normalized_model if _is_openai_model(normalized_model) else DEFAULT_OPENAI_MODEL
    return DEFAULT_PERPLEXITY_MODEL if _is_openai_model(normalized_model) else (normalized_model or DEFAULT_PERPLEXITY_MODEL)


def _normalize_reverify_provider(provider):
    normalized = str(provider or "").strip().lower()
    return "openai" if normalized == "openai" else "perplexity"


def _get_reverify_default_provider(conn):
    return _normalize_reverify_provider(_get_setting(conn, "reverify_default_provider", REVERIFY_PROVIDER_OPTIONS[0]))


def _set_reverify_default_provider(conn, provider):
    selected = _normalize_reverify_provider(provider)
    _ensure_setting(conn, "reverify_default_provider", selected)
    return selected


def _set_session_ttl(conn, minutes):
    value = max(5, int(minutes))
    _ensure_setting(conn, "session_ttl_minutes", str(value))


def _build_script_env(extra_env=None):
    env = os.environ.copy()
    try:
        conn = _auth_db_connection()
        try:
            active_model = _get_setting(conn, "default_model", AVAILABLE_MODELS[0])
            reverify_provider = _get_reverify_default_provider(conn)
        finally:
            conn.close()
        env["OPENAI_MODEL"] = _resolve_provider_model("openai", active_model)
        env["PERPLEXITY_MODEL"] = _resolve_provider_model("perplexity", active_model)
        env["REVERIFY_DEFAULT_PROVIDER"] = reverify_provider
    except Exception:
        env.setdefault("OPENAI_MODEL", DEFAULT_OPENAI_MODEL)
        env.setdefault("PERPLEXITY_MODEL", DEFAULT_PERPLEXITY_MODEL)
        env.setdefault("REVERIFY_DEFAULT_PROVIDER", REVERIFY_PROVIDER_OPTIONS[0])

    if extra_env:
        for key, value in extra_env.items():
            if value is not None:
                env[str(key)] = str(value)

    return env


def manage_access_controls():
    """Manage users, sessions, and model settings from SQLite."""
    while True:
        print_section("Access Control Manager", "🔐")
        with _auth_db_connection() as conn:
            active_model = _get_setting(conn, "default_model", AVAILABLE_MODELS[0])
            ttl = _get_setting(conn, "session_ttl_minutes", str(DEFAULT_SESSION_MINUTES))
            reverify_provider = _get_reverify_default_provider(conn)
            users = _list_users(conn)
            sessions = _list_sessions(conn)

            print(f"  Active model: {C.BOLD}{active_model}{C.RESET}")
            print(f"  Session TTL : {C.BOLD}{ttl} minutes{C.RESET}")
            print(f"  Reverify    : {C.BOLD}{reverify_provider}{C.RESET}")
            print(f"  Users       : {C.BOLD}{len(users)}{C.RESET}")
            print(f"  Sessions    : {C.BOLD}{len(sessions)}{C.RESET}")
            print()
            for idx, user in enumerate(users, 1):
                status = "active" if user["active"] else "disabled"
                print(f"    {idx}. {user['username']} ({user['role']}, {status})")

        print()
        print(f"    {C.CYAN}[1]{C.RESET}  ➕  Add user")
        print(f"    {C.CYAN}[2]{C.RESET}  🗑️  Delete user")
        print(f"    {C.CYAN}[3]{C.RESET}  🔑  Change password")
        print(f"    {C.CYAN}[4]{C.RESET}  🎛️  Switch active model")
        print(f"    {C.CYAN}[5]{C.RESET}  ⏱️  Set session TTL")
        print(f"    {C.CYAN}[6]{C.RESET}  ♻️  Set reverify provider")
        print(f"    {C.CYAN}[7]{C.RESET}  📜  View sessions")
        print(f"    {C.CYAN}[0]{C.RESET}  ↩️  Back")
        choice = input(f"  {C.BOLD}➤ Select option: {C.RESET}").strip()

        if choice == "1":
            username = input("  Username: ").strip()
            password = input("  Password: ").strip()
            role = input("  Role [user/admin] [user]: ").strip().lower() or "user"
            try:
                with _auth_db_connection() as conn:
                    _create_user(conn, username, password, role if role in {"user", "admin"} else "user")
                print_success(f"Created user '{username.lower()}'")
            except Exception as error:
                print_error(str(error))
            input(f"\n  {C.DIM}Press Enter to continue...{C.RESET}")
        elif choice == "2":
            username = input("  Username to delete: ").strip()
            try:
                with _auth_db_connection() as conn:
                    _delete_user(conn, username)
                print_success(f"Deleted user '{username.lower()}'")
            except Exception as error:
                print_error(str(error))
            input(f"\n  {C.DIM}Press Enter to continue...{C.RESET}")
        elif choice == "3":
            username = input("  Username to change password for: ").strip()
            new_password = input("  New password: ").strip()
            confirm_password = input("  Confirm new password: ").strip()
            if new_password != confirm_password:
                print_error("Passwords do not match")
            elif not new_password:
                print_error("Password cannot be empty")
            else:
                try:
                    with _auth_db_connection() as conn:
                        _update_user_password(conn, username, new_password)
                    print_success(f"Password updated for '{username.lower()}'. All active sessions for this user have been revoked.")
                except Exception as error:
                    print_error(str(error))
            input(f"\n  {C.DIM}Press Enter to continue...{C.RESET}")
        elif choice == "4":
            print("\n  Available models:")
            for idx, model in enumerate(AVAILABLE_MODELS, 1):
                print(f"    {idx}. {model}")
            model_choice = input("  Enter model number or name: ").strip()
            selected_model = model_choice
            if model_choice.isdigit() and 1 <= int(model_choice) <= len(AVAILABLE_MODELS):
                selected_model = AVAILABLE_MODELS[int(model_choice) - 1]
            try:
                with _auth_db_connection() as conn:
                    _set_active_model(conn, selected_model)
                print_success(f"Active model set to {selected_model}")
            except Exception as error:
                print_error(str(error))
            input(f"\n  {C.DIM}Press Enter to continue...{C.RESET}")
        elif choice == "5":
            ttl_value = input(f"  Session TTL minutes [{DEFAULT_SESSION_MINUTES}]: ").strip() or str(DEFAULT_SESSION_MINUTES)
            try:
                with _auth_db_connection() as conn:
                    _set_session_ttl(conn, int(ttl_value))
                print_success(f"Session TTL set to {int(ttl_value)} minutes")
            except Exception as error:
                print_error(str(error))
            input(f"\n  {C.DIM}Press Enter to continue...{C.RESET}")
        elif choice == "6":
            print("\n  Reverify provider options:")
            for idx, provider in enumerate(REVERIFY_PROVIDER_OPTIONS, 1):
                print(f"    {idx}. {provider}")
            provider_choice = input("  Enter provider number or name: ").strip().lower()
            selected_provider = provider_choice
            if provider_choice.isdigit() and 1 <= int(provider_choice) <= len(REVERIFY_PROVIDER_OPTIONS):
                selected_provider = REVERIFY_PROVIDER_OPTIONS[int(provider_choice) - 1]
            try:
                with _auth_db_connection() as conn:
                    _set_reverify_default_provider(conn, selected_provider)
                print_success(f"Reverify provider set to {selected_provider}")
            except Exception as error:
                print_error(str(error))
            input(f"\n  {C.DIM}Press Enter to continue...{C.RESET}")
        elif choice == "7":
            with _auth_db_connection() as conn:
                sessions = _list_sessions(conn)
            print()
            for session in sessions:
                print(f"  {session['username']:<16} {session['role']:<5} expires {session['expiresAt']} revoked={bool(session['revokedAt'])}")
            input(f"\n  {C.DIM}Press Enter to continue...{C.RESET}")
        elif choice in {"0", "b", "back"}:
            return
        else:
            print_error("Invalid option")
            time.sleep(1)


def access_control_command(args):
    """Run access-control operations non-interactively."""
    with _auth_db_connection() as conn:
        if args.access_list_users:
            users = _list_users(conn)
            for user in users:
                status = "active" if user["active"] else "disabled"
                print(f"{user['username']}\t{user['role']}\t{status}")
            return 0

        if args.access_show_sessions:
            sessions = _list_sessions(conn)
            for session in sessions:
                revoked = bool(session["revokedAt"])
                print(f"{session['username']}\t{session['role']}\t{session['expiresAt']}\t{revoked}")
            return 0

        if args.access_add_user:
            username = args.access_add_user
            password = args.access_password
            if not password:
                print_error("--access-password is required when adding a user")
                return 1
            role = args.access_role if args.access_role in {"user", "admin"} else "user"
            try:
                _create_user(conn, username, password, role)
            except Exception as error:
                print_error(str(error))
                return 1
            print_success(f"Created user '{username.lower()}'")
            return 0

        if args.access_delete_user:
            try:
                _delete_user(conn, args.access_delete_user)
            except Exception as error:
                print_error(str(error))
                return 1
            print_success(f"Deleted user '{args.access_delete_user.lower()}'")
            return 0

        if args.access_set_password:
            if not args.access_password:
                print_error("--access-password is required when updating a password")
                return 1
            try:
                _update_user_password(conn, args.access_set_password, args.access_password)
            except Exception as error:
                print_error(str(error))
                return 1
            print_success(f"Updated password for '{args.access_set_password.lower()}'")
            return 0

        if args.access_set_model:
            try:
                _set_active_model(conn, args.access_set_model)
            except Exception as error:
                print_error(str(error))
                return 1
            print_success(f"Active model set to {args.access_set_model}")
            return 0

        if args.access_set_ttl is not None:
            try:
                _set_session_ttl(conn, int(args.access_set_ttl))
            except Exception as error:
                print_error(str(error))
                return 1
            print_success(f"Session TTL set to {int(args.access_set_ttl)} minutes")
            return 0

        if args.access_set_reverify_provider:
            try:
                _set_reverify_default_provider(conn, args.access_set_reverify_provider)
            except Exception as error:
                print_error(str(error))
                return 1
            print_success(f"Reverify provider set to {_normalize_reverify_provider(args.access_set_reverify_provider)}")
            return 0

    return None


# ── Pipeline Functions ───────────────────────────────────────────────────────

PIPELINE_STAGES = [
    ("GetTask",          "Fetch open tasks from CRM",               "📥"),
    ("GetOrderInquiry",  "Enrich tasks with order details",         "📋"),
    ("Funeral_Finder",   "AI-powered funeral/obituary lookup",      "🔍"),
    ("reverify",         "Re-verify NotFound and Review records",   "♻️"),
    ("Updater",          "Prepare and upload results to CRM",       "📤"),
    ("ClosingTask",      "Close processed CRM tasks",               "✅"),
]

UPDATER_MODES = ["complete", "found_only", "not_found", "review"]


def _ask_yes_no(prompt, default=False):
    suffix = "[Y/n]" if default else "[y/N]"
    while True:
        choice = input(f"  {prompt} {suffix}: ").strip().lower()
        if not choice:
            return default
        if choice in {"y", "yes"}:
            return True
        if choice in {"n", "no"}:
            return False
        print_warn("Please answer y or n.")


def _ask_updater_mode(default="complete"):
    print()
    print(f"  {C.BOLD}Updater mode:{C.RESET}")
    for idx, mode in enumerate(UPDATER_MODES, 1):
        marker = " (default)" if mode == default else ""
        print(f"    {C.CYAN}[{idx}]{C.RESET} {mode}{marker}")

    while True:
        choice = input(f"  Select updater mode [1-{len(UPDATER_MODES)}] [{default}]: ").strip().lower()
        if not choice:
            return default
        if choice in {"1", "2", "3", "4"}:
            return UPDATER_MODES[int(choice) - 1]
        if choice in UPDATER_MODES:
            return choice
        print_warn("Please choose a valid updater mode.")


def run_script(name, args=None):
    """Run a Python script from the Scripts directory."""
    script_path = SCRIPTS_DIR / f"{name}.py"
    if not script_path.exists():
        print_error(f"Script not found: {script_path}")
        return False

    python_bin = find_python()
    cmd = [python_bin, str(script_path)]
    if args:
        cmd.extend(args)

    print(f"\n  {C.BOLD}>>> Running {name}...{C.RESET}")
    env = _build_script_env()
    if name == "reverify":
        try:
            conn = _auth_db_connection()
            try:
                env["REVERIFY_DEFAULT_PROVIDER"] = _get_reverify_default_provider(conn)
            finally:
                conn.close()
        except Exception:
            pass
    result = subprocess.run(cmd, cwd=str(ROOT), env=env)
    return result.returncode == 0


def run_pipeline(force=False, dry_run=False, limit=0, stage=None, updater_mode=None, reverify_source="both", prompt_preflight=True):
    """Run the full data processing pipeline."""
    print_section("Pipeline Execution", "🚀")

    included_stage_names = [name for name, _description, _icon in PIPELINE_STAGES if not stage or stage.lower() in name.lower()]
    reprocess_get_order = force
    rerun_funeral_finder = force
    skip_reverify = False

    if prompt_preflight:
        print_info("Pipeline pre-flight checks")
        if "GetOrderInquiry" in included_stage_names:
            reprocess_get_order = _ask_yes_no("Re-run GetOrderInquiry for already-fetched orders?", default=False)
        if "Funeral_Finder" in included_stage_names:
            rerun_funeral_finder = _ask_yes_no("Re-run Funeral_Finder for already-processed orders?", default=False)
        if "reverify" in included_stage_names:
            skip_reverify = _ask_yes_no("Skip reverify this run?", default=False)

    if "Updater" in included_stage_names and updater_mode is None:
        updater_mode = _ask_updater_mode()

    common_args = []
    if force:
        common_args.append("--force")
        print_info("Force mode: re-processing all records")
    if limit > 0:
        common_args.extend(["--limit", str(limit)])
        print_info(f"Limit: processing max {limit} records per stage")

    crm_args = list(common_args)
    if dry_run:
        crm_args.append("--dry-run")
        print_warn("Dry-run mode: NO actual CRM updates will be made")

    stage_args = {}
    for name, _description, _icon in PIPELINE_STAGES:
        if stage and stage.lower() not in name.lower():
            continue
        stage_args[name] = list(common_args)

    if "GetOrderInquiry" in stage_args and not reprocess_get_order:
        stage_args["GetOrderInquiry"] = [arg for arg in stage_args["GetOrderInquiry"] if arg != "--force"]
    if "Funeral_Finder" in stage_args and not rerun_funeral_finder:
        stage_args["Funeral_Finder"] = [arg for arg in stage_args["Funeral_Finder"] if arg != "--force"]
    if "reverify" in stage_args:
        if skip_reverify:
            print_info("Skipping reverify stage for this run")
            stage_args.pop("reverify", None)
        else:
            stage_args["reverify"] = list(common_args) + ["--source", reverify_source]
    if "Updater" in stage_args:
        stage_args["Updater"] = list(crm_args)
        if updater_mode:
            stage_args["Updater"].extend(["--mode", updater_mode])

    print()
    total = len(PIPELINE_STAGES)
    for idx, (name, description, icon) in enumerate(PIPELINE_STAGES, 1):
        if stage and stage.lower() not in name.lower():
            continue
        if name not in stage_args:
            continue

        print(f"  {C.BLUE}[{idx}/{total}]{C.RESET} {icon}  {C.BOLD}{name}{C.RESET} — {description}")
        current_args = stage_args.get(name, crm_args if name in ["Updater", "ClosingTask"] else common_args)
        success = run_script(name, current_args)
        if not success:
            print_error(f"Stage '{name}' failed. Pipeline stopped.")
            return False
        print_success(f"{name} completed")

    print(f"\n  {C.GREEN}{C.BOLD}🎉 Pipeline execution completed successfully!{C.RESET}\n")
    return True


# ── Server Launch Functions ──────────────────────────────────────────────────


def _launch_process(cmd, cwd, env, log_path=None, shell=False, background=False):
    """Launch a process in foreground or detached background mode."""
    if not background:
        return subprocess.Popen(
            cmd,
            cwd=cwd,
            stdout=sys.stdout,
            stderr=sys.stderr,
            shell=shell,
            env=env,
        )

    LOGS_DIR.mkdir(parents=True, exist_ok=True)
    stdout_handle = None
    stderr_handle = None
    try:
        if log_path is not None:
            stdout_handle = open(log_path, "a", encoding="utf-8")
            stderr_handle = subprocess.STDOUT

        popen_kwargs = {
            "cwd": cwd,
            "env": env,
            "shell": shell,
            "stdout": stdout_handle,
            "stderr": stderr_handle,
        }
        if os.name == "nt":
            popen_kwargs["creationflags"] = (
                subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.DETACHED_PROCESS
            )
        else:
            popen_kwargs["start_new_session"] = True

        proc = subprocess.Popen(cmd, **popen_kwargs)
        return proc
    finally:
        if stdout_handle is not None:
            stdout_handle.close()


def _stop_process(proc):
    """Best-effort stop for child processes across platforms."""
    if proc is None or proc.poll() is not None:
        return

    try:
        proc.terminate()
        proc.wait(timeout=5)
        return
    except Exception:
        pass

    if os.name == "nt":
        subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"], check=False)
    else:
        try:
            proc.kill()
        except Exception:
            pass


def launch_frontend(port=DEFAULT_FRONTEND_PORT, background=False):
    """Launch the Vite frontend dev server."""
    npm_bin = shutil.which("npm") or "npm"
    use_shell = sys.platform == "win32"
    env = os.environ.copy()

    print_info(f"Starting frontend dev server on port {port}...")
    frontend = _launch_process(
        [npm_bin, "run", "dev", "--", "--port", str(port)],
        cwd=str(ROOT),
        env=env,
        shell=use_shell,
        background=background,
        log_path=LOGS_DIR / "frontend.log",
    )
    return frontend


def launch_backend(port=DEFAULT_BACKEND_PORT, background=False):
    """Launch the Node.js backend server."""
    node_bin = shutil.which("node") or "node"
    env = os.environ.copy()
    env["BACKEND_PORT"] = str(port)

    print_info(f"Starting backend server on port {port}...")
    backend = _launch_process(
        [node_bin, "backend/server.js"],
        cwd=str(ROOT),
        env=env,
        background=background,
        log_path=LOGS_DIR / "backend.log",
    )
    return backend


def launch_ui(frontend_port=DEFAULT_FRONTEND_PORT, backend_port=DEFAULT_BACKEND_PORT, background=False):
    """Launch both backend and frontend servers."""
    is_docker = os.path.exists("/.dockerenv")

    if background:
        occupied_ports = []
        if is_port_in_use(backend_port):
            occupied_ports.append(f"backend:{backend_port}")
        if is_port_in_use(frontend_port):
            occupied_ports.append(f"frontend:{frontend_port}")
        if occupied_ports:
            print_error(
                "Cannot start in background because ports are already in use: "
                + ", ".join(occupied_ports)
            )
            return False

    backend = launch_backend(backend_port, background=background)
    try:
        frontend = launch_frontend(frontend_port, background=background)
    except Exception as exc:
        _stop_process(backend)
        print_error(f"Failed to start frontend: {exc}")
        return False

    if background:
        _clear_background_servers()
        deadline = time.time() + 10
        while time.time() < deadline:
            if backend.poll() is not None:
                _stop_process(frontend)
                print_error("Backend process exited during startup")
                return False
            if frontend.poll() is not None:
                _stop_process(backend)
                print_error("Frontend process exited during startup")
                return False
            if is_port_in_use(backend_port) and is_port_in_use(frontend_port):
                _record_background_servers(
                    frontend_port=frontend_port,
                    backend_port=backend_port,
                    frontend_pid=frontend.pid,
                    backend_pid=backend.pid,
                )
                print_success(
                    f"Servers started in background (backend PID: {backend.pid}, frontend PID: {frontend.pid})"
                )
                print_info(f"Dashboard UI: http://localhost:{frontend_port}")
                print_info(f"Backend logs: {LOGS_DIR / 'backend.log'}")
                print_info(f"Frontend logs: {LOGS_DIR / 'frontend.log'}")
                return True
            time.sleep(0.5)

        _stop_process(backend)
        _stop_process(frontend)
        print_error("Background startup timed out before servers became ready")
        return False

    if not is_docker:
        time.sleep(5)
        url = f"http://localhost:{frontend_port}"
        print_success(f"Dashboard UI: {url}")
        try:
            webbrowser.open(url)
        except Exception:
            print_warn("Could not open browser automatically.")
    else:
        print_info(f"Running in Docker. Access UI at http://localhost:{frontend_port}")

    try:
        while True:
            if backend.poll() is not None:
                print_warn("Backend process exited")
                break
            if frontend.poll() is not None:
                print_warn("Frontend process exited")
                break
            time.sleep(1)
    except KeyboardInterrupt:
        print_info("Stopping servers...")
    finally:
        _stop_process(backend)
        _stop_process(frontend)

    return True


# ── Docker Functions ─────────────────────────────────────────────────────────

def run_with_docker():
    """Build and run the project using Docker Compose."""
    print_section("Docker Deployment", "🐳")

    docker_ver = get_docker_version()
    if not docker_ver:
        print_error("Docker is not installed or not in PATH.")
        print_info("Install Docker from: https://docs.docker.com/get-docker/")
        return

    print_info(f"Docker: {docker_ver}")

    if not DOCKER_COMPOSE.exists():
        print_error("docker-compose.yml not found!")
        return

    print_info("Building and starting containers...")
    print()

    use_shell = sys.platform == "win32"
    result = subprocess.run(
        ["docker", "compose", "up", "--build"],
        cwd=str(ROOT),
        shell=use_shell,
    )

    if result.returncode != 0:
        # Try legacy docker-compose command
        print_warn("Trying legacy docker-compose command...")
        subprocess.run(
            ["docker-compose", "up", "--build"],
            cwd=str(ROOT),
            shell=use_shell,
        )


# ── Dependency Installer ────────────────────────────────────────────────────

def list_and_install_dependencies():
    """List all project dependencies and offer to install them."""
    print_section("Dependency Manager", "📦")

    # ── Python Dependencies ──
    print(f"  {C.BOLD}{C.YELLOW}Python Dependencies (requirements.txt):{C.RESET}")
    python_deps = []
    if REQUIREMENTS_TXT.exists():
        with open(REQUIREMENTS_TXT, "r", encoding="utf-8") as f:
            for line in f:
                dep = line.strip()
                if dep and not dep.startswith("#"):
                    python_deps.append(dep)
    else:
        print_warn("requirements.txt not found!")

    for dep in python_deps:
        # Check if installed
        try:
            result = subprocess.run(
                [find_python(), "-c", f"import importlib; importlib.import_module('{dep.split('==')[0].split('>=')[0].replace('-', '_')}')"],
                capture_output=True, timeout=5
            )
            status = f"{C.GREEN}✓ installed{C.RESET}" if result.returncode == 0 else f"{C.RED}✗ missing{C.RESET}"
        except Exception:
            status = f"{C.YELLOW}? unknown{C.RESET}"
        print(f"    {C.DIM}•{C.RESET} {dep:<25} {status}")

    print()

    # ── Node.js Dependencies ──
    print(f"  {C.BOLD}{C.YELLOW}Node.js Dependencies (package.json):{C.RESET}")
    node_ver = get_node_version()
    npm_ver = get_npm_version()
    print(f"    Node.js  : {node_ver}")
    print(f"    npm      : {npm_ver}")

    node_modules_exists = (ROOT / "node_modules").exists()
    if node_modules_exists:
        print(f"    Status   : {C.GREEN}✓ node_modules found{C.RESET}")
    else:
        print(f"    Status   : {C.RED}✗ node_modules missing{C.RESET}")

    # Count dependencies from package.json
    if PACKAGE_JSON.exists():
        import json
        with open(PACKAGE_JSON, "r", encoding="utf-8") as f:
            pkg = json.load(f)
        dep_count = len(pkg.get("dependencies", {}))
        dev_count = len(pkg.get("devDependencies", {}))
        print(f"    Packages : {dep_count} dependencies, {dev_count} devDependencies")

    print()

    # ── Environment Files ──
    print(f"  {C.BOLD}{C.YELLOW}Environment Configuration:{C.RESET}")
    for label, env_path in [("Root .env", ENV_FILE)]:
        exists = env_path.exists()
        status = f"{C.GREEN}✓ found{C.RESET}" if exists else f"{C.RED}✗ missing{C.RESET}"
        print(f"    {label:<20} {status}")

    print()

    # ── Install Prompt ──
    print(f"  {C.BOLD}Install Options:{C.RESET}")
    print(f"    {C.CYAN}[1]{C.RESET} Install Python dependencies (pip install -r requirements.txt)")
    print(f"    {C.CYAN}[2]{C.RESET} Install Node.js dependencies (npm install)")
    print(f"    {C.CYAN}[3]{C.RESET} Install ALL dependencies (Python + Node.js)")
    print(f"    {C.CYAN}[0]{C.RESET} Back to main menu")
    print()

    choice = input(f"  {C.BOLD}Select option: {C.RESET}").strip()

    if choice in ["1", "3"]:
        print_info("Installing Python dependencies...")
        python_bin = find_python()
        result = subprocess.run(
            [python_bin, "-m", "pip", "install", "-r", str(REQUIREMENTS_TXT)],
            cwd=str(ROOT),
        )
        if result.returncode == 0:
            print_success("Python dependencies installed!")
        else:
            print_error("Failed to install Python dependencies")

    if choice in ["2", "3"]:
        print_info("Installing Node.js dependencies...")
        use_shell = sys.platform == "win32"
        result = subprocess.run(
            ["npm", "install"],
            cwd=str(ROOT),
            shell=use_shell,
        )
        if result.returncode == 0:
            print_success("Node.js dependencies installed!")
        else:
            print_error("Failed to install Node.js dependencies")


# ── Port Management ──────────────────────────────────────────────────────────

def manage_ports():
    """Custom port configuration for frontend and backend."""
    print_section("Port Configuration", "🔌")

    # Show current status
    fe_status = f"{C.RED}IN USE{C.RESET}" if is_port_in_use(DEFAULT_FRONTEND_PORT) else f"{C.GREEN}Available{C.RESET}"
    be_status = f"{C.RED}IN USE{C.RESET}" if is_port_in_use(DEFAULT_BACKEND_PORT) else f"{C.GREEN}Available{C.RESET}"

    print(f"  Current Port Status:")
    print(f"    Frontend (Vite)   : {DEFAULT_FRONTEND_PORT}  [{fe_status}]")
    print(f"    Backend  (Express): {DEFAULT_BACKEND_PORT}  [{be_status}]")
    print()

    print(f"  {C.BOLD}Options:{C.RESET}")
    print(f"    {C.CYAN}[1]{C.RESET} Start with default ports ({DEFAULT_FRONTEND_PORT} / {DEFAULT_BACKEND_PORT})")
    print(f"    {C.CYAN}[2]{C.RESET} Set custom ports")
    print(f"    {C.CYAN}[3]{C.RESET} Start backend only (port {DEFAULT_BACKEND_PORT})")
    print(f"    {C.CYAN}[4]{C.RESET} Start frontend only (port {DEFAULT_FRONTEND_PORT})")
    print(f"    {C.CYAN}[0]{C.RESET} Back to main menu")
    print()

    choice = input(f"  {C.BOLD}Select option: {C.RESET}").strip()

    if choice == "1":
        launch_ui()
    elif choice == "2":
        try:
            fe_port = int(input(f"  Frontend port [{DEFAULT_FRONTEND_PORT}]: ").strip() or DEFAULT_FRONTEND_PORT)
            be_port = int(input(f"  Backend port  [{DEFAULT_BACKEND_PORT}]: ").strip() or DEFAULT_BACKEND_PORT)
            launch_ui(frontend_port=fe_port, backend_port=be_port)
        except ValueError:
            print_error("Invalid port number")
    elif choice == "3":
        backend = launch_backend()
        print_success(f"Backend running at http://localhost:{DEFAULT_BACKEND_PORT}")
        try:
            backend.wait()
        except KeyboardInterrupt:
            backend.terminate()
    elif choice == "4":
        frontend = launch_frontend()
        print_success(f"Frontend running at http://localhost:{DEFAULT_FRONTEND_PORT}")
        try:
            frontend.wait()
        except KeyboardInterrupt:
            frontend.terminate()


# ── System Health Check ──────────────────────────────────────────────────────

def system_health_check():
    """Comprehensive health check of the project setup."""
    print_section("System Health Check", "🩺")

    checks = []

    # Python version
    py_ver = platform.python_version()
    py_ok = tuple(int(x) for x in py_ver.split(".")[:2]) >= (3, 10)
    checks.append(("Python 3.10+", py_ok, f"v{py_ver}"))

    # Node.js version
    node_ver = get_node_version()
    node_ok = node_ver != "Not installed"
    checks.append(("Node.js 18+", node_ok, node_ver))

    # npm
    npm_ver = get_npm_version()
    npm_ok = npm_ver != "Not installed"
    checks.append(("npm", npm_ok, f"v{npm_ver}" if npm_ok else "Not installed"))

    # Docker (optional)
    docker_ver = get_docker_version()
    docker_ok = docker_ver is not None
    checks.append(("Docker (optional)", docker_ok or True, docker_ver or "Not installed (optional)"))

    # Scripts directory
    scripts_ok = SCRIPTS_DIR.exists()
    script_count = len(list(SCRIPTS_DIR.glob("*.py"))) if scripts_ok else 0
    checks.append(("Scripts directory", scripts_ok, f"{script_count} Python scripts"))

    # Environment files
    root_env_ok = ENV_FILE.exists()
    checks.append(("Root .env", root_env_ok, str(ENV_FILE)))

    # node_modules
    nm_ok = (ROOT / "node_modules").exists()
    checks.append(("node_modules", nm_ok, "Installed" if nm_ok else "Run 'npm install'"))

    # Backend server file
    server_ok = (BACKEND_DIR / "server.js").exists()
    checks.append(("backend/server.js", server_ok, str(BACKEND_DIR / "server.js")))

    # Output directories
    outputs_ok = (SCRIPTS_DIR / "outputs").exists()
    checks.append(("Scripts/outputs/", outputs_ok, "Created" if outputs_ok else "Will be auto-created"))

    # Docker files
    dock_ok = DOCKERFILE.exists() and DOCKER_COMPOSE.exists()
    checks.append(("Docker config", dock_ok, "Dockerfile + docker-compose.yml"))

    # Print results
    passed = 0
    total = len(checks)
    for label, ok, detail in checks:
        icon = f"{C.GREEN}✓{C.RESET}" if ok else f"{C.RED}✗{C.RESET}"
        print(f"    {icon}  {label:<25} {C.DIM}{detail}{C.RESET}")
        if ok:
            passed += 1

    print()
    if passed == total:
        print_success(f"All {total} checks passed! System is ready.")
    else:
        print_warn(f"{passed}/{total} checks passed. Fix issues above before running.")

    # Port check
    print()
    print(f"  {C.BOLD}Port Availability:{C.RESET}")
    for port_name, port_num in [("Frontend", DEFAULT_FRONTEND_PORT), ("Backend", DEFAULT_BACKEND_PORT)]:
        in_use = is_port_in_use(port_num)
        icon = f"{C.RED}● IN USE{C.RESET}" if in_use else f"{C.GREEN}● Free{C.RESET}"
        print(f"    {port_name:<12} :{port_num}  {icon}")


# ── Pipeline Configuration ───────────────────────────────────────────────────

def configure_pipeline():
    """Configure and run the pipeline with custom options."""
    print_section("Pipeline Configuration", "⚙️")

    print(f"  {C.BOLD}Pipeline Stages:{C.RESET}")
    for idx, (name, desc, icon) in enumerate(PIPELINE_STAGES, 1):
        print(f"    {icon}  {C.CYAN}[{idx}]{C.RESET} {name:<20} — {desc}")

    print()
    print(f"  {C.BOLD}Run Options:{C.RESET}")
    print(f"    {C.CYAN}[A]{C.RESET} Run ALL stages (full pipeline)")
    print(f"    {C.CYAN}[1-6]{C.RESET} Run a specific stage only")
    print(f"    {C.CYAN}[D]{C.RESET} Dry-run (simulate without CRM updates)")
    print(f"    {C.CYAN}[F]{C.RESET} Force re-process all records")
    print(f"    {C.CYAN}[0]{C.RESET} Back to main menu")
    print()

    choice = input(f"  {C.BOLD}Select option: {C.RESET}").strip().upper()

    if choice == "0":
        return
    elif choice == "A":
        limit_str = input(f"  Max records (0=unlimited) [{C.DIM}0{C.RESET}]: ").strip() or "0"
        run_pipeline(limit=int(limit_str))
    elif choice == "D":
        limit_str = input(f"  Max records (0=unlimited) [{C.DIM}5{C.RESET}]: ").strip() or "5"
        run_pipeline(dry_run=True, limit=int(limit_str))
    elif choice == "F":
        run_pipeline(force=True)
    elif choice in ["1", "2", "3", "4", "5", "6"]:
        stage_name = PIPELINE_STAGES[int(choice) - 1][0]
        print_info(f"Running single stage: {stage_name}")
        run_pipeline(stage=stage_name)
    else:
        print_error("Invalid option")


# ── View Output Files ────────────────────────────────────────────────────────

def view_outputs():
    """Browse and display output files."""
    print_section("Output File Browser", "📁")

    outputs_dir = SCRIPTS_DIR / "outputs"
    if not outputs_dir.exists():
        print_warn("No outputs directory found. Run the pipeline first.")
        return

    for stage_dir in sorted(outputs_dir.iterdir()):
        if stage_dir.is_dir():
            files = list(stage_dir.iterdir())
            file_count = len(files)
            total_size = sum(f.stat().st_size for f in files if f.is_file())
            size_label = f"{total_size / 1024:.1f} KB" if total_size < 1024 * 1024 else f"{total_size / (1024 * 1024):.1f} MB"

            print(f"  📂 {C.BOLD}{stage_dir.name}/{C.RESET}")
            for f in sorted(files):
                if f.is_file():
                    fsize = f.stat().st_size
                    fsize_label = f"{fsize / 1024:.1f} KB" if fsize < 1024 * 1024 else f"{fsize / (1024 * 1024):.1f} MB"
                    print(f"     {C.DIM}├──{C.RESET} {f.name:<40} {C.DIM}{fsize_label}{C.RESET}")
            print(f"     {C.DIM}└── {file_count} files, {size_label} total{C.RESET}")
            print()


# ── Interactive Menu ─────────────────────────────────────────────────────────

def interactive_menu():
    """Main interactive menu loop."""
    while True:
        clear_screen()
        print_banner()

        print(f"  {C.BOLD}{C.WHITE}MAIN MENU{C.RESET}")
        print(f"  {C.DIM}{'─' * 50}{C.RESET}")
        print()
        print(f"    {C.CYAN}[1]{C.RESET}  🖥️   Launch Dashboard UI         {C.DIM}(Frontend + Backend){C.RESET}")
        print(f"    {C.CYAN}[2]{C.RESET}  🚀  Run Full Pipeline            {C.DIM}(All 6 Stages){C.RESET}")
        print(f"    {C.CYAN}[3]{C.RESET}  ⚙️   Configure & Run Pipeline     {C.DIM}(Custom Options){C.RESET}")
        print(f"    {C.CYAN}[4]{C.RESET}  🔌  Port Configuration           {C.DIM}(Custom Ports / Single Server){C.RESET}")
        print(f"    {C.CYAN}[5]{C.RESET}  🐳  Run with Docker              {C.DIM}(docker-compose up){C.RESET}")
        print(f"    {C.CYAN}[6]{C.RESET}  📦  Install Dependencies          {C.DIM}(Python + Node.js){C.RESET}")
        print(f"    {C.CYAN}[7]{C.RESET}  🩺  System Health Check           {C.DIM}(Verify Setup){C.RESET}")
        print(f"    {C.CYAN}[8]{C.RESET}  📁  View Output Files             {C.DIM}(Browse Results){C.RESET}")
        print(f"    {C.CYAN}[9]{C.RESET}  🧭  Terminal Pipeline Runner      {C.DIM}(Interactive/Resume/Cron){C.RESET}")
        print(f"    {C.CYAN}[10]{C.RESET} 🚀  One-Click Server Setup      {C.DIM}(Install + Build + Run backend){C.RESET}")
        print(f"    {C.CYAN}[11]{C.RESET} ☠️  Program Killer               {C.DIM}(Kill ports + programs){C.RESET}")
        print(f"    {C.CYAN}[12]{C.RESET} 🔐  Access Control Manager       {C.DIM}(Users / Sessions / Model){C.RESET}")
        print(f"    {C.CYAN}[13]{C.RESET}  UPD Project Update Manager    {C.DIM}(Verify remote + pull + hash manifest){C.RESET}")
        print()
        print(f"    {C.RED}[0]{C.RESET}  🚪  Exit")
        print()

        choice = input(f"  {C.BOLD}➤ Select option: {C.RESET}").strip()

        if choice == "1":
            launch_ui()
        elif choice == "2":
            load_dotenv(ROOT / ".env")
            run_pipeline()
            input(f"\n  {C.DIM}Press Enter to continue...{C.RESET}")
        elif choice == "3":
            load_dotenv(ROOT / ".env")
            configure_pipeline()
            input(f"\n  {C.DIM}Press Enter to continue...{C.RESET}")
        elif choice == "4":
            manage_ports()
        elif choice == "5":
            run_with_docker()
        elif choice == "6":
            list_and_install_dependencies()
            input(f"\n  {C.DIM}Press Enter to continue...{C.RESET}")
        elif choice == "7":
            system_health_check()
            input(f"\n  {C.DIM}Press Enter to continue...{C.RESET}")
        elif choice == "8":
            view_outputs()
            input(f"\n  {C.DIM}Press Enter to continue...{C.RESET}")
        elif choice == "9":
            from terminal_runner import run_terminal_pipeline

            code = run_terminal_pipeline()
            if code == 0:
                print_success("Terminal pipeline runner finished successfully")
            elif code == 130:
                print_warn("Terminal pipeline runner interrupted")
            else:
                print_error("Terminal pipeline runner ended with failure")
            input(f"\n  {C.DIM}Press Enter to continue...{C.RESET}")
        elif choice == "10":
            _one_click_server_setup_menu()
            input(f"\n  {C.DIM}Press Enter to continue...{C.RESET}")
        elif choice == "11":
            _program_killer_menu()
            input(f"\n  {C.DIM}Press Enter to continue...{C.RESET}")
        elif choice == "12":
            manage_access_controls()
        elif choice == "13":
            _project_update_manager()
            input(f"\n  {C.DIM}Press Enter to continue...{C.RESET}")
        elif choice in ["0", "q", "quit", "exit"]:
            print(f"\n  {C.CYAN}👋 Goodbye!{C.RESET}\n")
            sys.exit(0)
        else:
            print_error("Invalid option. Please try again.")
            time.sleep(1)


# ── CLI Entry Point ──────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description=f"{APP_NAME} v{VERSION} — {TAGLINE}",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=f"""
Examples:
  python main.py                   Interactive menu (default)
  python main.py --ui              Launch dashboard UI directly
    python main.py --ui --background Launch dashboard UI in background
  python main.py --docker          Run with Docker Compose
  python main.py --install         Install all dependencies
  python main.py --health          System health check
  python main.py --pipeline        Run full pipeline
  python main.py --stage search    Run a specific pipeline stage
  python main.py --dry-run         Pipeline dry-run mode
        """
    )

    # Action flags
    parser.add_argument("--ui", action="store_true",
                        help="Launch backend + frontend dashboard UI")
    parser.add_argument("--background", action="store_true",
                        help="Run UI servers in background (use with --ui)")
    parser.add_argument("--docker", action="store_true",
                        help="Build and run with Docker Compose")
    parser.add_argument("--install", action="store_true",
                        help="Install all Python and Node.js dependencies")
    parser.add_argument("--health", action="store_true",
                        help="Run system health check")
    parser.add_argument("--project-update", action="store_true",
                        help="Verify remote state, pull fast-forward updates, and generate a hash manifest")
    parser.add_argument("--project-update-allow-dirty", action="store_true",
                        help="Allow project update checks even when the worktree is dirty (pull is still safety-limited)")
    parser.add_argument("--project-update-remote", type=str, default=PROJECT_REMOTE_URL,
                        help="Remote repository URL to verify and sync from")
    parser.add_argument("--pipeline", action="store_true",
                        help="Run the full data processing pipeline")
    parser.add_argument("--terminal-runner", action="store_true",
                        help="Run interactive terminal pipeline runner")

    # Access control options
    parser.add_argument("--access-list-users", action="store_true",
                        help="List users from the SQLite access-control store")
    parser.add_argument("--access-show-sessions", action="store_true",
                        help="List sessions from the SQLite access-control store")
    parser.add_argument("--access-add-user", type=str,
                        help="Create a new user in the SQLite access-control store")
    parser.add_argument("--access-delete-user", type=str,
                        help="Delete a user from the SQLite access-control store")
    parser.add_argument("--access-set-password", type=str,
                        help="Update a user's password in the SQLite access-control store")
    parser.add_argument("--access-set-model", type=str,
                        help="Set the active model in the SQLite access-control store")
    parser.add_argument("--access-set-ttl", type=int,
                        help="Set the session TTL in minutes")
    parser.add_argument("--access-set-reverify-provider", type=str, choices=REVERIFY_PROVIDER_OPTIONS,
                        help="Set the default reverify provider in the SQLite access-control store")
    parser.add_argument("--access-password", type=str,
                        help="Password for --access-add-user")
    parser.add_argument("--access-role", type=str, choices=["user", "admin"], default="user",
                        help="Role for --access-add-user")

    # Pipeline options
    parser.add_argument("--force", action="store_true",
                        help="Force re-processing of all stages")
    parser.add_argument("--dry-run", action="store_true",
                        help="Run with dry-run enabled for CRM stages")
    parser.add_argument("--limit", type=int, default=0,
                        help="Limit number of orders to process per stage")
    parser.add_argument("--stage", type=str,
                        help="Run only a specific stage (tasks, orders, search, update, close)")

    # Port options
    parser.add_argument("--frontend-port", type=int, default=DEFAULT_FRONTEND_PORT,
                        help=f"Frontend port (default: {DEFAULT_FRONTEND_PORT})")
    parser.add_argument("--backend-port", type=int, default=DEFAULT_BACKEND_PORT,
                        help=f"Backend port (default: {DEFAULT_BACKEND_PORT})")

    args = parser.parse_args()

    # Load environment
    load_dotenv(ROOT / ".env")

    # No arguments → interactive menu
    if len(sys.argv) == 1:
        try:
            interactive_menu()
        except (KeyboardInterrupt, EOFError):
            print(f"\n  {C.CYAN}👋 Goodbye!{C.RESET}\n")
            sys.exit(0)
        return

    if args.background and not args.ui:
        parser.error("--background can only be used with --ui")

    # Direct action flags
    if args.ui:
        started = launch_ui(
            frontend_port=args.frontend_port,
            backend_port=args.backend_port,
            background=args.background,
        )
        if started is False:
            sys.exit(1)
        return

    if args.docker:
        run_with_docker()
        return

    if args.install:
        list_and_install_dependencies()
        return

    if args.health:
        system_health_check()
        return

    if args.project_update:
        success = _project_update_manager(
            remote_url=args.project_update_remote,
            allow_dirty=args.project_update_allow_dirty,
            auto_confirm=True,
        )
        sys.exit(0 if success else 1)

    if args.pipeline or args.stage or args.force or args.dry_run:
        success = run_pipeline(
            force=args.force,
            dry_run=args.dry_run,
            limit=args.limit,
            stage=args.stage,
        )
        sys.exit(0 if success else 1)

    if args.terminal_runner:
        from terminal_runner import run_terminal_pipeline

        sys.exit(run_terminal_pipeline())

    access_result = access_control_command(args)
    if access_result is not None:
        sys.exit(access_result)

    # Fallback to interactive menu
    try:
        interactive_menu()
    except (KeyboardInterrupt, EOFError):
        print(f"\n  {C.CYAN}👋 Goodbye!{C.RESET}\n")
        sys.exit(0)


if __name__ == "__main__":
    main()
