import json
import os
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from backend import server


class PiProjectTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.base = Path(self.temp.name)
        self.session_root = self.base / "sessions"
        self.env = patch.dict(os.environ, {"PI_CODING_AGENT_SESSION_DIR": str(self.session_root)})
        self.env.start()

    def tearDown(self):
        self.env.stop()
        self.temp.cleanup()

    def test_lists_empty_project_and_jsonl_count(self):
        project_dir = self.base / "workspace" / "counted"
        project_dir.mkdir(parents=True)
        session_dir = server.pi_session_dir_for_cwd(project_dir)
        session_dir.mkdir(parents=True)

        projects = server.list_pi_session_projects()
        project = projects[server.pi_project_id_for_dir(session_dir)]
        self.assertEqual(project["name"], "counted")
        self.assertEqual(project["path"], str(project_dir.resolve()))
        self.assertEqual(project["sessionCount"], 0)
        self.assertTrue(project["available"])
        self.assertTrue(project["projectPathExists"])
        self.assertTrue(project["projectPathIsDir"])

        for index in range(2):
            session_file = session_dir / f"session_{index}.jsonl"
            session_file.write_text(
                json.dumps({"type": "session", "cwd": str(project_dir.resolve())}) + "\n",
                encoding="utf-8",
            )

        projects = server.list_pi_session_projects()
        project = projects[server.pi_project_id_for_dir(session_dir)]
        self.assertEqual(project["sessionCount"], 2)

    def test_lists_missing_project_as_unavailable(self):
        missing_dir = self.base / "workspace" / "missing"
        session_dir = server.pi_session_dir_for_cwd(missing_dir)
        session_dir.mkdir(parents=True)
        for index in range(2):
            (session_dir / f"session_{index}.jsonl").write_text(
                json.dumps({"type": "session", "cwd": str(missing_dir.resolve())}) + "\n",
                encoding="utf-8",
            )

        projects = server.list_pi_session_projects()
        project = projects[server.pi_project_id_for_dir(session_dir)]

        self.assertEqual(project["sessionCount"], 2)
        self.assertFalse(project["available"])
        self.assertFalse(project["projectPathExists"])
        self.assertFalse(project["projectPathIsDir"])
        self.assertEqual(project["unavailableReason"], "项目文件夹不存在")

    def test_create_existing_project_folder_creates_dialog_project_only(self):
        project_dir = self.base / "workspace" / "existing"
        project_dir.mkdir(parents=True)

        result = server.create_pi_project(project_dir)

        self.assertEqual(result["status"], "dialog_created")
        self.assertEqual(result["message"], "对话项目已创建")
        self.assertTrue(Path(result["project"]["sessionDir"]).is_dir())
        self.assertTrue(project_dir.is_dir())
        self.assertEqual(result["project"]["sessionCount"], 0)

    def test_create_missing_project_folder_creates_both_folders(self):
        project_dir = self.base / "workspace" / "new-project"

        result = server.create_pi_project(project_dir)

        self.assertEqual(result["status"], "project_and_dialog_created")
        self.assertEqual(result["message"], "项目文件夹和对话项目已创建")
        self.assertTrue(project_dir.is_dir())
        self.assertTrue(Path(result["project"]["sessionDir"]).is_dir())
        self.assertEqual(result["project"]["name"], "new-project")
        self.assertEqual(result["project"]["path"], str(project_dir.resolve()))

    def test_create_existing_dialog_project_conflicts(self):
        project_dir = self.base / "workspace" / "duplicate"
        server.create_pi_project(project_dir)

        with self.assertRaises(FileExistsError):
            server.create_pi_project(project_dir)

    def test_delete_removes_session_folder_but_keeps_project_folder(self):
        project_dir = self.base / "workspace" / "delete-me"
        result = server.create_pi_project(project_dir)
        session_dir = Path(result["project"]["sessionDir"])

        server.delete_pi_project_dir(session_dir=str(session_dir))

        self.assertFalse(session_dir.exists())
        self.assertTrue(project_dir.is_dir())

    def test_delete_missing_project_session_folder(self):
        missing_dir = self.base / "workspace" / "missing-delete"
        session_dir = server.pi_session_dir_for_cwd(missing_dir)
        session_dir.mkdir(parents=True)

        server.delete_pi_project_dir(session_dir=str(session_dir))

        self.assertFalse(session_dir.exists())
        self.assertFalse(missing_dir.exists())

    def test_active_project_skips_unavailable_projects(self):
        missing_dir = self.base / "workspace" / "missing-active"
        missing_session_dir = server.pi_session_dir_for_cwd(missing_dir)
        missing_session_dir.mkdir(parents=True)
        (missing_session_dir / "session.jsonl").write_text(
            json.dumps({"type": "session", "cwd": str(missing_dir.resolve())}) + "\n",
            encoding="utf-8",
        )
        available_dir = self.base / "workspace" / "available-active"
        available_result = server.create_pi_project(available_dir)

        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        server.create_schema(conn)
        server.set_meta(conn, "active_project_id", server.pi_project_id_for_dir(missing_session_dir))

        active_id = server.resolve_active_project_id(conn)

        self.assertEqual(active_id, available_result["project"]["id"])

    def test_active_project_is_none_when_all_projects_unavailable(self):
        missing_dir = self.base / "workspace" / "missing-only"
        missing_session_dir = server.pi_session_dir_for_cwd(missing_dir)
        missing_session_dir.mkdir(parents=True)
        (missing_session_dir / "session.jsonl").write_text(
            json.dumps({"type": "session", "cwd": str(missing_dir.resolve())}) + "\n",
            encoding="utf-8",
        )

        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        server.create_schema(conn)
        server.set_meta(conn, "active_project_id", server.pi_project_id_for_dir(missing_session_dir))

        self.assertIsNone(server.resolve_active_project_id(conn))

    def test_missing_project_cwd_does_not_fall_back_to_root(self):
        missing_dir = self.base / "workspace" / "missing-cwd"

        with self.assertRaisesRegex(ValueError, "项目文件夹不存在"):
            server.resolve_project_cwd({"path": str(missing_dir)})

    def test_delete_rejects_root_nested_and_outside_paths(self):
        self.session_root.mkdir(parents=True)
        nested = self.session_root / "project" / "nested"
        nested.mkdir(parents=True)
        outside = self.base / "outside"
        outside.mkdir()

        for candidate in (self.session_root, nested, outside):
            with self.subTest(candidate=candidate):
                with self.assertRaises(FileNotFoundError):
                    server.delete_pi_project_dir(session_dir=str(candidate))


if __name__ == "__main__":
    unittest.main()
