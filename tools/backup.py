#!/usr/bin/env python3
"""定时备份 / 随时恢复:把 SQLite(blog.db)备份到与图片存储一致的 WebDAV 目录。

备份使用 SQLite backup API 获取在线一致快照;远端只保留最新一份 db,上传新备份后自动删除旧的。
依赖站点已配置 WebDAV(站点设置里的图片存储 WebDAV,或环境变量 WEBDAV_* )。
仅用 Python 标准库(sqlite3 / urllib / xml),要求 Python 3.9+。

用法:
  /usr/bin/python3 tools/backup.py                       # 备份到 WebDAV,只保留最新一份 db
  /usr/bin/python3 tools/backup.py list                  # 列出 WebDAV 上的备份
  /usr/bin/python3 tools/backup.py restore [备份名]      # 从 WebDAV 拉回 db 恢复(默认最新;先停服务)
  /usr/bin/python3 tools/backup.py restore <本地db路径>   # 直接用本地 db 文件恢复(先停服务)

环境变量(与 server 一致,作为 settings 未落库时的回退):
  DATA_DIR 数据目录(默认项目根目录下的 data/)
  WEBDAV_URL / WEBDAV_USERNAME / WEBDAV_PASSWORD / WEBDAV_FOLDER

定时备份(crontab -e,每天凌晨 3:30):
  30 3 * * * cd /path/to/couple-blog && mkdir -p backups && /usr/bin/python3 tools/backup.py >> backups/cron.log 2>&1
"""

from __future__ import annotations

import base64
import os
import re
import socket
import sqlite3
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime
from typing import Optional
from xml.etree import ElementTree

# 默认数据目录定位到「项目根/data」,与脚本所在位置无关(不依赖启动时的 cwd),
# 否则从 tools/ 等子目录运行会把 data 误解析到 tools/data
_PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.abspath(os.environ.get("DATA_DIR", os.path.join(_PROJECT_ROOT, "data")))
DB_PATH = os.path.join(DATA_DIR, "blog.db")
# 与图片命名(YYYYMMDD-HHMMSS-hash.jpg / 16位hash.jpg)不冲突,便于识别与清理
BACKUP_RE = re.compile(r"^blog-backup-\d{8}-\d{6}\.db$")
REQUEST_TIMEOUT_SECONDS = 30


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
                # 空设置表示未落库,继续使用环境变量回退值。
                if row and row[0] not in (None, ""):
                    cfg[key.removeprefix("webdav_")] = row[0]
        except sqlite3.Error:
            # 旧库可能还没有 settings 表,此时保留环境变量配置。
            pass
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
    try:
        return urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT_SECONDS)
    except (TimeoutError, socket.timeout) as e:
        raise RuntimeError(f"WebDAV 请求超时 ({REQUEST_TIMEOUT_SECONDS}s)") from e
    except urllib.error.URLError as e:
        if isinstance(e.reason, (TimeoutError, socket.timeout)):
            raise RuntimeError(f"WebDAV 请求超时 ({REQUEST_TIMEOUT_SECONDS}s)") from e
        raise


# 逐段 MKCOL 建 folder 目录;已存在的段(405/409/301)忽略,真失败才抛。与 server/webdav.js 行为一致
def ensure_folder(cfg: dict) -> None:
    cur = base_url(cfg)
    for seg in folder_segs(cfg):
        cur = f"{cur}/{urllib.parse.quote(seg)}"
        try:
            with _request("MKCOL", cur, cfg):
                pass
        except urllib.error.HTTPError as e:
            if e.code not in (405, 409, 301):
                raise RuntimeError(f"WebDAV 建目录失败 ({e.code})") from e


def put(cfg: dict, filename: str, data: bytes) -> None:
    try:
        with _request("PUT", item_url(cfg, filename), cfg, data=data, headers={"Content-Type": "application/octet-stream"}):
            pass
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"WebDAV 上传失败 ({e.code}): {e.read().decode('utf-8', 'replace')[:200]}") from e


def get(cfg: dict, filename: str) -> bytes:
    try:
        with _request("GET", item_url(cfg, filename), cfg) as response:
            return response.read()
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"WebDAV 读取失败 ({e.code}): {e.read().decode('utf-8', 'replace')[:200]}") from e


def delete(cfg: dict, filename: str) -> None:
    try:
        with _request("DELETE", item_url(cfg, filename), cfg):
            pass
    except urllib.error.HTTPError as e:
        if e.code != 404:
            raise RuntimeError(f"WebDAV 删除失败 ({e.code})") from e


# PROPFIND(depth 1)列出目录内文件名,解析 multistatus 里的 href
def list_folder(cfg: dict) -> list:
    try:
        with _request("PROPFIND", dir_url(cfg), cfg, headers={"Depth": "1"}) as response:
            payload = response.read()
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"WebDAV 列目录失败 ({e.code})") from e
    try:
        root = ElementTree.fromstring(payload)
    except ElementTree.ParseError as e:
        raise RuntimeError("WebDAV 返回了无法解析的目录响应") from e
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


