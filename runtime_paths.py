"""Resolve app runtimes before falling back to the developer's PATH."""
from pathlib import Path
import shutil
import sys

ROOT = Path(__file__).resolve().parent


def node_executable():
    bundled = ROOT / 'runtime' / 'node' / 'node.exe'
    if bundled.is_file():
        return str(bundled)
    found = shutil.which('node')
    if found:
        return found
    raise RuntimeError('缺少 Node.js。请使用包含运行环境的完整安装包。')


def python_executable(windowless=False):
    name = 'pythonw.exe' if windowless else 'python.exe'
    bundled = ROOT / 'runtime' / 'python' / name
    if bundled.is_file():
        return str(bundled)
    sibling = Path(sys.executable).with_name(name)
    return str(sibling if sibling.is_file() else Path(sys.executable))
