'use strict';
// Réunions avancées : migrations 146 et suivantes (append-only : ne jamais modifier une migration existante, ajouter à la suite).
//  146 : champs de la réunion (site, service, niveau d'urgence, président de séance, horaires réels, quorum réduit, archivage, exceptions de série),
//        participants (pondération, retard), points d'ordre du jour (nature, proposition d'un participant, durée réelle), types personnalisés, périmètre multi-sites / inter-services ;
//  147 : résolutions, votes, liste d'émargement du vote (qui a voté, jamais ce qu'il a voté en vote secret) ;
//  148 : procès-verbaux numérotés et signatures électroniques (compte rendu et PV) ;
//  149 : historique des responsabilités (qui a été responsable de quoi, quand), avec reprise de l'existant.
// Tout est rejouable (IF NOT EXISTS / NOT EXISTS) ; aucune table existante n'est supprimée ni réécrite.
module.exports = [
  `
  ALTER TABLE mtg_meetings ADD COLUMN IF NOT EXISTS branch_id BIGINT REFERENCES branches(id) ON DELETE SET NULL;
  ALTER TABLE mtg_meetings ADD COLUMN IF NOT EXISTS department_id BIGINT;
  ALTER TABLE mtg_meetings ADD COLUMN IF NOT EXISTS type_id BIGINT;
  ALTER TABLE mtg_meetings ADD COLUMN IF NOT EXISTS urgency TEXT NOT NULL DEFAULT 'normal';
  ALTER TABLE mtg_meetings ADD COLUMN IF NOT EXISTS chair_id BIGINT;
  ALTER TABLE mtg_meetings ADD COLUMN IF NOT EXISTS started_at TEXT;
  ALTER TABLE mtg_meetings ADD COLUMN IF NOT EXISTS ended_at TEXT;
  ALTER TABLE mtg_meetings ADD COLUMN IF NOT EXISTS quorum_mode TEXT NOT NULL DEFAULT 'normal';
  ALTER TABLE mtg_meetings ADD COLUMN IF NOT EXISTS parent_id BIGINT;
  ALTER TABLE mtg_meetings ADD COLUMN IF NOT EXISTS no_quorum_reason TEXT NOT NULL DEFAULT '';
  ALTER TABLE mtg_meetings ADD COLUMN IF NOT EXISTS series_exceptions TEXT NOT NULL DEFAULT '';
  ALTER TABLE mtg_meetings ADD COLUMN IF NOT EXISTS archived_at TEXT;
  ALTER TABLE mtg_meetings ADD COLUMN IF NOT EXISTS quorum_alerted_at TEXT;
  CREATE INDEX IF NOT EXISTS idx_mtg_meetings_branch ON mtg_meetings(org_id, branch_id);
  CREATE INDEX IF NOT EXISTS idx_mtg_meetings_dept ON mtg_meetings(org_id, department_id);

  ALTER TABLE mtg_participants ADD COLUMN IF NOT EXISTS vote_weight DOUBLE PRECISION;
  ALTER TABLE mtg_participants ADD COLUMN IF NOT EXISTS late_min BIGINT NOT NULL DEFAULT 0;

  ALTER TABLE mtg_agenda ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'discuss';
  ALTER TABLE mtg_agenda ADD COLUMN IF NOT EXISTS proposed_by BIGINT;
  ALTER TABLE mtg_agenda ADD COLUMN IF NOT EXISTS accepted BIGINT NOT NULL DEFAULT 1;
  ALTER TABLE mtg_agenda ADD COLUMN IF NOT EXISTS spent_min BIGINT NOT NULL DEFAULT 0;

  ALTER TABLE mtg_decisions ADD COLUMN IF NOT EXISTS resolution_id BIGINT;

  CREATE TABLE IF NOT EXISTS mtg_types (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    base TEXT NOT NULL DEFAULT 'team',
    color TEXT NOT NULL DEFAULT '',
    duration_min BIGINT NOT NULL DEFAULT 60,
    confidential BIGINT NOT NULL DEFAULT 0,
    reminder_min BIGINT NOT NULL DEFAULT 0,
    quorum TEXT NOT NULL DEFAULT '',
    template_id BIGINT,
    active BIGINT NOT NULL DEFAULT 1,
    created_by BIGINT,
    created_at TEXT NOT NULL,
    UNIQUE (org_id, name)
  );

  CREATE TABLE IF NOT EXISTS mtg_scope (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    meeting_id BIGINT NOT NULL REFERENCES mtg_meetings(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    ref_id BIGINT NOT NULL,
    UNIQUE (meeting_id, kind, ref_id)
  );
  CREATE INDEX IF NOT EXISTS idx_mtg_scope_ref ON mtg_scope(org_id, kind, ref_id);
  `,
  `
  CREATE TABLE IF NOT EXISTS mtg_resolutions (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    meeting_id BIGINT NOT NULL REFERENCES mtg_meetings(id) ON DELETE CASCADE,
    agenda_id BIGINT REFERENCES mtg_agenda(id) ON DELETE SET NULL,
    year BIGINT NOT NULL,
    seq BIGINT NOT NULL,
    number TEXT NOT NULL,
    position BIGINT NOT NULL DEFAULT 0,
    title TEXT NOT NULL DEFAULT '',
    text TEXT NOT NULL,
    carrier_id BIGINT,
    carrier_name TEXT NOT NULL DEFAULT '',
    due TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    majority TEXT NOT NULL DEFAULT 'simple',
    threshold BIGINT NOT NULL DEFAULT 67,
    weighted BIGINT NOT NULL DEFAULT 0,
    vote_mode TEXT NOT NULL DEFAULT 'named',
    vote_state TEXT NOT NULL DEFAULT 'none',
    opened_by BIGINT,
    opened_at TEXT,
    closed_by BIGINT,
    closed_at TEXT,
    result TEXT NOT NULL DEFAULT '',
    result_hash TEXT NOT NULL DEFAULT '',
    postponed_reason TEXT NOT NULL DEFAULT '',
    postponed_to BIGINT,
    created_by BIGINT,
    created_at TEXT NOT NULL,
    UNIQUE (org_id, number)
  );
  CREATE INDEX IF NOT EXISTS idx_mtg_res_meeting ON mtg_resolutions(meeting_id, position);
  CREATE INDEX IF NOT EXISTS idx_mtg_res_org ON mtg_resolutions(org_id, status, year);

  CREATE TABLE IF NOT EXISTS mtg_votes (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    resolution_id BIGINT NOT NULL REFERENCES mtg_resolutions(id) ON DELETE CASCADE,
    voter_key TEXT NOT NULL,
    participant_id BIGINT,
    choice TEXT NOT NULL,
    weight DOUBLE PRECISION NOT NULL DEFAULT 1,
    cast_at TEXT,
    UNIQUE (resolution_id, voter_key)
  );
  CREATE INDEX IF NOT EXISTS idx_mtg_votes_res ON mtg_votes(resolution_id);

  CREATE TABLE IF NOT EXISTS mtg_vote_roll (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    resolution_id BIGINT NOT NULL REFERENCES mtg_resolutions(id) ON DELETE CASCADE,
    participant_id BIGINT NOT NULL,
    voted_at TEXT NOT NULL,
    entered_by BIGINT,
    UNIQUE (resolution_id, participant_id)
  );
  `,
  `
  CREATE TABLE IF NOT EXISTS mtg_pv (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    meeting_id BIGINT NOT NULL REFERENCES mtg_meetings(id) ON DELETE CASCADE,
    year BIGINT NOT NULL,
    seq BIGINT NOT NULL,
    number TEXT NOT NULL,
    version BIGINT NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'draft',
    narrative TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL DEFAULT '{}',
    content_hash TEXT NOT NULL DEFAULT '',
    ordered BIGINT NOT NULL DEFAULT 0,
    reason TEXT NOT NULL DEFAULT '',
    created_by BIGINT,
    created_at TEXT NOT NULL,
    locked_at TEXT,
    signed_at TEXT,
    UNIQUE (org_id, number)
  );
  CREATE INDEX IF NOT EXISTS idx_mtg_pv_meeting ON mtg_pv(meeting_id, version);

  CREATE TABLE IF NOT EXISTS mtg_signatures (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    meeting_id BIGINT NOT NULL REFERENCES mtg_meetings(id) ON DELETE CASCADE,
    doc_kind TEXT NOT NULL,
    doc_id BIGINT NOT NULL,
    position BIGINT NOT NULL DEFAULT 0,
    user_id BIGINT NOT NULL,
    role TEXT NOT NULL DEFAULT '',
    signed_at TEXT,
    content_hash TEXT NOT NULL DEFAULT '',
    comment TEXT NOT NULL DEFAULT '',
    reminded_at TEXT,
    UNIQUE (doc_kind, doc_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS idx_mtg_sign_meeting ON mtg_signatures(meeting_id);
  CREATE INDEX IF NOT EXISTS idx_mtg_sign_user ON mtg_signatures(org_id, user_id, signed_at);
  `,
  `
  CREATE TABLE IF NOT EXISTS mtg_resp (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    meeting_id BIGINT,
    kind TEXT NOT NULL,
    ref_id BIGINT NOT NULL DEFAULT 0,
    user_id BIGINT,
    user_name TEXT NOT NULL DEFAULT '',
    role TEXT NOT NULL DEFAULT '',
    subject TEXT NOT NULL DEFAULT '',
    event TEXT NOT NULL DEFAULT 'assigned',
    at TEXT NOT NULL,
    by_user BIGINT,
    confidential BIGINT NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_mtg_resp_user ON mtg_resp(org_id, user_id, at);
  CREATE INDEX IF NOT EXISTS idx_mtg_resp_meeting ON mtg_resp(meeting_id, at);
  CREATE INDEX IF NOT EXISTS idx_mtg_resp_ref ON mtg_resp(org_id, kind, ref_id);

  INSERT INTO mtg_resp (org_id, meeting_id, kind, ref_id, user_id, role, subject, event, at, by_user, confidential)
  SELECT m.org_id, m.id, 'role', m.id, m.organizer_id, 'organizer', m.title, 'assigned', m.created_at, m.created_by, m.confidential
  FROM mtg_meetings m WHERE m.organizer_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM mtg_resp r WHERE r.meeting_id = m.id AND r.kind = 'role' AND r.role = 'organizer');
  INSERT INTO mtg_resp (org_id, meeting_id, kind, ref_id, user_id, role, subject, event, at, by_user, confidential)
  SELECT m.org_id, m.id, 'role', m.id, m.secretary_id, 'secretary', m.title, 'assigned', m.created_at, m.created_by, m.confidential
  FROM mtg_meetings m WHERE m.secretary_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM mtg_resp r WHERE r.meeting_id = m.id AND r.kind = 'role' AND r.role = 'secretary');
  INSERT INTO mtg_resp (org_id, meeting_id, kind, ref_id, user_id, user_name, role, subject, event, at, by_user, confidential)
  SELECT a.org_id, a.meeting_id, 'action', a.id, a.assignee_id, a.assignee_name, 'assignee', a.text, 'assigned', a.created_at, a.created_by, m.confidential
  FROM mtg_actions a JOIN mtg_meetings m ON m.id = a.meeting_id
  WHERE (a.assignee_id IS NOT NULL OR a.assignee_name <> '')
    AND NOT EXISTS (SELECT 1 FROM mtg_resp r WHERE r.kind = 'action' AND r.ref_id = a.id);
  `,
];
