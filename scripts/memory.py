#!/usr/bin/env python3
"""Transactional long-term notes and collection state for one T3 orchestration library.

Usage: memory.py --library PATH COMMAND [ARG]. Payloads are one JSON object on stdin.
"""

import argparse
import contextlib
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import sys
import tempfile
from typing import Any


KINDS = {'decision', 'observation', 'pitfall', 'procedure', 'artifact', 'correction'}
SCHEMA = """
CREATE TABLE IF NOT EXISTS notes (
    id TEXT PRIMARY KEY, topic TEXT NOT NULL, title TEXT NOT NULL,
    kind TEXT NOT NULL, source TEXT NOT NULL, body TEXT NOT NULL,
    created_at TEXT NOT NULL, published_at TEXT, supersedes TEXT,
    status TEXT NOT NULL DEFAULT 'pending'
);
CREATE TABLE IF NOT EXISTS state (
    key TEXT PRIMARY KEY, value TEXT NOT NULL, revision INTEGER NOT NULL,
    updated_at TEXT NOT NULL
);
"""


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def read_payload() -> dict[str, Any]:
    raw = sys.stdin.read(65537)
    if len(raw) > 65536:
        raise ValueError('Payload exceeds 64 KiB')
    payload = json.loads(raw)
    if not isinstance(payload, dict):
        raise ValueError('Expected one JSON object on stdin')
    return payload


def required_text(payload: dict[str, Any], key: str, maximum: int) -> str:
    value = payload.get(key)
    if not isinstance(value, str) or not value.strip() or len(value) > maximum:
        raise ValueError(f'Invalid {key}')
    return value.strip()


def write_atomic(path: Path, content: str) -> None:
    descriptor, temporary = tempfile.mkstemp(prefix='.memory-', dir=path.parent)
    try:
        with os.fdopen(descriptor, 'w', encoding='utf-8') as output:
            output.write(content)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def record_note(connection: sqlite3.Connection, payload: dict[str, Any]) -> dict[str, Any]:
    note = {
        'topic': required_text(payload, 'topic', 80),
        'title': required_text(payload, 'title', 200),
        'source': required_text(payload, 'source', 2000),
        'body': required_text(payload, 'body', 20000),
        'kind': payload.get('kind', 'observation'),
        'supersedes': payload.get('supersedes'),
    }
    if not re.fullmatch(r'[a-z0-9][a-z0-9-]*', note['topic']):
        raise ValueError('topic must be a lowercase slug')
    if '\n' in note['title']:
        raise ValueError('title must be a single line')
    if not isinstance(note['kind'], str) or note['kind'] not in KINDS:
        raise ValueError('Unknown note kind')
    if not note['source'].startswith(('t3-thread://v1/', 'https://', 'file://')):
        raise ValueError('A traceable source URI is required')
    if note['supersedes'] is not None:
        if not isinstance(note['supersedes'], str):
            raise ValueError('supersedes must be a note id')
        previous = connection.execute('SELECT id FROM notes WHERE id = ?', (note['supersedes'],)).fetchone()
        if previous is None:
            raise ValueError('The replaced note does not exist')
    canonical = json.dumps(note, ensure_ascii=False, sort_keys=True)
    note_id = hashlib.sha256(canonical.encode()).hexdigest()
    connection.execute(
        'INSERT OR IGNORE INTO notes '
        '(id, topic, title, kind, source, body, created_at, supersedes) '
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        (note_id, note['topic'], note['title'], note['kind'], note['source'], note['body'], now(), note['supersedes']),
    )
    status = connection.execute('SELECT status FROM notes WHERE id = ?', (note_id,)).fetchone()['status']
    return {'id': note_id, 'status': status}


def publish_note(connection: sqlite3.Connection, note_id: str) -> dict[str, Any]:
    note = connection.execute('SELECT * FROM notes WHERE id = ?', (note_id,)).fetchone()
    if note is None:
        raise ValueError('Unknown note id')
    if note['status'] != 'pending':
        return {'id': note_id, 'status': note['status']}
    if note['supersedes']:
        previous = connection.execute('SELECT status FROM notes WHERE id = ?', (note['supersedes'],)).fetchone()
        if previous is None or previous['status'] != 'published':
            raise ValueError('Only a currently published note can be replaced')
        connection.execute("UPDATE notes SET status = 'superseded' WHERE id = ?", (note['supersedes'],))
    connection.execute("UPDATE notes SET status = 'published', published_at = ? WHERE id = ?", (now(), note_id))
    return {'id': note_id, 'status': 'published'}


