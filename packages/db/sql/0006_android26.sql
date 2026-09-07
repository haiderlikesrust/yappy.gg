-- Personal folders never change membership or visibility of a conversation.
CREATE TABLE IF NOT EXISTS chat_folders (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 40), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS chat_folders_user_idx ON chat_folders(user_id);
CREATE TABLE IF NOT EXISTS chat_folder_items (
  folder_id uuid NOT NULL REFERENCES chat_folders(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  PRIMARY KEY(folder_id, conversation_id)
);
-- Album entries reference chat messages so removal, expiry and history floors
-- continue to use the same read boundary as the originating conversation.
CREATE TABLE IF NOT EXISTS photo_walls (
  id uuid PRIMARY KEY, conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  creator_id uuid NOT NULL REFERENCES users(id), title text NOT NULL CHECK(length(title) BETWEEN 1 AND 80),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS photo_walls_conversation_idx ON photo_walls(conversation_id);
CREATE TABLE IF NOT EXISTS photo_wall_items (
  wall_id uuid NOT NULL REFERENCES photo_walls(id) ON DELETE CASCADE,
  message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  contributor_id uuid NOT NULL REFERENCES users(id), added_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(wall_id, message_id)
);
