ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'open';
CREATE INDEX IF NOT EXISTS support_ticket_queue_idx ON support_tickets(category, status, created_at);

CREATE TABLE IF NOT EXISTS staff_command_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('reply', 'warn', 'suspend')),
  data jsonb NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'prepared', 'confirmed', 'cancelled')),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '15 minutes',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS support_ticket_replies (
  id uuid PRIMARY KEY,
  ticket_id uuid NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  staff_id uuid REFERENCES users(id) ON DELETE SET NULL,
  body text NOT NULL,
  recipient text NOT NULL,
  email_job_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS support_reply_ticket_idx ON support_ticket_replies(ticket_id, created_at);
CREATE TABLE IF NOT EXISTS staff_case_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id uuid REFERENCES reports(id) ON DELETE CASCADE,
  ticket_id uuid REFERENCES support_tickets(id) ON DELETE CASCADE,
  staff_id uuid REFERENCES users(id) ON DELETE SET NULL,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((report_id IS NULL) <> (ticket_id IS NULL))
);
CREATE INDEX IF NOT EXISTS staff_notes_report_idx ON staff_case_notes(report_id, created_at);
CREATE INDEX IF NOT EXISTS staff_notes_ticket_idx ON staff_case_notes(ticket_id, created_at);
