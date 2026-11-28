-- Todo body: description → content
--
-- The todo body shares its Markdown source with documents and is edited in the todo page's inline
-- editor, not the modal "description" textarea. Pure column rename, all data is kept (drizzle-kit
-- reads a rename as "drop column + add column" and its prompt needs a TTY, so this file was
-- handwritten per drizzle's official --custom flow with meta/0001_snapshot.json synced).
ALTER TABLE "todo_items" RENAME COLUMN "description" TO "content";
