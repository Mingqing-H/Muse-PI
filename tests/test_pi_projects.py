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

    def test_create_project_rejects_relative_path(self):
        with self.assertRaisesRegex(ValueError, "绝对路径"):
            server.create_pi_project("123")

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

    def test_project_image_allows_external_absolute_path(self):
        project_dir = self.base / "workspace" / "image-project"
        project_dir.mkdir(parents=True)
        external_image = self.base / "outside images" / "external image.png"
        external_image.parent.mkdir()
        external_image.write_bytes(b"image")

        resolved = server.resolve_project_image_path({"path": str(project_dir)}, str(external_image))

        self.assertEqual(resolved, external_image.resolve())

    def test_project_image_allows_windows_path_with_space_after_drive(self):
        project_dir = self.base / "workspace" / "image-project"
        project_dir.mkdir(parents=True)
        external_image = self.base / "outside images" / "external image.png"
        external_image.parent.mkdir()
        external_image.write_bytes(b"image")
        image_path = str(external_image).replace(":", ": ", 1)

        resolved = server.resolve_project_image_path({"path": str(project_dir)}, image_path)

        self.assertEqual(resolved, external_image.resolve())

    def test_project_image_falls_back_to_common_local_folders_for_filename(self):
        project_dir = self.base / "workspace" / "image-project"
        project_dir.mkdir(parents=True)
        desktop_image = self.base / "Desktop" / "external image.png"
        desktop_image.parent.mkdir()
        desktop_image.write_bytes(b"image")

        with patch.object(server.Path, "home", return_value=self.base):
            resolved = server.resolve_project_image_path({"path": str(project_dir)}, "external image.png")

        self.assertEqual(resolved, desktop_image.resolve())

    def test_project_image_prefers_project_file_over_common_local_folder(self):
        project_dir = self.base / "workspace" / "image-project"
        project_dir.mkdir(parents=True)
        project_image = project_dir / "same.png"
        project_image.write_bytes(b"project")
        desktop_image = self.base / "Desktop" / "same.png"
        desktop_image.parent.mkdir()
        desktop_image.write_bytes(b"desktop")

        with patch.object(server.Path, "home", return_value=self.base):
            resolved = server.resolve_project_image_path({"path": str(project_dir)}, "same.png")

        self.assertEqual(resolved, project_image.resolve())

    def test_project_image_rejects_relative_path_outside_project(self):
        project_dir = self.base / "workspace" / "image-project"
        project_dir.mkdir(parents=True)
        outside_image = project_dir.parent / "outside.png"
        outside_image.write_bytes(b"image")

        with self.assertRaises(ValueError):
            server.resolve_project_image_path({"path": str(project_dir)}, "../outside.png")

    def test_list_pi_skills_uses_project_settings_and_global_locations(self):
        project_dir = self.base / "workspace" / "skill-project"
        project_dir.mkdir(parents=True)
        pi_agent_dir = self.base / ".pi" / "agent"
        pi_agent_dir.mkdir(parents=True)

        project_skill = project_dir / ".pi" / "skills" / "review"
        project_skill.mkdir(parents=True)
        (project_skill / "SKILL.md").write_text(
            "---\nname: review\ndescription: Review current code\n---\n",
            encoding="utf-8",
        )
        global_skill = pi_agent_dir / "skills" / "global-tool"
        global_skill.mkdir(parents=True)
        (global_skill / "SKILL.md").write_text(
            "---\nname: global-tool\ndescription: Global skill\n---\n",
            encoding="utf-8",
        )
        configured_dir = self.base / "configured-skills"
        configured_dir.mkdir()
        (configured_dir / "note.md").write_text(
            "---\nname: note-skill\ndescription: Root markdown skill\n---\n",
            encoding="utf-8",
        )
        claude_skill = self.base / ".claude" / "skills" / "writer"
        claude_skill.mkdir(parents=True)
        (claude_skill / "SKILL.md").write_text(
            "---\nname: claude-writer\ndescription: Skill from configured Claude path\n---\n",
            encoding="utf-8",
        )
        agents_skill = self.base / ".agents" / "skills" / "planner"
        agents_skill.mkdir(parents=True)
        (agents_skill / "SKILL.md").write_text(
            "---\nname: agents-planner\ndescription: Skill from ~/.agents\n---\n",
            encoding="utf-8",
        )
        agent_skill = self.base / ".agent" / "skills" / "legacy"
        agent_skill.mkdir(parents=True)
        (agent_skill / "SKILL.md").write_text(
            "---\nname: legacy-agent\ndescription: Skill from ~/.agent\n---\n",
            encoding="utf-8",
        )
        (pi_agent_dir / "settings.json").write_text(
            json.dumps({"skills": [str(configured_dir), "~/.claude/skills"]}),
            encoding="utf-8",
        )

        with patch.dict(os.environ, {"PI_CODING_AGENT_DIR": str(pi_agent_dir)}), patch.object(server.Path, "home", return_value=self.base):
            skills = server.list_pi_skills({"path": str(project_dir)})

        names = {skill["name"] for skill in skills}
        self.assertIn("review", names)
        self.assertIn("global-tool", names)
        self.assertIn("note-skill", names)
        self.assertIn("claude-writer", names)
        self.assertIn("agents-planner", names)
        self.assertIn("legacy-agent", names)

    def test_list_pi_skills_reads_default_settings_when_agent_dir_is_overridden(self):
        project_dir = self.base / "workspace" / "skill-project"
        project_dir.mkdir(parents=True)
        custom_agent_dir = self.base / "custom-pi-agent"
        custom_agent_dir.mkdir()

        default_pi_agent_dir = self.base / ".pi" / "agent"
        default_pi_agent_dir.mkdir(parents=True)
        claude_skill = self.base / ".claude" / "skills" / "research"
        claude_skill.mkdir(parents=True)
        (claude_skill / "SKILL.md").write_text(
            "---\nname: claude-research\ndescription: Skill from default settings\n---\n",
            encoding="utf-8",
        )
        (default_pi_agent_dir / "settings.json").write_text(
            json.dumps({"skills": ["~/.claude/skills"]}),
            encoding="utf-8",
        )

        with patch.dict(os.environ, {"PI_CODING_AGENT_DIR": str(custom_agent_dir)}), patch.object(server.Path, "home", return_value=self.base):
            skills = server.list_pi_skills({"path": str(project_dir)})

        self.assertIn("claude-research", {skill["name"] for skill in skills})

    def test_list_project_files_returns_filtered_relative_files(self):
        project_dir = self.base / "workspace" / "file-project"
        project_dir.mkdir(parents=True)
        (project_dir / "frontend").mkdir()
        (project_dir / "frontend" / "app.js").write_text("console.log('ok')", encoding="utf-8")
        (project_dir / "README.md").write_text("readme", encoding="utf-8")
        (project_dir / ".git").mkdir()
        (project_dir / ".git" / "config").write_text("ignored", encoding="utf-8")

        files = server.list_project_files({"path": str(project_dir)}, query="app")

        self.assertEqual(files[0]["path"], "frontend/app.js")
        self.assertNotIn(".git/config", {file["path"] for file in files})

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


class PiAuthConfigTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.base = Path(self.temp.name)
        self.agent_dir = self.base / ".pi" / "agent"
        self.env = patch.dict(os.environ, {"PI_CODING_AGENT_DIR": str(self.agent_dir)})
        self.env.start()

    def tearDown(self):
        self.env.stop()
        self.temp.cleanup()

    def read_auth(self):
        return json.loads((self.agent_dir / "auth.json").read_text(encoding="utf-8"))

    def read_settings(self):
        return json.loads((self.agent_dir / "settings.json").read_text(encoding="utf-8"))

    def test_save_pi_auth_creates_auth_and_settings_files(self):
        status = server.save_pi_api_key_auth("deepseek", "sk-test")

        auth = self.read_auth()
        settings = self.read_settings()
        self.assertEqual(auth["deepseek"], {"type": "api_key", "key": "sk-test"})
        self.assertEqual(settings["defaultProvider"], "deepseek")
        self.assertEqual(status["defaultProvider"], "deepseek")
        self.assertIn("deepseek", {item["provider"] for item in status["authenticatedProviders"]})

    def test_save_pi_auth_preserves_other_auth_entries_and_settings_fields(self):
        self.agent_dir.mkdir(parents=True)
        (self.agent_dir / "auth.json").write_text(
            json.dumps(
                {
                    "openai-codex": {
                        "type": "oauth",
                        "access": "access-token",
                        "refresh": "refresh-token",
                    },
                    "openai": {"type": "api_key", "key": "old"},
                }
            ),
            encoding="utf-8",
        )
        (self.agent_dir / "settings.json").write_text(
            json.dumps({"shellPath": "bash", "skills": ["~/.claude/skills"]}),
            encoding="utf-8",
        )

        server.save_pi_api_key_auth("deepseek", "new-key")

        auth = self.read_auth()
        settings = self.read_settings()
        self.assertEqual(auth["openai-codex"]["refresh"], "refresh-token")
        self.assertEqual(auth["openai"]["key"], "old")
        self.assertEqual(auth["deepseek"], {"type": "api_key", "key": "new-key"})
        self.assertEqual(settings["shellPath"], "bash")
        self.assertEqual(settings["skills"], ["~/.claude/skills"])
        self.assertEqual(settings["defaultProvider"], "deepseek")
        self.assertNotIn("defaultModel", settings)

    def test_pi_auth_status_does_not_expose_secret_fields(self):
        self.agent_dir.mkdir(parents=True)
        (self.agent_dir / "auth.json").write_text(
            json.dumps(
                {
                    "deepseek": {"type": "api_key", "key": "sk-secret"},
                    "openai-codex": {
                        "type": "oauth",
                        "access": "access-token",
                        "refresh": "refresh-token",
                    },
                }
            ),
            encoding="utf-8",
        )
        (self.agent_dir / "settings.json").write_text(
            json.dumps({"defaultProvider": "deepseek", "defaultModel": "deepseek-chat"}),
            encoding="utf-8",
        )

        status = server.pi_auth_status()
        serialized = json.dumps(status, ensure_ascii=False)

        self.assertNotIn("sk-secret", serialized)
        self.assertNotIn("access-token", serialized)
        self.assertNotIn("refresh-token", serialized)
        self.assertEqual(status["defaultProvider"], "deepseek")
        providers = {item["provider"]: item for item in status["authenticatedProviders"]}
        self.assertTrue(providers["deepseek"]["isApiKey"])
        self.assertEqual(providers["deepseek"]["name"], "DeepSeek")
        self.assertEqual(providers["deepseek"]["keyPreview"], "sk-s...cret")
        self.assertFalse(providers["openai-codex"]["isApiKey"])
        self.assertEqual(providers["openai-codex"]["name"], "ChatGPT Plus/Pro (Codex)")

    def test_delete_pi_auth_removes_provider_and_falls_back_default(self):
        self.agent_dir.mkdir(parents=True)
        (self.agent_dir / "auth.json").write_text(
            json.dumps(
                {
                    "deepseek": {"type": "api_key", "key": "deepseek-key"},
                    "openai": {"type": "api_key", "key": "openai-key"},
                }
            ),
            encoding="utf-8",
        )
        (self.agent_dir / "settings.json").write_text(
            json.dumps({"defaultProvider": "deepseek", "defaultModel": "deepseek-chat"}),
            encoding="utf-8",
        )

        status = server.delete_pi_api_key_auth("deepseek")

        auth = self.read_auth()
        settings = self.read_settings()
        self.assertNotIn("deepseek", auth)
        self.assertEqual(settings["defaultProvider"], "openai")
        self.assertNotIn("defaultModel", settings)
        self.assertEqual(status["defaultProvider"], "openai")

    def test_delete_last_default_pi_auth_clears_default(self):
        self.agent_dir.mkdir(parents=True)
        (self.agent_dir / "auth.json").write_text(
            json.dumps({"deepseek": {"type": "api_key", "key": "deepseek-key"}}),
            encoding="utf-8",
        )
        (self.agent_dir / "settings.json").write_text(
            json.dumps({"defaultProvider": "deepseek", "defaultModel": "deepseek-chat", "shellPath": "bash"}),
            encoding="utf-8",
        )

        server.delete_pi_api_key_auth("deepseek")

        settings = self.read_settings()
        self.assertNotIn("defaultProvider", settings)
        self.assertNotIn("defaultModel", settings)
        self.assertEqual(settings["shellPath"], "bash")

    def test_default_pi_model_uses_default_provider_candidate(self):
        self.agent_dir.mkdir(parents=True)
        (self.agent_dir / "settings.json").write_text(
            json.dumps({"defaultProvider": "deepseek"}),
            encoding="utf-8",
        )
        candidates = [
            {"value": "openai/gpt-4.1", "provider": "openai", "id": "gpt-4.1"},
            {"value": "deepseek/deepseek-chat", "provider": "deepseek", "id": "deepseek-chat"},
        ]

        self.assertEqual(server.load_default_pi_model(candidates), "deepseek/deepseek-chat")

    def test_pi_auth_rejects_invalid_provider_and_key(self):
        with self.assertRaises(ValueError):
            server.save_pi_api_key_auth("not-real", "sk-test")
        with self.assertRaises(ValueError):
            server.save_pi_api_key_auth("deepseek", "")


if __name__ == "__main__":
    unittest.main()