def save_state(connection: sqlite3.Connection, payload: dict[str, Any]) -> dict[str, Any]:
    key = required_text(payload, 'key', 1000)
    if 'value' not in payload:
        raise ValueError('value is required')
    previous = connection.execute('SELECT revision FROM state WHERE key = ?', (key,)).fetchone()
    revision = previous['revision'] if previous else 0
    if payload.get('expected_revision') != revision:
        raise ValueError(f'Stale state: read the current revision for {key} before writing')
    connection.execute(
        'INSERT INTO state (key, value, revision, updated_at) VALUES (?, ?, ?, ?) '
        'ON CONFLICT(key) DO UPDATE SET value = excluded.value, '
        'revision = excluded.revision, updated_at = excluded.updated_at',
        (key, json.dumps(payload['value'], ensure_ascii=False), revision + 1, now()),
    )
    return {'key': key, 'revision': revision + 1}


def export_notes(connection: sqlite3.Connection, root: Path) -> None:
    notes = connection.execute("SELECT * FROM notes WHERE status != 'pending' ORDER BY published_at DESC, id").fetchall()
    active = []
    for note in notes:
        lines = [f"# {note['title']}", '', f"Status: {note['status']}", f"Kind: {note['kind']}",
                 f"Topic: {note['topic']}", f"Source: {note['source']}",
                 f"Recorded: {note['created_at']}", f"Published: {note['published_at']}"]
        if note['supersedes']:
            lines.append(f"Supersedes: {note['supersedes']}")
        lines.extend(['', note['body'], ''])
        write_atomic(root / 'notes' / f"{note['id']}.md", '\n'.join(lines))
        if note['status'] == 'published':
            active.append(note)
    index = ['# Published notes', '', 'The 40 most recent active notes. The search command covers every active note.', '']
    for note in active[:40]:
        title = note['title'].replace('\n', ' ').replace('[', '\\[').replace(']', '\\]')
        index.append(f"- [{title}](notes/{note['id']}.md) — {note['topic']}, {note['kind']}, {note['created_at'][:10]}")
    write_atomic(root / 'NOTES.md', '\n'.join(index) + '\n')


def dispatch(connection: sqlite3.Connection, args: argparse.Namespace, root: Path) -> Any:
    if args.command == 'record':
        return record_note(connection, read_payload())
    if args.command == 'publish':
        return publish_note(connection, args.id)
    if args.command == 'state-put':
        return save_state(connection, read_payload())
    if args.command == 'state-get':
        row = connection.execute('SELECT * FROM state WHERE key = ?', (args.key,)).fetchone()
        return {'key': args.key, 'revision': row['revision'] if row else 0,
                'value': json.loads(row['value']) if row else None}
    if args.command == 'state-list':
        rows = connection.execute('SELECT * FROM state ORDER BY key').fetchall()
        return [{'key': row['key'], 'revision': row['revision'], 'value': json.loads(row['value'])} for row in rows]
    if args.command == 'pending':
        rows = connection.execute("SELECT id, topic, title, kind, source, created_at FROM notes WHERE status = 'pending' ORDER BY created_at").fetchall()
        return [dict(row) for row in rows]
    if args.command == 'show':
        row = connection.execute('SELECT * FROM notes WHERE id = ?', (args.id,)).fetchone()
        if row is None:
            raise ValueError('Unknown note id')
        return dict(row)
    if args.command == 'search':
        rows = connection.execute(
            "SELECT id, topic, title, source FROM notes WHERE status = 'published' "
            "AND instr(lower(title || ' ' || topic || ' ' || body), lower(?)) > 0 LIMIT 30",
            (args.query,),
        ).fetchall()
        return [dict(row) for row in rows]
    if args.command == 'backup':
        backup = root / 'backups' / f"memory-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')}.sqlite3"
        with contextlib.closing(sqlite3.connect(backup)) as destination:
            connection.backup(destination)
        return {'backup': str(backup)}
    return {'database': str(root / 'state' / 'memory.sqlite3'), 'notes': connection.execute('SELECT count(*) FROM notes').fetchone()[0]}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--library', required=True, type=Path, help='Library directory of one project')
    commands = parser.add_subparsers(dest='command', required=True)
    for command in ['record', 'pending', 'state-put', 'state-list', 'refresh', 'backup', 'status']:
        commands.add_parser(command)
    for command in ['show', 'publish']:
        commands.add_parser(command).add_argument('id')
    commands.add_parser('state-get').add_argument('key')
    commands.add_parser('search').add_argument('query')
    args = parser.parse_args()
    root = args.library.expanduser().resolve()
    os.umask(0o077)
    for directory in [root, root / 'state', root / 'notes', root / 'backups']:
        directory.mkdir(parents=True, exist_ok=True)
    # Serializing publication also keeps regenerated Markdown consistent with SQLite.
    with (root / 'state' / 'memory.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        with contextlib.closing(sqlite3.connect(root / 'state' / 'memory.sqlite3', timeout=15)) as connection:
            connection.row_factory = sqlite3.Row
            connection.executescript(SCHEMA)
            with connection:
                result = dispatch(connection, args, root)
            # The database commits first; refresh repairs views after an interrupted export.
            if args.command in {'publish', 'refresh'}:
                export_notes(connection, root)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, sqlite3.Error) as error:
        print(f'Memory operation failed: {error}', file=sys.stderr)
        sys.exit(1)
