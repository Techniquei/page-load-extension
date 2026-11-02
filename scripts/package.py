#!/usr/bin/env python3
"""Собирает zip расширения: только файлы, которые загружает Chrome."""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "dist"
FOLDER = "page-load-extension"

# Единственный список файлов релиза. .gitattributes должен совпадать с ним.
FILES = (
    "background.js",
    "content.js",
    "devtools.html",
    "devtools.js",
    "manifest.json",
    "measurement.js",
    "panel-view.js",
    "panel.css",
    "panel.html",
    "panel.js",
    "presets.js",
    "series.js",
    "sources.js",
)

VERSION_RE = re.compile(r"^[0-9]+(?:\.[0-9]+){1,3}$")
REF_RE = re.compile(r"""['"]([A-Za-z0-9_./-]+\.(?:js|html|css|png|svg|json))['"]""")
FORBIDDEN = ("tests/", "README", ".github/", "scripts/", ".git", ".gitignore", ".gitattributes")


def fail(message: str) -> None:
    print(message, file=sys.stderr)
    raise SystemExit(1)


def read_manifest() -> dict:
    return json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))


def extension_version(data: dict) -> str:
    version = data.get("version")
    if not isinstance(version, str) or VERSION_RE.fullmatch(version) is None:
        fail(f"В manifest.json нужна числовая версия из 2–4 частей, сейчас: {version!r}")
    return version


def attributes_text() -> str:
    lines = [
        "# Скачиваемый архив GitHub содержит только файлы расширения.",
        "* export-ignore",
        *(f"{name} -export-ignore" for name in FILES),
        "",
    ]
    return "\n".join(lines)


def check_attributes() -> None:
    path = ROOT / ".gitattributes"
    expected = attributes_text()
    actual = path.read_text(encoding="utf-8") if path.exists() else ""
    if actual != expected:
        fail(
            "Файл .gitattributes не совпадает со списком файлов в scripts/package.py.\n"
            f"Ожидается:\n{expected}"
        )


def referenced_files(data: dict) -> set[str]:
    needed: set[str] = set()

    def collect(value: object) -> None:
        if isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9_./-]+\.(?:js|html|css|png|svg|json)", value):
            needed.add(value)
        elif isinstance(value, dict):
            for item in value.values():
                collect(item)
        elif isinstance(value, list):
            for item in value:
                collect(item)

    collect(data)
    for name in FILES:
        path = ROOT / name
        if path.suffix not in {".js", ".html", ".css"}:
            continue
        for match in REF_RE.findall(path.read_text(encoding="utf-8")):
            if (ROOT / match).is_file():
                needed.add(match)
    return needed


def check_references(data: dict) -> None:
    referenced = referenced_files(data)
    missing = sorted(referenced - set(FILES))
    if missing:
        fail("Расширение ссылается на файлы, которых нет в релизе: " + ", ".join(missing))
    unused = sorted(set(FILES) - referenced - {"manifest.json"})
    if unused:
        fail("В релизе есть файлы, на которые расширение не ссылается: " + ", ".join(unused))


def git_archive_paths() -> list[str]:
    archived = subprocess.run(
        ["git", "archive", "--format=tar", "HEAD"],
        cwd=ROOT,
        check=True,
        capture_output=True,
    )
    listed = subprocess.run(["tar", "-t"], input=archived.stdout, check=True, capture_output=True)
    paths = []
    for line in listed.stdout.decode().splitlines():
        if line and not line.endswith("/"):
            paths.append(line.removeprefix("./"))
    return sorted(paths)


def check_git_archive() -> None:
    archived = git_archive_paths()
    expected = sorted(FILES)
    if archived == expected:
        return
    extra = sorted(set(archived) - set(expected))
    absent = sorted(set(expected) - set(archived))
    parts = ["git archive HEAD собирает другой набор файлов. Таким будет Download ZIP и Source code у релиза."]
    if extra:
        parts.append("Лишние: " + ", ".join(extra))
    if absent:
        parts.append("Нет в архиве: " + ", ".join(absent))
    parts.append("Закоммитьте .gitattributes вместе со списком в scripts/package.py и запустите сборку снова.")
    fail("\n".join(parts))


def check_tag(version: str) -> None:
    ref = os.environ.get("GITHUB_REF", "")
    if not ref.startswith("refs/tags/"):
        return
    tag = os.environ.get("GITHUB_REF_NAME", "")
    if tag.removeprefix("v") != version:
        fail(f"Тег {tag} не совпадает с версией {version} в manifest.json")


def build(version: str, chrome: str) -> Path:
    shutil.rmtree(DIST, ignore_errors=True)
    DIST.mkdir()
    archive = DIST / f"page-load-extension-{version}.zip"
    with zipfile.ZipFile(archive, "w") as bundle:
        for name in FILES:
            info = zipfile.ZipInfo(f"{FOLDER}/{name}")
            info.date_time = (1980, 1, 1, 0, 0, 0)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.create_system = 3
            info.external_attr = 0o644 << 16
            bundle.writestr(info, (ROOT / name).read_bytes())
    notes = (
        f"Скачайте `page-load-extension-{version}.zip` и распакуйте его. Внутри папка `{FOLDER}`.\n\n"
        "1. Откройте `chrome://extensions`.\n"
        "2. Включите **Режим разработчика**.\n"
        "3. Нажмите **Загрузить распакованное расширение** и выберите папку "
        f"`{FOLDER}`.\n"
        "4. Откройте сайт, затем DevTools → **page load extension**.\n\n"
        f"Нужен Chrome {chrome} или новее. В архиве только файлы расширения.\n"
    )
    (DIST / "RELEASE_NOTES.md").write_text(notes, encoding="utf-8")
    (DIST / "version.txt").write_text(version + "\n", encoding="utf-8")
    return archive


def check_zip(archive: Path, version: str) -> None:
    with zipfile.ZipFile(archive) as bundle:
        names = bundle.namelist()
        expected = [f"{FOLDER}/{name}" for name in FILES]
        if names != expected:
            fail("Состав архива другой:\n" + "\n".join(names))
        for name in names:
            if any(part in name for part in FORBIDDEN):
                fail(f"В архив попал лишний файл: {name}")
        for name in FILES:
            if bundle.read(f"{FOLDER}/{name}") != (ROOT / name).read_bytes():
                fail(f"{name} в архиве отличается от файла в репозитории")
        packed = json.loads(bundle.read(f"{FOLDER}/manifest.json"))
    if packed.get("version") != version:
        fail("Версия внутри архива не совпадает с manifest.json")


def main() -> None:
    missing = [name for name in FILES if not (ROOT / name).is_file()]
    if missing:
        fail("Нет файлов расширения: " + ", ".join(missing))
    data = read_manifest()
    version = extension_version(data)
    chrome = str(data.get("minimum_chrome_version") or "118")
    check_tag(version)
    check_references(data)
    check_attributes()
    check_git_archive()
    archive = build(version, chrome)
    check_zip(archive, version)
    print(f"Архив: {archive.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
