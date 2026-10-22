"""Build only an explicitly sanitized, manifest-listed source tree. No live data copy."""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import subprocess
import sys
import urllib.request
import zipfile

PYTHON_URL = 'https://www.python.org/ftp/python/3.12.10/python-3.12.10-embed-amd64.zip'
DEPENDENCIES = ['Pillow==11.3.0', 'numpy==2.2.6', 'jieba==0.42.1', 'qrcode==8.2']


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def source_files(source):
    marker = source / 'PUBLIC-SOURCE-MANIFEST.json'
    if not marker.is_file() or not (source / '.clean-release-source').is_file():
        raise ValueError('Sanitized source requires .clean-release-source and PUBLIC-SOURCE-MANIFEST.json')
    entries = json.loads(marker.read_text(encoding='utf-8-sig'))['files']
    if not isinstance(entries, dict) or not entries:
        raise ValueError('Public source manifest must map each relative path to its SHA256')
    result = []
    for item in entries:
        relative = PurePosixPath(item.replace('\\', '/'))
        lower = relative.as_posix().lower()
        if relative.is_absolute() or '..' in relative.parts or ':' in lower:
            raise ValueError('Unsafe manifest path: ' + item)
        parts = set(p.lower() for p in relative.parts)
        if parts.intersection({'private', '__pycache__', '.git', 'runtime', 'node_modules','dist','work','build'}) or lower.endswith(('.log', '.dpapi', '.pyc', '.har', '.sqlite', '.sqlite3', '.db', '.exe', '.dll', '.pyd', '.zip')) or relative.name.lower().startswith('.env'):
            raise ValueError('Private/runtime path in public source manifest: ' + item)
        if 'data' in parts and lower.removeprefix('templates/') not in {'data/config.json', 'data/persona-profiles/linmuwan.json', 'data/media-catalog-linmuwan.json', 'upstream-v1.2.0/data/config.json'}:
            raise ValueError('Only reviewed configuration defaults may appear under data/: ' + item)
        path = source.joinpath(*relative.parts)
        if not path.is_file() or path.is_symlink() or any(parent.is_symlink() for parent in path.parents if parent != source.parent):
            raise ValueError('Manifest entry is missing or a symbolic link: ' + item)
        if source not in path.resolve().parents:
            raise ValueError('Manifest entry escapes source: ' + item)
        if digest(path) != entries[item]:
            raise ValueError('Sanitized source changed after review: ' + item)
        result.append((path, str(relative)))
    return result


