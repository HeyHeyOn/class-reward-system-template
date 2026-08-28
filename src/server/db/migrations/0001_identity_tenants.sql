CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  google_subject text NOT NULL,
  canonical_email text NOT NULL,
  display_name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_google_subject_unique UNIQUE (google_subject),
  CONSTRAINT users_canonical_email_unique UNIQUE (canonical_email),
  CONSTRAINT users_google_subject_canonical_check
    CHECK (google_subject = btrim(google_subject) AND length(google_subject) > 0),
  CONSTRAINT users_canonical_email_check
    CHECK (canonical_email = lower(btrim(canonical_email)) AND length(canonical_email) > 0)
);

CREATE TABLE tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL,
  display_name text NOT NULL,
  lifecycle text NOT NULL DEFAULT 'DRAFT',
  timezone text NOT NULL DEFAULT 'Asia/Seoul',
  credential_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tenants_slug_unique UNIQUE (slug),
  CONSTRAINT tenants_slug_canonical_check
    CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  CONSTRAINT tenants_display_name_check CHECK (length(btrim(display_name)) > 0),
  CONSTRAINT tenants_lifecycle_check CHECK (
    lifecycle IN ('DRAFT', 'IMPORTING', 'READY', 'ACTIVE', 'MIGRATION_READ_ONLY', 'SUSPENDED')
  ),
  CONSTRAINT tenants_timezone_check CHECK (timezone = 'Asia/Seoul'),
  CONSTRAINT tenants_credential_version_check CHECK (credential_version >= 1)
);

CREATE TABLE tenant_memberships (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  role text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tenant_memberships_pkey PRIMARY KEY (tenant_id, id),
  CONSTRAINT tenant_memberships_tenant_fk FOREIGN KEY (tenant_id)
    REFERENCES tenants (id) ON DELETE CASCADE,
  CONSTRAINT tenant_memberships_user_fk FOREIGN KEY (user_id)
    REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT tenant_memberships_tenant_user_unique UNIQUE (tenant_id, user_id),
  CONSTRAINT tenant_memberships_binding_unique UNIQUE (tenant_id, id, user_id),
  CONSTRAINT tenant_memberships_role_check CHECK (role IN ('OWNER', 'ADMIN'))
);

CREATE TABLE tenant_auth_secrets (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  kind text NOT NULL,
  secret_hash text NOT NULL,
  hash_algorithm text NOT NULL,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  CONSTRAINT tenant_auth_secrets_pkey PRIMARY KEY (tenant_id, id),
  CONSTRAINT tenant_auth_secrets_tenant_fk FOREIGN KEY (tenant_id)
    REFERENCES tenants (id) ON DELETE CASCADE,
  CONSTRAINT tenant_auth_secrets_kind_version_unique UNIQUE (tenant_id, kind, version),
  CONSTRAINT tenant_auth_secrets_kind_check CHECK (kind IN ('ADMIN_PASSWORD', 'RECOVERY_CODE')),
  CONSTRAINT tenant_auth_secrets_hash_check CHECK (length(btrim(secret_hash)) > 0),
  CONSTRAINT tenant_auth_secrets_algorithm_check CHECK (length(btrim(hash_algorithm)) > 0),
  CONSTRAINT tenant_auth_secrets_version_check CHECK (version >= 1),
  CONSTRAINT tenant_auth_secrets_revocation_chronology_check
    CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);

CREATE TABLE tenant_sessions (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  membership_id uuid NOT NULL,
  user_id uuid NOT NULL,
  token_hash text NOT NULL,
  credential_version integer NOT NULL,
  session_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CONSTRAINT tenant_sessions_pkey PRIMARY KEY (tenant_id, id),
  CONSTRAINT tenant_sessions_tenant_fk FOREIGN KEY (tenant_id)
    REFERENCES tenants (id) ON DELETE CASCADE,
  CONSTRAINT tenant_sessions_membership_fk FOREIGN KEY (tenant_id, membership_id, user_id)
    REFERENCES tenant_memberships (tenant_id, id, user_id) ON DELETE CASCADE,
  CONSTRAINT tenant_sessions_token_hash_unique UNIQUE (token_hash),
  CONSTRAINT tenant_sessions_token_hash_check CHECK (length(btrim(token_hash)) > 0),
  CONSTRAINT tenant_sessions_credential_version_check CHECK (credential_version >= 1),
  CONSTRAINT tenant_sessions_session_version_check CHECK (session_version >= 1),
  CONSTRAINT tenant_sessions_expiry_check CHECK (expires_at > created_at),
  CONSTRAINT tenant_sessions_revocation_chronology_check
    CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);

CREATE TABLE tenant_settings (
  tenant_id uuid PRIMARY KEY,
  schema_version integer NOT NULL DEFAULT 1,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tenant_settings_tenant_fk FOREIGN KEY (tenant_id)
    REFERENCES tenants (id) ON DELETE CASCADE,
  CONSTRAINT tenant_settings_schema_version_check CHECK (schema_version >= 1),
  CONSTRAINT tenant_settings_object_check CHECK (jsonb_typeof(settings) = 'object')
);

CREATE TABLE tenant_setting_extras (
  tenant_id uuid NOT NULL,
  setting_key text NOT NULL,
  setting_value jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tenant_setting_extras_pkey PRIMARY KEY (tenant_id, setting_key),
  CONSTRAINT tenant_setting_extras_tenant_fk FOREIGN KEY (tenant_id)
    REFERENCES tenants (id) ON DELETE CASCADE,
  CONSTRAINT tenant_setting_extras_key_canonical_check
    CHECK (setting_key = btrim(setting_key) AND length(setting_key) > 0)
);

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenants_tenant_isolation ON tenants
  USING (id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE tenant_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_memberships FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_memberships_tenant_isolation ON tenant_memberships
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE tenant_auth_secrets ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_auth_secrets FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_auth_secrets_tenant_isolation ON tenant_auth_secrets
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE tenant_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_sessions_tenant_isolation ON tenant_sessions
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE tenant_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_settings_tenant_isolation ON tenant_settings
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE tenant_setting_extras ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_setting_extras FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_setting_extras_tenant_isolation ON tenant_setting_extras
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
