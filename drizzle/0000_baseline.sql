-- RytenBench database baseline (drizzle migration 0000)
--
-- Contents: merge of the 24 pre-drizzle table-creation SQL files, in filename order.
-- Idempotent DDL only (CREATE TABLE/INDEX IF NOT EXISTS, ALTER TABLE ... DROP COLUMN IF EXISTS):
--   * Fresh install: this migration creates all 24 tables;
--   * Existing DB: all no-ops; the baseline is only recorded in drizzle.__drizzle_migrations.
-- Historical snapshot, **do not edit by hand**; new migrations via `pnpm drizzle-kit generate`.

-- Database migration history table
CREATE TABLE IF NOT EXISTS schema_migrations (
    id          SERIAL PRIMARY KEY,
    script_name TEXT      NOT NULL UNIQUE,
    executed_at TIMESTAMP DEFAULT NOW(),
    version     TEXT,
    description TEXT
);
--> statement-breakpoint
-- Image storage table (deduplicated by MD5)
CREATE TABLE IF NOT EXISTS images (
    id         TEXT      PRIMARY KEY,
    data       TEXT      NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);
--> statement-breakpoint
-- Workspace table
CREATE TABLE IF NOT EXISTS workspace (
    id         SERIAL PRIMARY KEY,
    name       TEXT      NOT NULL,
    path       TEXT      NOT NULL UNIQUE,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);