def snapshot_database() -> bytes:
    """用 SQLite backup API 从在线数据库获取一致快照,不会漏掉 WAL 中的提交。"""
    os.makedirs(DATA_DIR, exist_ok=True)
    fd, snapshot_path = tempfile.mkstemp(prefix=".blog-backup-", suffix=".db", dir=DATA_DIR)
    os.close(fd)
    source = destination = None
    try:
        source = sqlite3.connect(f"file:{urllib.parse.quote(DB_PATH)}?mode=ro", uri=True, timeout=REQUEST_TIMEOUT_SECONDS)
        destination = sqlite3.connect(snapshot_path)
        source.backup(destination)
        destination.close()
        destination = None
        source.close()
        source = None
        with open(snapshot_path, "rb") as f:
            return f.read()
    except sqlite3.Error as e:
        raise RuntimeError(f"创建数据库快照失败: {e}") from e
    finally:
        if destination is not None:
            destination.close()
        if source is not None:
            source.close()
        for path in (snapshot_path, snapshot_path + "-wal", snapshot_path + "-shm", snapshot_path + "-journal"):
            try:
                os.unlink(path)
            except FileNotFoundError:
                pass


def backup() -> None:
    if not os.path.exists(DB_PATH):
        print(f"找不到数据库: {DB_PATH}", file=sys.stderr)
        sys.exit(1)
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
    data = snapshot_database()
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


def _validate_database(path: str) -> None:
    """验证 SQLite 文件可读、完整且包含应用所需的核心表。"""
    with open(path, "rb") as f:
        if f.read(16) != b"SQLite format 3\x00":
            raise RuntimeError("恢复文件不是有效的 SQLite 数据库")
    conn = None
    try:
        conn = sqlite3.connect(f"file:{urllib.parse.quote(path)}?mode=ro", uri=True, timeout=REQUEST_TIMEOUT_SECONDS)
        result = conn.execute("PRAGMA integrity_check").fetchone()
        if not result or str(result[0]).lower() != "ok":
            detail = result[0] if result else "未知错误"
            raise RuntimeError(f"SQLite 完整性检查失败: {detail}")
        tables = {
            row[0] for row in conn.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('users', 'posts')"
            )
        }
        missing = {"users", "posts"} - tables
        if missing:
            raise RuntimeError(f"恢复文件缺少必要数据表: {', '.join(sorted(missing))}")
    except sqlite3.Error as e:
        raise RuntimeError(f"无法打开恢复数据库: {e}") from e
    finally:
        if conn is not None:
            conn.close()


def _restore_to_data(data: bytes, source_desc: str) -> None:
    """先验证恢复文件,再以目录留底 + 原子替换方式写入 DATA_DIR。"""
    print("请确认服务已停止(Docker: docker compose stop;裸机: 停掉 node server/index.js)")
    had_data_dir = os.path.isdir(DATA_DIR)
    os.makedirs(DATA_DIR, exist_ok=True)
    fd, staged_path = tempfile.mkstemp(prefix=".restore-", suffix=".db", dir=DATA_DIR)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        _validate_database(staged_path)
    except Exception:
        try:
            os.unlink(staged_path)
        except FileNotFoundError:
            pass
        if not had_data_dir and os.path.isdir(DATA_DIR) and not os.listdir(DATA_DIR):
            os.rmdir(DATA_DIR)
        raise

    safety = f"{DATA_DIR}.before-restore-{stamp()}"
    suffix = 1
    while os.path.exists(safety):
        safety = f"{DATA_DIR}.before-restore-{stamp()}-{suffix}"
        suffix += 1
    try:
        os.rename(DATA_DIR, safety)
        os.makedirs(DATA_DIR, exist_ok=True)
        os.replace(os.path.join(safety, os.path.basename(staged_path)), DB_PATH)
    except Exception:
        # 目录改名失败时临时文件仍在原目录,不要把它留成下一次恢复的残留物。
        try:
            os.unlink(staged_path)
        except FileNotFoundError:
            pass
        if os.path.isdir(DATA_DIR) and not os.listdir(DATA_DIR):
            os.rmdir(DATA_DIR)
        if os.path.isdir(safety) and not os.path.exists(DATA_DIR):
            os.rename(safety, DATA_DIR)
        raise
    print(f"现有数据已另存为: {safety}")
    print(
        f"恢复完成 ← {source_desc}。图片文件不含在 db 内:"
        "WebDAV 存储时图片在远端不受影响;本地存储时需另行备份 data/uploads。现在可以重新启动服务"
    )


def restore(name: Optional[str]) -> None:
    # 传入的是本地存在的文件,直接用它恢复,不走 WebDAV(此时无需任何 WebDAV 配置)
    if name and os.path.isfile(name):
        with open(name, "rb") as f:
            _restore_to_data(f.read(), name)
        return

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
    _restore_to_data(get(cfg, target), f"{target}(WebDAV)")


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
