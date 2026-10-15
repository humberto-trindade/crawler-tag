from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parent


def fail(message: str) -> None:
    print(f"\nERRO: {message}")
    print("Consulte portable-local\\logs e corrija o requisito indicado.")
    raise SystemExit(1)


def run(command: list[str], env: dict[str, str]) -> None:
    print("> " + " ".join(command), flush=True)
    result = subprocess.run(command, cwd=ROOT, env=env)
    if result.returncode:
        fail(f"comando terminou com codigo {result.returncode}")


def main() -> None:
    if sys.version_info < (3, 10):
        fail("Python 3.10 ou superior e necessario.")
    if not shutil.which("pip") and not shutil.which("pip3"):
        fail("pip nao foi encontrado. Instale Python com a opcao 'Add pip'.")
    env = dict(os.environ)

    try:
        import playwright  # noqa: F401
    except ImportError:
        run([sys.executable, "-m", "pip", "install", "-r", str(ROOT / "requirements.txt")], env)

    browsers_path = ROOT / "browsers"
    browsers_path.mkdir(exist_ok=True)
    env["PLAYWRIGHT_BROWSERS_PATH"] = str(browsers_path)
    marker = browsers_path / ".chromium-ready"
    if not marker.exists():
        run([sys.executable, "-m", "playwright", "install", "chromium"], env)
        marker.write_text("chromium\n", encoding="ascii")

    run([sys.executable, str(ROOT / "app.py")], env)


if __name__ == "__main__":
    main()