--> statement-breakpoint
-- Todo items table (global data, not isolated per workspace)
CREATE TABLE IF NOT EXISTS todo_items (
    id           SERIAL PRIMARY KEY,
    title        TEXT      NOT NULL,
    description  TEXT,
    due_date     DATE,
    priority     INTEGER   DEFAULT 0,
    status       INTEGER   DEFAULT 0,
    category     TEXT,
    created_at   TIMESTAMP DEFAULT NOW(),
    updated_at   TIMESTAMP DEFAULT NOW(),
    started_at   TIMESTAMP,
    completed_at TIMESTAMP
);
--> statement-breakpoint
-- Migration: drop the legacy workspace isolation column (todos are now global and shared)
ALTER TABLE todo_items DROP COLUMN IF EXISTS workspace_id;
--> statement-breakpoint
-- Todo items table indexes
CREATE INDEX IF NOT EXISTS idx_todo_priority   ON todo_items (priority);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_todo_status     ON todo_items (status);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_todo_due_date   ON todo_items (due_date);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_todo_category   ON todo_items (category);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_todo_created_at ON todo_items (created_at);
--> statement-breakpoint
-- Task dependency table (used by the Gantt chart to show predecessor/successor links)
CREATE TABLE IF NOT EXISTS task_dependencies (
    id                 SERIAL PRIMARY KEY,
    task_id            INTEGER   NOT NULL,
    depends_on_task_id INTEGER   NOT NULL,
    created_at         TIMESTAMP DEFAULT NOW(),
    FOREIGN KEY (task_id)            REFERENCES todo_items (id) ON DELETE CASCADE,
    FOREIGN KEY (depends_on_task_id) REFERENCES todo_items (id) ON DELETE CASCADE,
    UNIQUE (task_id, depends_on_task_id)
);
--> statement-breakpoint
-- Task dependency table indexes
CREATE INDEX IF NOT EXISTS idx_task_deps_task       ON task_dependencies (task_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_task_deps_depends_on ON task_dependencies (depends_on_task_id);
--> statement-breakpoint
-- Gantt planner tasks table (supports tree levels: project > phase > task)
CREATE TABLE IF NOT EXISTS planner_tasks (
    id              SERIAL PRIMARY KEY,
    parent_id       INTEGER,
    title           TEXT      NOT NULL,
    type            TEXT      NOT NULL DEFAULT 'task',
    progress        INTEGER   DEFAULT 0,
    work_hours      INTEGER   DEFAULT 0,
    priority        INTEGER   DEFAULT 0,
    start_date      TIMESTAMP,
    end_date        TIMESTAMP,
    sort_order      INTEGER   DEFAULT 0,
    created_at      TIMESTAMP DEFAULT NOW(),
    updated_at      TIMESTAMP DEFAULT NOW(),
    FOREIGN KEY (parent_id) REFERENCES planner_tasks (id) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_planner_tasks_parent ON planner_tasks (parent_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_planner_tasks_type   ON planner_tasks (type);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_planner_tasks_sort   ON planner_tasks (sort_order);
--> statement-breakpoint
-- Migration: add the priority column for existing databases
ALTER TABLE planner_tasks ADD COLUMN IF NOT EXISTS priority INTEGER DEFAULT 0;
--> statement-breakpoint
-- Gantt task dependency table
CREATE TABLE IF NOT EXISTS planner_dependencies (
    id                 SERIAL PRIMARY KEY,
    task_id            INTEGER   NOT NULL,
    depends_on_task_id INTEGER   NOT NULL,
    created_at         TIMESTAMP DEFAULT NOW(),
    FOREIGN KEY (task_id)            REFERENCES planner_tasks (id) ON DELETE CASCADE,
    FOREIGN KEY (depends_on_task_id) REFERENCES planner_tasks (id) ON DELETE CASCADE,
    UNIQUE (task_id, depends_on_task_id)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_planner_deps_task       ON planner_dependencies (task_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_planner_deps_depends_on ON planner_dependencies (depends_on_task_id);
--> statement-breakpoint
-- Knowledge base table (global data, not isolated per workspace)
CREATE TABLE IF NOT EXISTS wiki (
    id         SERIAL PRIMARY KEY,
    title      TEXT      NOT NULL,
    summary    TEXT,
    tags       TEXT,
    image_id   TEXT      REFERENCES images(id),
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);
--> statement-breakpoint
-- Migration: drop legacy workspace column (wiki is now global and shared across workspaces)
ALTER TABLE wiki DROP COLUMN IF EXISTS workspace_id;
--> statement-breakpoint
-- Knowledge base table indexes
CREATE INDEX IF NOT EXISTS idx_wiki_title       ON wiki (title);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_wiki_created_at  ON wiki (created_at);
--> statement-breakpoint
-- Knowledge base directory table
CREATE TABLE IF NOT EXISTS wiki_directories (
    id         SERIAL PRIMARY KEY,
    wiki_id    INTEGER   NOT NULL,
    parent_id  INTEGER,
    name       TEXT      NOT NULL,
    sort_order INTEGER   DEFAULT 0,
    level      INTEGER   DEFAULT 0,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    FOREIGN KEY (wiki_id)   REFERENCES wiki (id) ON DELETE CASCADE,
    FOREIGN KEY (parent_id) REFERENCES wiki_directories (id) ON DELETE CASCADE
);
--> statement-breakpoint
-- Knowledge base directory table indexes
CREATE INDEX IF NOT EXISTS idx_wiki_directories_wiki_parent ON wiki_directories (wiki_id, parent_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_wiki_directories_sort_order  ON wiki_directories (sort_order);
--> statement-breakpoint
-- Documents table (global data, not isolated per workspace)
CREATE TABLE IF NOT EXISTS documents (
    id         SERIAL PRIMARY KEY,
    title      TEXT      NOT NULL,
    summary    TEXT,
    tags       TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);
--> statement-breakpoint
-- Migration: drop legacy workspace column (documents are now global and shared across workspaces)
ALTER TABLE documents DROP COLUMN IF EXISTS workspace_id;
--> statement-breakpoint
-- Documents table indexes
CREATE INDEX IF NOT EXISTS idx_documents_title      ON documents (title);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_documents_created_at ON documents (created_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_documents_updated_at ON documents (updated_at);
--> statement-breakpoint
-- Document content table
CREATE TABLE IF NOT EXISTS documents_content (
    id         SERIAL PRIMARY KEY,
    doc_id     INTEGER   NOT NULL UNIQUE,
    image_id   TEXT      REFERENCES images(id),
    content    TEXT,
    chunk_key  TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    FOREIGN KEY (doc_id) REFERENCES documents (id) ON DELETE CASCADE
);
--> statement-breakpoint
-- Directory-document link table (many-to-many)
CREATE TABLE IF NOT EXISTS directory_documents (
    id           SERIAL PRIMARY KEY,
    directory_id INTEGER   NOT NULL,
    doc_id       INTEGER   NOT NULL,
    sort_order   INTEGER   DEFAULT 0,
    created_at   TIMESTAMP DEFAULT NOW(),
    FOREIGN KEY (directory_id) REFERENCES wiki_directories (id) ON DELETE CASCADE,
    FOREIGN KEY (doc_id)       REFERENCES documents (id) ON DELETE CASCADE,
    UNIQUE (directory_id, doc_id)
);
--> statement-breakpoint
-- Link table indexes
CREATE INDEX IF NOT EXISTS idx_directory_documents_dir ON directory_documents (directory_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_directory_documents_doc ON directory_documents (doc_id);
--> statement-breakpoint
-- Chat topic table (session level; conversations under one workspace_id)
CREATE TABLE IF NOT EXISTS chat_topic (
    id            SERIAL PRIMARY KEY,
    workspace_id  INTEGER   NOT NULL,
    title         TEXT      NOT NULL,
    model         TEXT,
    selected_tools TEXT,
    created_at    TIMESTAMP DEFAULT NOW(),
    updated_at    TIMESTAMP DEFAULT NOW(),
    FOREIGN KEY (workspace_id) REFERENCES workspace (id) ON DELETE CASCADE
);
--> statement-breakpoint
-- Chat topic table indexes
CREATE INDEX IF NOT EXISTS idx_chat_topic_workspace  ON chat_topic (workspace_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_chat_topic_updated_at ON chat_topic (updated_at);
--> statement-breakpoint
-- Chat message table (message level)
CREATE TABLE IF NOT EXISTS chat_dialogue (
    id         SERIAL PRIMARY KEY,
    topic_id   INTEGER   NOT NULL,
    role       TEXT      NOT NULL CHECK (role IN ('user', 'assistant')),
    content    TEXT      NOT NULL,
    blocks     TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    FOREIGN KEY (topic_id) REFERENCES chat_topic (id) ON DELETE CASCADE
);
--> statement-breakpoint
-- Chat message table indexes
CREATE INDEX IF NOT EXISTS idx_chat_dialogue_topic         ON chat_dialogue (topic_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_chat_dialogue_topic_created ON chat_dialogue (topic_id, created_at);
--> statement-breakpoint
-- Agent config table (isolated per workspace)
CREATE TABLE IF NOT EXISTS agent_config (
    id           SERIAL PRIMARY KEY,
    workspace_id INTEGER   NOT NULL,
    name         TEXT      NOT NULL,
    rename       TEXT,
    prompt       TEXT,
    description  TEXT,
    skills       TEXT,
    model        TEXT,
    tools        TEXT,
    enable       BOOLEAN   DEFAULT TRUE,
    created_at   TIMESTAMP DEFAULT NOW(),
    updated_at   TIMESTAMP DEFAULT NOW(),
    FOREIGN KEY (workspace_id) REFERENCES workspace (id) ON DELETE CASCADE,
    UNIQUE (workspace_id, name)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_agent_config_workspace ON agent_config (workspace_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_agent_config_enable   ON agent_config (enable);
--> statement-breakpoint
-- Canvas node position table
CREATE TABLE IF NOT EXISTS node_positions (
    node_id    TEXT      NOT NULL PRIMARY KEY,
    x          REAL      NOT NULL DEFAULT 0,
    y          REAL      NOT NULL DEFAULT 0,
    updated_at TIMESTAMP DEFAULT NOW()
);
--> statement-breakpoint
-- Music folder table
CREATE TABLE IF NOT EXISTS music_folders (
    id          TEXT PRIMARY KEY,
    path        TEXT NOT NULL UNIQUE,
    name        TEXT NOT NULL,
    description TEXT,
    track_count INTEGER DEFAULT 0,
    image_id    TEXT REFERENCES images(id),
    created_at  TIMESTAMP DEFAULT NOW(),
    updated_at  TIMESTAMP DEFAULT NOW()
);
--> statement-breakpoint
-- Music track table
CREATE TABLE IF NOT EXISTS music_tracks (
    id             SERIAL PRIMARY KEY,
    file_path      TEXT NOT NULL,
    file_hash      TEXT NOT NULL,
    folder_id      TEXT NOT NULL,
    title          TEXT NOT NULL,
    artist         TEXT,
    album          TEXT,
    duration       REAL,
    liked          BOOLEAN   DEFAULT FALSE,
    last_played_at TIMESTAMP,
    image_id       TEXT REFERENCES images(id),
    created_at     TIMESTAMP DEFAULT NOW(),
    FOREIGN KEY (folder_id) REFERENCES music_folders(id) ON DELETE CASCADE,
    UNIQUE (folder_id, file_hash)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_music_tracks_folder ON music_tracks(folder_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_music_tracks_file_hash ON music_tracks(file_hash);
--> statement-breakpoint
-- LLM provider table
CREATE TABLE IF NOT EXISTS llm_providers
(
  id          SERIAL PRIMARY KEY,
  name        TEXT   NOT NULL,
  -- provider is the API protocol id (openai / anthropic / zhipu); free input, no allowlist
  provider    TEXT   NOT NULL,
  base_url    TEXT,
  api_key_encrypted TEXT,
  model       TEXT   NOT NULL,
  temperature REAL             DEFAULT 0.7,
  max_tokens  INTEGER,
  extra_config TEXT,
  metadata    TEXT,
  is_default  BOOLEAN          DEFAULT FALSE,
  is_enabled  BOOLEAN          DEFAULT TRUE,
  sort_order  INTEGER          DEFAULT 0,
  created_at  TIMESTAMP        DEFAULT NOW(),
  updated_at  TIMESTAMP        DEFAULT NOW()
);
--> statement-breakpoint
-- Ensure a single default provider (PostgreSQL partial unique index)
CREATE UNIQUE INDEX IF NOT EXISTS idx_llm_providers_default ON llm_providers (is_default) WHERE is_default = TRUE;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_llm_providers_enabled ON llm_providers (is_enabled);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_llm_providers_sort ON llm_providers (sort_order);
--> statement-breakpoint
-- Knowledge graph entity table
CREATE TABLE IF NOT EXISTS graph_entities (
  id              SERIAL PRIMARY KEY,
  wiki_id         INTEGER NOT NULL REFERENCES wiki(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  type            TEXT NOT NULL,
  description     TEXT,
  aliases         TEXT,
  properties      TEXT,
  confidence      REAL DEFAULT 1.0,
  source_note_ids TEXT,
  created_at      TIMESTAMP DEFAULT NOW(),
  updated_at      TIMESTAMP DEFAULT NOW()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_graph_entities_wiki ON graph_entities(wiki_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_graph_entities_type ON graph_entities(type);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_graph_entities_name ON graph_entities(name);
--> statement-breakpoint
-- Knowledge graph relation table
CREATE TABLE IF NOT EXISTS graph_relations (
  id              SERIAL PRIMARY KEY,
  wiki_id         INTEGER NOT NULL REFERENCES wiki(id) ON DELETE CASCADE,
  source_id       INTEGER NOT NULL REFERENCES graph_entities(id) ON DELETE CASCADE,
  target_id       INTEGER NOT NULL REFERENCES graph_entities(id) ON DELETE CASCADE,
  relation_type   TEXT NOT NULL,
  description     TEXT,
  properties      TEXT,
  confidence      REAL DEFAULT 1.0,
  source_note_ids TEXT,
  created_at      TIMESTAMP DEFAULT NOW()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_graph_relations_wiki ON graph_relations(wiki_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_graph_relations_source ON graph_relations(source_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_graph_relations_target ON graph_relations(target_id);
--> statement-breakpoint
-- Graph build job table (one row per knowledge base, enforced by the wiki_id unique constraint)
CREATE TABLE IF NOT EXISTS graph_build_jobs (
  id                SERIAL PRIMARY KEY,
  wiki_id           INTEGER NOT NULL REFERENCES wiki(id) ON DELETE CASCADE,
  status            TEXT NOT NULL DEFAULT 'pending',
  total_notes       INTEGER DEFAULT 0,
  processed_notes   INTEGER DEFAULT 0,
  entity_count      INTEGER DEFAULT 0,
  relation_count    INTEGER DEFAULT 0,
  error_message     TEXT,
  config            TEXT,
  processed_note_ids TEXT,
  started_at        TIMESTAMP,
  completed_at      TIMESTAMP,
  created_at        TIMESTAMP DEFAULT NOW(),
  CONSTRAINT uq_graph_build_jobs_wiki UNIQUE (wiki_id)
);
--> statement-breakpoint
-- 023_chat_goals.sql
-- Conversation goal persistence: each topic has at most one current goal (single-goal semantics).
-- revision is used for CAS (optimistic concurrency): tool updates must carry {goal_id, revision},
-- and stale revisions are rejected.
-- activation (armed/disarmed) is in-memory and not persisted: after a process restart every goal is
-- disarmed and is re-armed when the user asks to "continue", which triggers update_goal(resume).

CREATE TABLE IF NOT EXISTS chat_goals (
  topic_id         INTEGER PRIMARY KEY,
  goal_id          TEXT NOT NULL,
  revision         INTEGER NOT NULL DEFAULT 1,
  objective        TEXT NOT NULL,
  phase            TEXT NOT NULL DEFAULT 'active'
                   CHECK (phase IN ('active', 'paused', 'blocked', 'complete')),
  rounds_started   INTEGER NOT NULL DEFAULT 0,
  max_goal_rounds  INTEGER NOT NULL DEFAULT 256,
  blocked_reason   TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_chat_goals_phase ON chat_goals (phase);
--> statement-breakpoint
-- 024_topic_compactions.sql
-- Topic-level context compaction checkpoint (persisted):
-- at most one row per topic, holding the LLM summary. After the first compaction later rounds
-- reuse it; merged incrementally only when the boundary advances (context back over budget).

CREATE TABLE IF NOT EXISTS topic_compactions (
  topic_id    INTEGER PRIMARY KEY,
  -- id of the last summarized dialogue record (compaction boundary; larger ids trigger merge)
  boundary_id INTEGER NOT NULL,
  -- checkpoint summary (LLM output, stored verbatim)
  summary     TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
