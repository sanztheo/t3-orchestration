"""End-to-end checks of memory.py through its command line, as the memory thread calls it."""

from __future__ import annotations

import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).with_name('memory.py')


class MemoryCommandTest(unittest.TestCase):
    def setUp(self) -> None:
        self.directory = tempfile.TemporaryDirectory()
        self.library = Path(self.directory.name) / 'library'

    def tearDown(self) -> None:
        self.directory.cleanup()

    def run_command(self, *arguments: str, payload: dict | None = None) -> subprocess.CompletedProcess:
        return subprocess.run(
            [sys.executable, '-I', str(SCRIPT), '--library', str(self.library), *arguments],
            input=json.dumps(payload) if payload is not None else '',
            capture_output=True, text=True, check=False,
        )

    def succeed(self, *arguments: str, payload: dict | None = None):
        result = self.run_command(*arguments, payload=payload)
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def note(self, **changes) -> dict:
        return {'topic': 'billing', 'kind': 'decision', 'title': 'Use monthly invoices',
                'source': 't3-thread://v1/thread-1', 'body': 'Decided on 2026-10-27.', **changes}

    def test_record_is_idempotent_and_publish_writes_the_views(self) -> None:
        first = self.succeed('record', payload=self.note())
        self.assertEqual(self.succeed('record', payload=self.note()), first)
        self.assertEqual([row['id'] for row in self.succeed('pending')], [first['id']])

        self.assertEqual(self.succeed('publish', first['id'])['status'], 'published')
        self.assertIn('Use monthly invoices', (self.library / 'NOTES.md').read_text())
        self.assertTrue((self.library / 'notes' / f"{first['id']}.md").exists())
        self.assertEqual(len(self.succeed('search', 'invoices')), 1)

    def test_a_correction_supersedes_only_a_published_note(self) -> None:
        original = self.succeed('record', payload=self.note())
        correction = self.succeed('record', payload=self.note(
            kind='correction', body='Quarterly instead.', supersedes=original['id']))
        self.assertNotEqual(self.run_command('publish', correction['id']).returncode, 0)

        self.succeed('publish', original['id'])
        self.succeed('publish', correction['id'])
        self.assertEqual(self.succeed('show', original['id'])['status'], 'superseded')

    def test_invalid_notes_are_refused(self) -> None:
        for change in [{'topic': 'Not A Slug'}, {'kind': 'rumour'}, {'kind': ['decision']},
                       {'source': 'somewhere'}, {'title': 'Two\nStatus: published'}]:
            self.assertNotEqual(self.run_command('record', payload=self.note(**change)).returncode, 0)

    def test_state_writes_require_the_current_revision(self) -> None:
        self.assertEqual(self.succeed('state-get', 'monitor')['revision'], 0)
        self.succeed('state-put', payload={'key': 'monitor', 'value': {'cursor': 3}, 'expected_revision': 0})
        stale = self.run_command('state-put', payload={'key': 'monitor', 'value': {}, 'expected_revision': 0})
        self.assertNotEqual(stale.returncode, 0)
        self.assertEqual(self.succeed('state-get', 'monitor'), {'key': 'monitor', 'revision': 1, 'value': {'cursor': 3}})


if __name__ == '__main__':
    unittest.main()
