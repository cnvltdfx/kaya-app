-- Links a user to their Amazon Cognito identity. NULL for accounts from before Cognito, which can't sign in once it's on.
ALTER TABLE users ADD COLUMN cognito_sub VARCHAR(36) NULL UNIQUE AFTER id;
