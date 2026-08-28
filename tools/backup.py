#!/usr/bin/env python3
"""定时备份 / 随时恢复:把 SQLite(blog.db)备份到与图片存储一致的 WebDAV 目录。

备份前先做 WAL checkpoint 保证快照一致;远端只保留最新一份 db,上传新备份后自动删除旧的。
依赖站点已配置 WebDAV(站点设置里的图片存储 WebDAV,或环境变量 WEBDAV_* )。
仅用 Python 标准库(sqlite3 / urllib / xml),要求 Python 3.11+。

用法:
  python3 tools/backup.py                       # 备份到 WebDAV,只保留最新一份 db
  python3 tools/backup.py list                  # 列出 WebDAV 上的备份
  python3 tools/backup.py restore [备份名]      # 从 WebDAV 拉回 db 恢复(默认最新;先停服务)

环境变量(与 server 一致,作为 settings 未落库时的回退):
  DATA_DIR 数据目录(默认 ./data)
  WEBDAV_URL / WEBDAV_USERNAME / WEBDAV_PASSWORD / WEBDAV_FOLDER

定时备份(crontab -e,每天凌晨 3:30):
  30 3 * * * cd /path/to/couple-blog && python3 tools/backup.py >> backups/cron.log 2>&1
"""

import base64
import os
import re
import sqlite3
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime
from xml.etree import ElementTree

DATA_DIR = os.path.abspath(os.environ.get("DATA_DIR", "data"))
DB_PATH = os.path.join(DATA_DIR, "blog.db")
# 与图片命名(YYYYMMDD-HHMMSS-hash.jpg / 16位hash.jpg)不冲突,便于识别与清理
BACKUP_RE = re.compile(r"^blog-backup-\d{8}-\d{6}\.db$")


def stamp() -> str:
    return datetime.now().strftime("%Y%m%d-%H%M%S")


def auth_header(cfg: dict) -> str:
    token = base64.b64encode(f"{cfg['username']}:{cfg['password']}".encode()).decode()
    return "Basic " + token


def folder_segs(cfg: dict) -> list:
    return [s for s in (x.strip() for x in cfg["folder"].split("/")) if s]


def base_url(cfg: dict) -> str:
    return cfg["url"].rstrip("/")


def dir_url(cfg: dict) -> str:
    segs = "/".join(urllib.parse.quote(s) for s in folder_segs(cfg))
    return f"{base_url(cfg)}/{segs}/"


def item_url(cfg: dict, filename: str) -> str:
    segs = "/".join(urllib.parse.quote(s) for s in folder_segs(cfg))
    return f"{base_url(cfg)}/{segs + '/' if segs else ''}{urllib.parse.quote(filename)}"


# 读取 WebDAV 配置:优先 settings 表(与图片存储共用同一套),落库为空时回退环境变量
def load_config() -> dict:
    cfg = {
        "url": os.environ.get("WEBDAV_URL", ""),
        "username": os.environ.get("WEBDAV_USERNAME", ""),
        "password": os.environ.get("WEBDAV_PASSWORD", ""),
        "folder": os.environ.get("WEBDAV_FOLDER", "images"),
    }
    if os.path.exists(DB_PATH):
        try:
            conn = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
        except sqlite3.Error:
            return cfg
        try:
            for key in ("webdav_url", "webdav_username", "webdav_password", "webdav_folder"):
                row = conn.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
                if row:
                    cfg[key.removeprefix("webdav_")] = row[0]
        finally:
            conn.close()
    return cfg


def configured(cfg: dict) -> bool:
    return bool(cfg["url"] and cfg["username"] and cfg["password"])


def _request(method: str, url: str, cfg: dict, data: bytes = None, headers: dict = None):
    h = {"Authorization": auth_header(cfg)}
    if headers:
        h.update(headers)
    req = urllib.request.Request(url, data=data, method=method, headers=h)
    return urllib.request.urlopen(req)


# 逐段 MKCOL 建 folder 目录;已存在的段(405/409/301)忽略,真失败才抛。与 server/webdav.js 行为一致
def ensure_folder(cfg: dict) -> None:
    cur = base_url(cfg)
    for seg in folder_segs(cfg):
        cur = f"{cur}/{urllib.parse.quote(seg)}"
        try:
            _request("MKCOL", cur, cfg)
        except urllib.error.HTTPError as e:
            if e.code not in (405, 409, 301):
                raise RuntimeError(f"WebDAV 建目录失败 ({e.code})") from e


def put(cfg: dict, filename: str, data: bytes) -> None:
    try:
        _request("PUT", item_url(cfg, filename), cfg, data=data, headers={"Content-Type": "application/octet-stream"})
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"WebDAV 上传失败 ({e.code}): {e.read().decode('utf-8', 'replace')[:200]}") from e