def run(*command, **kwargs):
    subprocess.run([str(item) for item in command], check=True, **kwargs)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--node', required=True, type=Path)
    parser.add_argument('--cache', default='')
    args = parser.parse_args()
    source, output = args.source.resolve(), args.output.resolve()
    if source == output or output in source.parents:
        raise ValueError('Source and output must be separate directories.')
    # Copy only reviewed manifest entries, including when invoked from a clean source checkout.
    files = source_files(source)
    missing = {'launcher.py', 'runtime_paths.py', 'desktop-launcher.cs', 'packaging/installer.cs', 'packaging/prepare_webview.py'} - {relative for _, relative in files}
    if missing:
        raise ValueError('Manifest is missing required application files: ' + ', '.join(sorted(missing)))
    if sys.version_info[:2] != (3, 12) or sys.maxsize < 2**32:
        raise ValueError('Build with 64-bit Python 3.12 so dependencies match the bundled runtime.')
    if output.exists() and any(output.iterdir()):
        raise ValueError('Output must be empty; builds never delete an existing directory.')
    output.mkdir(parents=True, exist_ok=True)
    cache = Path(args.cache).resolve() if args.cache else output / 'download-cache'
    cache.mkdir(parents=True, exist_ok=True)
    portable = output / 'YuYiAI'
    portable.mkdir()
    for path, relative in files:
        destination = portable / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, destination)
    python_zip = cache / 'python-3.12.10-embed-amd64.zip'
    if not python_zip.exists():
        urllib.request.urlretrieve(PYTHON_URL, python_zip)
    # Python.org publishes this MD5 on the release page; SHA256 is recorded below.
    if hashlib.md5(python_zip.read_bytes()).hexdigest() != 'fe8ef205f2e9c3ba44d0cf9954e1abd3':
        raise ValueError('Official Python archive checksum mismatch')
    python_root = portable / 'runtime' / 'python'
    with zipfile.ZipFile(python_zip) as archive:
        archive.extractall(python_root)
    (python_root / 'python312._pth').write_text('python312.zip\n.\n..\\..\nLib\\site-packages\nimport site\n', encoding='ascii')
    wheels = cache / 'wheels'
    offline_wheels = all(any(wheels.glob(requirement.split('==')[0].lower() + '-*.whl')) for requirement in DEPENDENCIES)
    pip_source = ['--no-index', '--find-links', str(wheels)] if offline_wheels else []
    run(sys.executable, '-m', 'pip', 'install', '--disable-pip-version-check', '--no-deps', '--no-compile', '--cache-dir', cache / 'pip-cache', *pip_source, '--target', python_root / 'Lib' / 'site-packages', *DEPENDENCIES)
    # Pip's optional console launchers embed the build machine's Python path.
    scripts=python_root/'Lib/site-packages/bin'
    if scripts.exists():
        if not scripts.resolve().is_relative_to(portable.resolve()):raise ValueError('Dependency script path escapes build output')
        shutil.rmtree(scripts)
    node_root = portable / 'runtime' / 'node'
    node_root.mkdir()
    shutil.copy2(args.node, node_root / 'node.exe')
    node_version = subprocess.check_output([str(args.node), '--version'], text=True).strip()
    node_license_url = 'https://raw.githubusercontent.com/nodejs/node/' + node_version + '/LICENSE'
    node_license = cache / ('node-' + node_version + '-LICENSE')
    if not node_license.exists():
        urllib.request.urlretrieve(node_license_url, node_license)
    shutil.copy2(node_license, node_root / 'LICENSE')
    compiler = Path(os.environ['WINDIR']) / 'Microsoft.NET' / 'Framework64' / 'v4.0.30319' / 'csc.exe'
    webview = portable / 'runtime' / 'webview2'
    run(sys.executable, '-X', 'utf8', source / 'packaging' / 'prepare_webview.py', '--destination', webview, '--cache', cache)
    run(compiler, '/nologo', '/target:winexe', '/platform:x64', '/optimize+', '/reference:System.Windows.Forms.dll', '/reference:System.Drawing.dll', '/reference:System.Core.dll', '/reference:' + str(webview / 'Microsoft.Web.WebView2.Core.dll'), '/reference:' + str(webview / 'Microsoft.Web.WebView2.WinForms.dll'), '/out:' + str(portable / '语忆AI.exe'), source / 'desktop-launcher.cs')
    runtime_info = {'python': {'version': '3.12.10', 'url': PYTHON_URL, 'archiveSha256': digest(python_zip)}, 'node': {'version': node_version, 'sha256': digest(node_root / 'node.exe'), 'licenseUrl': node_license_url}, 'webview2': json.loads((webview / 'WEBVIEW-MANIFEST.json').read_text(encoding='utf-8')), 'dependencies': DEPENDENCIES}
    (portable / 'RUNTIME-MANIFEST.json').write_text(json.dumps(runtime_info, ensure_ascii=False, indent=2), encoding='utf-8')
    env = os.environ.copy()
    env.update(PATH=str(Path(os.environ['WINDIR']) / 'System32'), PYTHONPATH='', PYTHONHOME='')
    run(python_root / 'python.exe', '-B', '-c', "import sys,PIL,numpy,jieba,qrcode,runtime_paths;print('Standalone imports OK',sys.version.split()[0]);print(runtime_paths.node_executable())", cwd=portable, env=env)
    run(node_root / 'node.exe', '--version', env=env)
    archive_path = output / '语忆AI-portable.zip'
    with zipfile.ZipFile(archive_path, 'w', zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(portable.rglob('*')):
            if path.is_file() and '__pycache__' not in path.parts:
                archive.write(path, path.relative_to(portable).as_posix())
    run(compiler, '/nologo', '/target:winexe', '/optimize+', '/reference:System.Windows.Forms.dll', '/reference:System.IO.Compression.dll', '/reference:System.IO.Compression.FileSystem.dll', '/resource:' + str(archive_path) + ',payload.zip', '/out:' + str(output / '语忆AI-Setup.exe'), source / 'packaging' / 'installer.cs')
    assets = [archive_path, output / '语忆AI-Setup.exe']
    (output / 'SHA256SUMS.txt').write_text(''.join(digest(path) + '  ' + path.name + '\n' for path in assets), encoding='utf-8')
    print(json.dumps({'portable': str(portable), 'zip': str(archive_path), 'installer': str(assets[1])}, ensure_ascii=False))


if __name__ == '__main__':
    main()
