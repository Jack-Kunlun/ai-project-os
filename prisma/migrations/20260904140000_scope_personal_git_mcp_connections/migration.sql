-- Git and MCP names are private to a confirmed owner. PostgreSQL's nullable
-- first key column allows multiple unresolved legacy rows (ownerUserId NULL)
-- while enforcing uniqueness for every confirmed owner.
DROP INDEX "GitConnection_name_key";
DROP INDEX "McpConnection_name_key";

CREATE UNIQUE INDEX "GitConnection_ownerUserId_name_key"
  ON "GitConnection" ("ownerUserId", "name");

CREATE UNIQUE INDEX "McpConnection_ownerUserId_name_key"
  ON "McpConnection" ("ownerUserId", "name");
