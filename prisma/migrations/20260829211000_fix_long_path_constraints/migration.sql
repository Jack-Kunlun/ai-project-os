-- PostgreSQL's regular-expression engine rejects repetition bounds above 255
-- when the constraint is evaluated. Keep the character whitelist in the regex
-- and enforce the maximum length separately.
ALTER TABLE "Notification"
  DROP CONSTRAINT "Notification_action_href_check",
  ADD CONSTRAINT "Notification_action_href_check" CHECK (
    "actionHref" IS NULL
    OR (
      char_length("actionHref") BETWEEN 1 AND 1024
      AND "actionHref" ~ '^/[A-Za-z0-9/_?=&.-]*$'
    )
  );

ALTER TABLE "OidcLoginAttempt"
  DROP CONSTRAINT "OidcLoginAttempt_return_to_check",
  ADD CONSTRAINT "OidcLoginAttempt_return_to_check" CHECK (
    char_length("returnTo") BETWEEN 1 AND 1024
    AND "returnTo" ~ '^/[A-Za-z0-9/_?=&.-]*$'
  );