def get(cfg: dict, filename: str) -> bytes:
    try:
        return _request("GET", item_url(cfg, filename), cfg).read()
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"WebDAV 读取失败 ({e.code}): {e.read().decode('utf-8', 'replace')[:200]}") from e


def delete(cfg: dict, filename: str) -> None:
    try:
        _request("DELETE", item_url(cfg, filename), cfg)
    except urllib.error.HTTPError as e:
        if e.code != 404:
            raise RuntimeError(f"WebDAV 删除失败 ({e.code})") from e


# PROPFIND(depth 1)列出目录内文件名,解析 multistatus 里的 href
def list_folder(cfg: dict) -> list:
    try:
        resp = _request("PROPFIND", dir_url(cfg), cfg, headers={"Depth": "1"})
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"WebDAV 列目录失败 ({e.code})") from e
    root = ElementTree.fromstring(resp.read())
    names = []
    for el in root.iter():
        if not el.tag.endswith("href"):
            continue
        parts = [p for p in (el.text or "").split("/") if p]
        if not parts:
            continue
        name = parts[-1]
        try:
            name = urllib.parse.unquote(name)
        except Exception:
            pass
        names.append(name)
    return names


def backup() -> None:
    if not os.path.exists(DB_PATH):
        print(f"找不到数据库: {DB_PATH}", file=sys.stderr)
        sys.exit(1)
    conn = sqlite3.connect(DB_PATH)
    conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")  # 先把 WAL 合并进主库,快照才完整
    conn.close()
    cfg = load_config()
    if not configured(cfg):
        print(
            "未配置 WebDAV。请先在站点设置里把图片存储切到 WebDAV 并填好地址/账号/密码,"
            "或设置环境变量 WEBDAV_URL / WEBDAV_USERNAME / WEBDAV_PASSWORD",
            file=sys.stderr,
        )
        sys.exit(1)

    ensure_folder(cfg)
    name = f"blog-backup-{stamp()}.db"
    with open(DB_PATH, "rb") as f:
        data = f.read()
    put(cfg, name, data)
    print(f"已备份到 WebDAV: {name}({len(data) / 1024 / 1024:.2f} MB)")

    # 只保留最新:清理远端更早的 db 备份(清理失败只告警,不打断主流程)
    try:
        files = [f for f in list_folder(cfg) if BACKUP_RE.match(f)]
        for stale in sorted(f for f in files if f != name):
            delete(cfg, stale)
            print(f"已清理旧备份: {stale}")
    except Exception as e:
        print(f"清理旧备份失败(下次备份会重试): {e}", file=sys.stderr)


def list_cmd() -> None:
    cfg = load_config()
    if not configured(cfg):
        print("未配置 WebDAV(可在站点设置或环境变量 WEBDAV_* 提供)", file=sys.stderr)
        sys.exit(1)
    files = sorted(f for f in list_folder(cfg) if BACKUP_RE.match(f))
    print("\n".join(files) if files else "(WebDAV 上暂无备份)")


def restore(name: str | None) -> None:
    cfg = load_config()
    if not configured(cfg):
        print("未配置 WebDAV(若原数据目录已删除,请用环境变量 WEBDAV_* 提供连接信息)", file=sys.stderr)
        sys.exit(1)

    target = name
    if not target:
        files = sorted(f for f in list_folder(cfg) if BACKUP_RE.match(f))
        if not files:
            print("WebDAV 上没有可用备份", file=sys.stderr)
            sys.exit(1)
        target = files[-1]
    print("请确认服务已停止(Docker: docker compose stop;裸机: 停掉 node server/index.js)")

    data = get(cfg, target)
    # 现有数据整体改名留底,不直接删;确认恢复无误后可手动删除
    if os.path.isdir(DATA_DIR) and os.listdir(DATA_DIR):
        safety = f"{DATA_DIR}.before-restore-{stamp()}"
        os.rename(DATA_DIR, safety)
        print(f"现有数据已另存为: {safety}")
    os.makedirs(DATA_DIR, exist_ok=True)
    with open(DB_PATH, "wb") as f:
        f.write(data)
    print(f"恢复完成 ← {target}(图片本就在 WebDAV 同一目录,无需恢复),现在可以重新启动服务")


def main() -> None:
    command = sys.argv[1] if len(sys.argv) > 1 else "backup"
    try:
        if command == "backup":
            backup()
        elif command == "list":
            list_cmd()
        elif command == "restore":
            restore(sys.argv[2] if len(sys.argv) > 2 else None)
        else:
            print(f"未知命令: {command}(可用: backup / list / restore)", file=sys.stderr)
            sys.exit(1)
    except (RuntimeError, urllib.error.URLError) as e:
        print(f"执行失败: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
