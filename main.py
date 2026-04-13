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
import subprocess
import sys
import os
import time
import webbrowser
import signal
import shutil
import platform
import socket
from pathlib import Path

# ── Paths ────────────────────────────────────────────────────────────────────
ROOT = Path(__file__).resolve().parent
SCRIPTS_DIR = ROOT / "Scripts"
BACKEND_DIR = ROOT / "backend"
REQUIREMENTS_TXT = ROOT / "requirements.txt"
PACKAGE_JSON = ROOT / "package.json"
ENV_FILE = ROOT / ".env"
SCRIPTS_ENV_FILE = SCRIPTS_DIR / ".env"
DOCKERFILE = ROOT / "Dockerfile"
DOCKER_COMPOSE = ROOT / "docker-compose.yml"

# ── Version & Branding ──────────────────────────────────────────────────────
VERSION = "2.0.0"
APP_NAME = "BlossomTask"
TAGLINE = "Funeral Order Automation Pipeline"

# ── Default Ports ────────────────────────────────────────────────────────────
DEFAULT_FRONTEND_PORT = 8080
DEFAULT_BACKEND_PORT = 8787
LOGS_DIR = ROOT / "outputs" / "logs"

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


# ── Pipeline Functions ───────────────────────────────────────────────────────

PIPELINE_STAGES = [
    ("GetTask",          "Fetch open tasks from CRM",               "📥"),
    ("GetOrderInquiry",  "Enrich tasks with order details",         "📋"),
    ("Funeral_Finder",   "AI-powered funeral/obituary lookup",      "🔍"),
    ("reverify",         "Re-verify NotFound and Review records",   "♻️"),
    ("Updater",          "Prepare and upload results to CRM",       "📤"),
    ("ClosingTask",      "Close processed CRM tasks",               "✅"),
]


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
    result = subprocess.run(cmd, cwd=str(ROOT), env=os.environ.copy())
    return result.returncode == 0


def run_pipeline(force=False, dry_run=False, limit=0, stage=None):
    """Run the full data processing pipeline."""
    print_section("Pipeline Execution", "🚀")

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

    print()
    total = len(PIPELINE_STAGES)
    for idx, (name, description, icon) in enumerate(PIPELINE_STAGES, 1):
        if stage and stage.lower() not in name.lower():
            continue

        print(f"  {C.BLUE}[{idx}/{total}]{C.RESET} {icon}  {C.BOLD}{name}{C.RESET} — {description}")
        current_args = crm_args if name in ["Updater", "ClosingTask"] else common_args
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
    for label, env_path in [("Root .env", ENV_FILE), ("Scripts/.env", SCRIPTS_ENV_FILE)]:
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

    scripts_env_ok = SCRIPTS_ENV_FILE.exists()
    checks.append(("Scripts/.env", scripts_env_ok, str(SCRIPTS_ENV_FILE)))

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
    parser.add_argument("--pipeline", action="store_true",
                        help="Run the full data processing pipeline")
    parser.add_argument("--terminal-runner", action="store_true",
                        help="Run interactive terminal pipeline runner")

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
        interactive_menu()
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

    # Fallback to interactive menu
    interactive_menu()


if __name__ == "__main__":
    main()
