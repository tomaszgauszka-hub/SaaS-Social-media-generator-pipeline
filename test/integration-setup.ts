import { resetEnvCache } from "@cre/config";
import { testDatabaseUrl } from "@cre/db/testing";

// Runs in every integration test worker before the test file: point all code at the test database.
process.env.DATABASE_URL = testDatabaseUrl();
process.env.MOCK_AI = "true";
process.env.MOCK_MEDIA = "true";
process.env.MOCK_SOCIAL = "true";
process.env.PUBLISHING_ENABLED = "false";
process.env.LOG_LEVEL = process.env.LOG_LEVEL_TEST ?? "silent";
resetEnvCache();
