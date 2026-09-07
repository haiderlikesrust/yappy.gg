-- Shared albums and contributions must not prevent permanent account deletion.
ALTER TABLE photo_walls DROP CONSTRAINT IF EXISTS photo_walls_creator_id_fkey;
ALTER TABLE photo_walls ADD CONSTRAINT photo_walls_creator_id_fkey
  FOREIGN KEY (creator_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE photo_wall_items DROP CONSTRAINT IF EXISTS photo_wall_items_contributor_id_fkey;
ALTER TABLE photo_wall_items ADD CONSTRAINT photo_wall_items_contributor_id_fkey
  FOREIGN KEY (contributor_id) REFERENCES users(id) ON DELETE CASCADE;
