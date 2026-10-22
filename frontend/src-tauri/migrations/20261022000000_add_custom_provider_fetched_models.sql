-- Every model a custom server listed on its last fetch; `models` stays the checked subset offered elsewhere.
ALTER TABLE custom_providers ADD COLUMN fetched_models TEXT NOT NULL DEFAULT '[]';
