'use strict';
// Migrations du module « RH Talents » (GPEC, recrutement par compétences, MBO/SMART, 360°, formation, talents, rémunération,
// effectifs, carrières/succession, engagement). Ajoutées À LA FIN du tableau MIGRATIONS de src/db.js.
// Règles : jamais de renommage ni de suppression ; tout est rejouable (IF NOT EXISTS) ; la table employees n'est PAS modifiée
// (les compléments de fiche vivent dans rh_emp_profile) afin de rester compatible avec les modules qui lisent les fiches employés.
module.exports = [
  // Droits RH, services, référentiel des emplois et des compétences, compétences par employé, besoins futurs, plan d'actions.
  `
  CREATE TABLE IF NOT EXISTS rh_roles (
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    user_id BIGINT NOT NULL,
    role TEXT NOT NULL,
    granted_by BIGINT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (org_id, user_id, role)
  );
  CREATE TABLE IF NOT EXISTS rh_departments (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    budget_headcount BIGINT NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    UNIQUE (org_id, name)
  );
  CREATE TABLE IF NOT EXISTS rh_job_profiles (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    family TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    department_id BIGINT,
    created_at TEXT NOT NULL,
    UNIQUE (org_id, title)
  );
  CREATE TABLE IF NOT EXISTS rh_competencies (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    UNIQUE (org_id, name)
  );
  CREATE TABLE IF NOT EXISTS rh_job_competencies (
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    job_profile_id BIGINT NOT NULL REFERENCES rh_job_profiles(id) ON DELETE CASCADE,
    competency_id BIGINT NOT NULL REFERENCES rh_competencies(id) ON DELETE CASCADE,
    required_level BIGINT NOT NULL DEFAULT 3 CHECK (required_level BETWEEN 1 AND 5),
    weight BIGINT NOT NULL DEFAULT 1 CHECK (weight BETWEEN 1 AND 5),
    PRIMARY KEY (job_profile_id, competency_id)
  );
  CREATE TABLE IF NOT EXISTS rh_emp_profile (
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    employee_id BIGINT PRIMARY KEY REFERENCES employees(id) ON DELETE CASCADE,
    department_id BIGINT,
    job_profile_id BIGINT,
    manager_id BIGINT,
    gender TEXT NOT NULL DEFAULT '',
    level BIGINT NOT NULL DEFAULT 1,
    left_at TEXT,
    left_reason TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS rh_emp_skills (
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    employee_id BIGINT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    competency_id BIGINT NOT NULL REFERENCES rh_competencies(id) ON DELETE CASCADE,
    level BIGINT NOT NULL CHECK (level BETWEEN 1 AND 5),
    source TEXT NOT NULL DEFAULT 'manual',
    assessed_at TEXT NOT NULL,
    assessed_by BIGINT,
    PRIMARY KEY (employee_id, competency_id)
  );
  CREATE TABLE IF NOT EXISTS rh_future_needs (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    year BIGINT NOT NULL,
    job_profile_id BIGINT NOT NULL REFERENCES rh_job_profiles(id) ON DELETE CASCADE,
    needed BIGINT NOT NULL DEFAULT 0,
    note TEXT NOT NULL DEFAULT '',
    UNIQUE (org_id, year, job_profile_id)
  );
  CREATE TABLE IF NOT EXISTS rh_actions (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    ref_id BIGINT,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    employee_id BIGINT,
    competency_id BIGINT,
    owner_id BIGINT,
    due_date TEXT,
    status TEXT NOT NULL DEFAULT 'todo',
    cost BIGINT NOT NULL DEFAULT 0,
    created_by BIGINT,
    created_at TEXT NOT NULL,
    done_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_rh_actions_org ON rh_actions(org_id, kind);
  `,
  // Recrutement par compétences : l'offre et le candidat existants (hr_jobs, hr_candidates) sont complétés, jamais remplacés.
  `
  ALTER TABLE hr_jobs ADD COLUMN IF NOT EXISTS profile_id BIGINT;
  ALTER TABLE hr_jobs ADD COLUMN IF NOT EXISTS department_id BIGINT;
  ALTER TABLE hr_jobs ADD COLUMN IF NOT EXISTS opened_at TEXT;
  ALTER TABLE hr_jobs ADD COLUMN IF NOT EXISTS closed_at TEXT;
  ALTER TABLE hr_jobs ADD COLUMN IF NOT EXISTS recruit_cost BIGINT NOT NULL DEFAULT 0;
  ALTER TABLE hr_candidates ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT '';
  ALTER TABLE hr_candidates ADD COLUMN IF NOT EXISTS stage_at TEXT;
  ALTER TABLE hr_candidates ADD COLUMN IF NOT EXISTS hired_employee_id BIGINT;
  ALTER TABLE hr_candidates ADD COLUMN IF NOT EXISTS hired_at TEXT;
  ALTER TABLE hr_candidates ADD COLUMN IF NOT EXISTS expected_salary BIGINT NOT NULL DEFAULT 0;
  ALTER TABLE hr_candidates ADD COLUMN IF NOT EXISTS reject_reason TEXT NOT NULL DEFAULT '';
  CREATE TABLE IF NOT EXISTS rh_interviews (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    candidate_id BIGINT NOT NULL REFERENCES hr_candidates(id) ON DELETE CASCADE,
    kind TEXT NOT NULL DEFAULT 'structured',
    scheduled_at TEXT,
    interviewer_id BIGINT,
    status TEXT NOT NULL DEFAULT 'planned',
    summary TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS rh_cand_scores (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    candidate_id BIGINT NOT NULL REFERENCES hr_candidates(id) ON DELETE CASCADE,
    interview_id BIGINT,
    competency_id BIGINT NOT NULL REFERENCES rh_competencies(id) ON DELETE CASCADE,
    evaluator_id BIGINT,
    score BIGINT NOT NULL CHECK (score BETWEEN 1 AND 5),
    comment TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_rh_cand_scores ON rh_cand_scores(org_id, candidate_id);
  `,
  // MBO / SMART : objectifs en cascade et historique d'avancement.
  `
  CREATE TABLE IF NOT EXISTS rh_goals (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    level TEXT NOT NULL DEFAULT 'individual',
    parent_id BIGINT,
    employee_id BIGINT,
    department_id BIGINT,
    period TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    unit TEXT NOT NULL DEFAULT '',
    start_value DOUBLE PRECISION NOT NULL DEFAULT 0,
    target_value DOUBLE PRECISION,
    current_value DOUBLE PRECISION NOT NULL DEFAULT 0,
    due_date TEXT,
    weight BIGINT NOT NULL DEFAULT 10,
    status TEXT NOT NULL DEFAULT 'draft',
    smart_score BIGINT NOT NULL DEFAULT 0,
    created_by BIGINT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_rh_goals_org ON rh_goals(org_id, level);
  CREATE TABLE IF NOT EXISTS rh_goal_updates (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    goal_id BIGINT NOT NULL REFERENCES rh_goals(id) ON DELETE CASCADE,
    value DOUBLE PRECISION NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    by_user BIGINT,
    created_at TEXT NOT NULL
  );
  `,
  // Évaluation 360°.
  `
  CREATE TABLE IF NOT EXISTS rh_360_campaigns (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    period TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'draft',
    min_responses BIGINT NOT NULL DEFAULT 3,
    due_date TEXT,
    created_by BIGINT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS rh_360_comps (
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    campaign_id BIGINT NOT NULL REFERENCES rh_360_campaigns(id) ON DELETE CASCADE,
    competency_id BIGINT NOT NULL REFERENCES rh_competencies(id) ON DELETE CASCADE,
    PRIMARY KEY (campaign_id, competency_id)
  );
  CREATE TABLE IF NOT EXISTS rh_360_subjects (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    campaign_id BIGINT NOT NULL REFERENCES rh_360_campaigns(id) ON DELETE CASCADE,
    employee_id BIGINT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    UNIQUE (campaign_id, employee_id)
  );
  CREATE TABLE IF NOT EXISTS rh_360_raters (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    campaign_id BIGINT NOT NULL REFERENCES rh_360_campaigns(id) ON DELETE CASCADE,
    subject_id BIGINT NOT NULL REFERENCES rh_360_subjects(id) ON DELETE CASCADE,
    rater_employee_id BIGINT,
    rater_label TEXT NOT NULL DEFAULT '',
    relation TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    answered_at TEXT
  );
  CREATE TABLE IF NOT EXISTS rh_360_answers (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    rater_id BIGINT NOT NULL REFERENCES rh_360_raters(id) ON DELETE CASCADE,
    competency_id BIGINT NOT NULL REFERENCES rh_competencies(id) ON DELETE CASCADE,
    score BIGINT NOT NULL CHECK (score BETWEEN 1 AND 5),
    comment TEXT NOT NULL DEFAULT '',
    UNIQUE (rater_id, competency_id)
  );
  `,
  // Formation : catalogue, budget annuel, demandes, sessions, présence, évaluations, certificats.
  `
  CREATE TABLE IF NOT EXISTS rh_courses (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT '',
    provider TEXT NOT NULL DEFAULT '',
    hours BIGINT NOT NULL DEFAULT 0,
    unit_cost BIGINT NOT NULL DEFAULT 0,
    description TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS rh_course_competencies (
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    course_id BIGINT NOT NULL REFERENCES rh_courses(id) ON DELETE CASCADE,
    competency_id BIGINT NOT NULL REFERENCES rh_competencies(id) ON DELETE CASCADE,
    target_level BIGINT NOT NULL DEFAULT 3 CHECK (target_level BETWEEN 1 AND 5),
    PRIMARY KEY (course_id, competency_id)
  );
  CREATE TABLE IF NOT EXISTS rh_train_budgets (
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    year BIGINT NOT NULL,
    amount BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (org_id, year)
  );
  CREATE TABLE IF NOT EXISTS rh_train_requests (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    employee_id BIGINT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    course_id BIGINT NOT NULL REFERENCES rh_courses(id) ON DELETE CASCADE,
    year BIGINT NOT NULL,
    reason TEXT NOT NULL DEFAULT '',
    est_cost BIGINT NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'requested',
    requested_by BIGINT,
    decided_by BIGINT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS rh_train_sessions (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    course_id BIGINT NOT NULL REFERENCES rh_courses(id) ON DELETE CASCADE,
    start_date TEXT NOT NULL,
    end_date TEXT,
    place TEXT NOT NULL DEFAULT '',
    trainer TEXT NOT NULL DEFAULT '',
    cost BIGINT NOT NULL DEFAULT 0,
    capacity BIGINT NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'planned',
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS rh_train_attendees (
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    session_id BIGINT NOT NULL REFERENCES rh_train_sessions(id) ON DELETE CASCADE,
    employee_id BIGINT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    presence TEXT NOT NULL DEFAULT 'registered',
    hot_score BIGINT,
    cold_score BIGINT,
    cold_at TEXT,
    cert_no TEXT NOT NULL DEFAULT '',
    cert_expires TEXT,
    PRIMARY KEY (session_id, employee_id)
  );
  `,
  // Talents : 9-box, viviers, plans de développement individuels.
  `
  CREATE TABLE IF NOT EXISTS rh_talent_reviews (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    employee_id BIGINT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    period TEXT NOT NULL,
    performance DOUBLE PRECISION NOT NULL CHECK (performance BETWEEN 1 AND 5),
    potential DOUBLE PRECISION NOT NULL CHECK (potential BETWEEN 1 AND 5),
    note TEXT NOT NULL DEFAULT '',
    reviewer_id BIGINT,
    created_at TEXT NOT NULL,
    UNIQUE (employee_id, period)
  );
  CREATE TABLE IF NOT EXISTS rh_pools (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS rh_pool_members (
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    pool_id BIGINT NOT NULL REFERENCES rh_pools(id) ON DELETE CASCADE,
    employee_id BIGINT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    note TEXT NOT NULL DEFAULT '',
    added_at TEXT NOT NULL,
    PRIMARY KEY (pool_id, employee_id)
  );
  CREATE TABLE IF NOT EXISTS rh_idp (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    employee_id BIGINT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    target_job_profile_id BIGINT,
    horizon TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active',
    created_by BIGINT,
    created_at TEXT NOT NULL
  );
  `,
  // Rémunération : grilles, primes et avantages, simulations.
  `
  CREATE TABLE IF NOT EXISTS rh_pay_grades (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    job_profile_id BIGINT NOT NULL REFERENCES rh_job_profiles(id) ON DELETE CASCADE,
    level BIGINT NOT NULL DEFAULT 1,
    min_salary BIGINT NOT NULL,
    mid_salary BIGINT NOT NULL,
    max_salary BIGINT NOT NULL,
    UNIQUE (job_profile_id, level)
  );
  CREATE TABLE IF NOT EXISTS rh_pay_items (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    employee_id BIGINT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    kind TEXT NOT NULL DEFAULT 'bonus',
    label TEXT NOT NULL,
    amount BIGINT NOT NULL DEFAULT 0,
    recurrence TEXT NOT NULL DEFAULT 'monthly',
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS rh_pay_sims (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    params TEXT NOT NULL DEFAULT '{}',
    result TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'draft',
    created_by BIGINT,
    created_at TEXT NOT NULL,
    applied_at TEXT
  );
  `,
  // Planification des effectifs : scénarios d'embauche.
  `
  CREATE TABLE IF NOT EXISTS rh_scenarios (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    year BIGINT NOT NULL,
    charges_rate DOUBLE PRECISION NOT NULL DEFAULT 0.2,
    created_by BIGINT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS rh_scenario_lines (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    scenario_id BIGINT NOT NULL REFERENCES rh_scenarios(id) ON DELETE CASCADE,
    department_id BIGINT,
    job_profile_id BIGINT,
    qty BIGINT NOT NULL DEFAULT 1,
    start_month BIGINT NOT NULL DEFAULT 1 CHECK (start_month BETWEEN 1 AND 12),
    monthly_salary BIGINT NOT NULL DEFAULT 0
  );
  `,
  // Carrières, succession, rétention, engagement.
  `
  CREATE TABLE IF NOT EXISTS rh_career_paths (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    from_job_id BIGINT NOT NULL REFERENCES rh_job_profiles(id) ON DELETE CASCADE,
    to_job_id BIGINT NOT NULL REFERENCES rh_job_profiles(id) ON DELETE CASCADE,
    typical_years BIGINT NOT NULL DEFAULT 2,
    note TEXT NOT NULL DEFAULT '',
    UNIQUE (from_job_id, to_job_id)
  );
  CREATE TABLE IF NOT EXISTS rh_key_positions (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    job_profile_id BIGINT REFERENCES rh_job_profiles(id) ON DELETE SET NULL,
    title TEXT NOT NULL,
    holder_id BIGINT,
    criticality BIGINT NOT NULL DEFAULT 2 CHECK (criticality BETWEEN 1 AND 3),
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS rh_successors (
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    key_position_id BIGINT NOT NULL REFERENCES rh_key_positions(id) ON DELETE CASCADE,
    employee_id BIGINT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    readiness TEXT NOT NULL DEFAULT 'later',
    note TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (key_position_id, employee_id)
  );
  CREATE TABLE IF NOT EXISTS rh_retention (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    employee_id BIGINT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    risk TEXT NOT NULL DEFAULT 'low',
    reason TEXT NOT NULL DEFAULT '',
    plan TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL,
    UNIQUE (org_id, employee_id)
  );
  CREATE TABLE IF NOT EXISTS rh_surveys (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft',
    min_responses BIGINT NOT NULL DEFAULT 5,
    questions TEXT NOT NULL DEFAULT '[]',
    created_by BIGINT,
    created_at TEXT NOT NULL,
    closed_at TEXT
  );
  CREATE TABLE IF NOT EXISTS rh_survey_participation (
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    survey_id BIGINT NOT NULL REFERENCES rh_surveys(id) ON DELETE CASCADE,
    user_id BIGINT NOT NULL,
    PRIMARY KEY (survey_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS rh_survey_responses (
    id BIGSERIAL PRIMARY KEY,
    org_id BIGINT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    survey_id BIGINT NOT NULL REFERENCES rh_surveys(id) ON DELETE CASCADE,
    department_id BIGINT,
    answers TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
  );
  `,
];
