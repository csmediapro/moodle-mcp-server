import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { plugin } from '../dist/plugins/user-directory/index.js';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

// Mock Moodle client
const mockMoodleClient = {
  getBaseUrl: () => 'https://test.moodle.com',
  call: async (call) => {
    if (call.wsfunction === 'core_user_get_users') {
      // Return mock user data
      return {
        users: [
          {
            id: 1,
            username: 'user1',
            email: 'user1@example.com',
            fullname: 'User One',
            firstname: 'User',
            lastname: 'One',
            suspended: false,
            confirmed: true,
            auth: 'manual',
            department: 'IT',
            institution: 'Test Org',
            customfields: [
              { shortname: 'school', value: 'Test School' },
              { shortname: 'role', value: 'student' }
            ]
          },
          {
            id: 2,
            username: 'user2',
            email: 'user2@example.com',
            fullname: 'User Two',
            firstname: 'User',
            lastname: 'Two',
            suspended: true,
            confirmed: true,
            auth: 'manual',
            department: 'HR',
            institution: 'Test Org',
            customfields: [
              { shortname: 'school', value: 'Test School' },
              { shortname: 'role', value: 'admin' }
            ]
          },
          {
            id: 3,
            username: 'user3',
            email: 'user3@example.com',
            fullname: 'User Three',
            firstname: 'User',
            lastname: 'Three',
            suspended: false,
            confirmed: true,
            auth: 'manual',
            department: 'Finance',
            institution: 'Test Org',
            customfields: [
              { shortname: 'school', value: 'Different School' },
              { shortname: 'role', value: 'student' }
            ]
          }
        ]
      };
    }
    throw new Error(`Unexpected function call: ${call.wsfunction}`);
  }
};

// Test context
const testContext = {
  moodleClient: mockMoodleClient,
  capabilities: {
    functions: new Set(['core_user_get_users']),
    probedAt: new Date('2026-01-01T00:00:00.000Z'),
  },
  log: () => {},
  config: {
    serverName: 'Test Server',
    serverVersion: '1.0.0'
  }
};

let cacheDir;
let cachePath;
let schemaPath;

// Clean up cache before and after tests
beforeEach(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), 'moodle-user-directory-test-'));
  cachePath = join(cacheDir, 'user-directory.json');
  schemaPath = join(cacheDir, 'user-field-schema.json');
  process.env.MOODLE_CACHE_DIR = cacheDir;
  process.env.MOODLE_USER_FIELD_SCHEMA_PATH = schemaPath;
});

afterEach(async () => {
  delete process.env.MOODLE_CACHE_DIR;
  delete process.env.MOODLE_USER_FIELD_SCHEMA_PATH;
  await rm(cacheDir, { recursive: true, force: true });
});

test('user-directory plugin loads correctly', async () => {
  assert.ok(plugin);
  assert.strictEqual(plugin.manifest.id, 'user-directory');
  assert.deepStrictEqual(plugin.manifest.tools, ['list_users', 'summarize_user_directory_field']);
  assert.ok(plugin.tools);
  assert.ok(plugin.tools.length >= 2);
  assert.ok(plugin.tools[0].createHandler);
  assert.ok(plugin.tools.find((tool) => tool.name === 'summarize_user_directory_field'));
});

test('user-directory agent hints route common school summary prompts', async () => {
  const uniqueRoute = plugin.agent.intentRoutes.find((route) => route.id === 'user-directory-unique-schools');
  const countRoute = plugin.agent.intentRoutes.find((route) => route.id === 'user-directory-school-counts');
  const missingSchoolRoute = plugin.agent.intentRoutes.find((route) => route.id === 'user-directory-users-missing-school');

  assert.ok(uniqueRoute);
  assert.ok(countRoute);
  assert.ok(missingSchoolRoute);
  assert.match('show me all uniques schools from the user cache', new RegExp(uniqueRoute.match, uniqueRoute.flags));
  assert.match('show me unique schools and number of users assigned to each one', new RegExp(countRoute.match, countRoute.flags));
  assert.match('list users with a school value that is empty', new RegExp(missingSchoolRoute.match, missingSchoolRoute.flags));
  assert.deepStrictEqual(missingSchoolRoute.args.emptyFields, ['school']);
  assert.ok(plugin.agent.promptRules.some((rule) => rule.includes('count_desc')));
  assert.ok(plugin.agent.promptRules.some((rule) => rule.includes('summarize_user_directory_field')));
  assert.ok(plugin.agent.promptRules.some((rule) => rule.includes('emptyFields')));
});

test('list_users returns confirmation when cache is missing', async () => {
  const handler = plugin.tools[0].createHandler(testContext);
  const result = await handler({
    filters: { school: 'Test School' }
  });

  // Should return confirmation response
  assert.strictEqual(result.data.kind, 'none');
  assert.ok(result.interactions);
  assert.ok(result.interactions.actions.some(action => action.label === 'Confirm'));
});

test('list_users fetches full directory and filters in memory when confirmed', async () => {
  const handler = plugin.tools[0].createHandler(testContext);
  const result = await handler({
    filters: { school: 'Test School' },
    confirmed: true
  });

  // Should return actual user data
  assert.strictEqual(result.data.kind, 'table');
  assert.ok(Array.isArray(result.data.rows));
  // Should have 2 users matching the filter (both from Test School)
  assert.strictEqual(result.data.rows.length, 2);

  // Check that cache was created
  const cacheExists = await access(cachePath).then(() => true).catch(() => false);
  assert.ok(cacheExists);

  // Cache stores full directory (all 3 users), not filtered subset
  const cacheData = await readFile(cachePath, 'utf8');
  const cache = JSON.parse(cacheData);
  assert.strictEqual(cache.users.length, 3);
  assert.strictEqual(cache.rawUserCount, 3);
  // Cache must not have filters field (full-directory model)
  assert.strictEqual(cache.filters, undefined);
});

test('list_users applies _silo through the cached directory filter pipeline', async () => {
  const handler = plugin.tools[0].createHandler(testContext);
  const result = await handler({
    _silo: { field: 'school', value: 'Test School' },
    confirmed: true
  });

  assert.strictEqual(result.data.kind, 'table');
  assert.strictEqual(result.data.rows.length, 2);
  assert.deepStrictEqual(
    result.data.rows.map((row) => row.id),
    [1, 2]
  );

  const cacheData = await readFile(cachePath, 'utf8');
  const cache = JSON.parse(cacheData);
  assert.strictEqual(cache.users.length, 3);
  assert.strictEqual(cache.filters, undefined);
});

test('list_users respects active user field schema display columns', async () => {
  await mkdir(dirname(schemaPath), { recursive: true });
  await writeFile(schemaPath, JSON.stringify({
    schemaVersion: 7,
    generatedAt: '2026-06-06T00:00:00.000Z',
    siteUrl: 'https://test.moodle.com',
    moodleVersion: '4.4',
    userFields: {
      id: {
        name: 'User ID',
        type: 'number',
        source: 'standard',
        display: true,
        filterable: true,
        displayOrder: 10,
      },
      fullname: {
        name: 'Full Name',
        type: 'string',
        source: 'standard',
        display: true,
        filterable: false,
        displayOrder: 20,
      },
      email: {
        name: 'Email',
        type: 'string',
        source: 'standard',
        display: true,
        filterable: true,
        displayOrder: 30,
      },
      school: {
        name: 'School',
        type: 'string',
        source: 'custom',
        display: true,
        filterable: true,
        displayOrder: 40,
      },
      username: {
        name: 'Username',
        type: 'string',
        source: 'standard',
        display: false,
        filterable: true,
      },
      firstname: {
        name: 'First Name',
        type: 'string',
        source: 'standard',
        display: false,
        filterable: true,
      },
      suspended: {
        name: 'Suspended',
        type: 'boolean',
        source: 'standard',
        display: false,
        filterable: true,
      },
    },
  }, null, 2));

  const handler = plugin.tools[0].createHandler(testContext);
  const result = await handler({
    filters: { school: 'Test School' },
    confirmed: true
  });

  assert.deepStrictEqual(result.data.columns, [
    { key: 'id', label: 'User ID' },
    { key: 'fullname', label: 'Full Name' },
    { key: 'email', label: 'Email' },
    { key: 'school', label: 'School' },
  ]);
  assert.deepStrictEqual(Object.keys(result.data.rows[0]), ['id', 'fullname', 'email', 'school']);
  assert.strictEqual(result.data.rows[0].school, 'Test School');
  assert.strictEqual(result.context.metrics.schemaUsed, true);
  assert.strictEqual(result.context.metrics.schemaVersion, 7);
});

test('list_users hits cache with same filters', async () => {
  // Build full-directory cache
  const handler = plugin.tools[0].createHandler(testContext);
  await handler({
    filters: { school: 'Test School' },
    confirmed: true
  });

  // Now call again without confirmed — should use cache and filter in memory
  const result = await handler({
    filters: { school: 'Test School' }
  });

  assert.strictEqual(result.data.kind, 'table');
  assert.ok(Array.isArray(result.data.rows));
  assert.strictEqual(result.data.rows.length, 2);
});

test('list_users uses cache with different filters (full-directory model)', async () => {
  // Build full-directory cache
  const handler = plugin.tools[0].createHandler(testContext);
  await handler({
    filters: {},
    confirmed: true
  });

  // Now call with different filters — should still hit cache
  const result = await handler({
    filters: { school: 'Different School' }
  });

  // Should return filtered results from cache, not confirmation
  assert.strictEqual(result.data.kind, 'table');
  assert.strictEqual(result.data.rows.length, 1);
  assert.strictEqual(result.data.rows[0].id, 3);
});

test('list_users returns all users from cache with empty filters', async () => {
  const handler = plugin.tools[0].createHandler(testContext);
  await handler({
    filters: {},
    confirmed: true
  });

  const result = await handler({
    filters: {}
  });

  assert.strictEqual(result.data.kind, 'table');
  assert.strictEqual(result.data.rows.length, 3);
  assert.strictEqual(result.context.metrics.totalUsers, 3);
});

test('list_users treats matching filters as cache hits regardless of key order', async () => {
  const handler = plugin.tools[0].createHandler(testContext);
  await handler({
    filters: { school: 'Test School', role: 'student' },
    confirmed: true
  });

  const result = await handler({
    filters: { role: 'student', school: 'Test School' }
  });

  assert.strictEqual(result.data.kind, 'table');
  assert.strictEqual(result.data.rows.length, 1);
  assert.equal(result.interactions, undefined);
});

test('list_users preserves refresh flag in confirmation action', async () => {
  const handler = plugin.tools[0].createHandler(testContext);
  await handler({
    filters: { school: 'Test School' },
    confirmed: true
  });

  const result = await handler({
    filters: { school: 'Test School' },
    refresh: true
  });

  const confirmAction = result.interactions.actions.find((action) => action.label === 'Confirm');
  assert.strictEqual(result.data.kind, 'none');
  assert.strictEqual(confirmAction.args.refresh, true);
  assert.strictEqual(confirmAction.args.confirmed, true);
});

test('list_users paginates cached results', async () => {
  const handler = plugin.tools[0].createHandler(testContext);
  await handler({
    filters: { school: 'Test School' },
    confirmed: true
  });

  const result = await handler({
    filters: { school: 'Test School' },
    limit: 1,
    offset: 1
  });

  assert.strictEqual(result.data.kind, 'table');
  assert.strictEqual(result.data.rows.length, 1);
  assert.strictEqual(result.data.rows[0].id, 2);
  assert.strictEqual(result.context.metrics.totalUsers, 2);
  assert.strictEqual(result.context.metrics.displayedUsers, 1);
  assert.strictEqual(result.context.metrics.hasMore, false);
});

test('list_users ignores filters.confirmed (control key stripped)', async () => {
  const handler = plugin.tools[0].createHandler(testContext);
  await handler({
    filters: {},
    confirmed: true
  });

  // Model accidentally puts "confirmed" inside filters
  const result = await handler({
    filters: { school: 'Test School', confirmed: true }
  });

  // "confirmed" should be stripped from actual filters; still hits cache
  assert.strictEqual(result.data.kind, 'table');
  assert.strictEqual(result.data.rows.length, 2);
});

test('list_users normalizes School alias to school', async () => {
  const handler = plugin.tools[0].createHandler(testContext);
  await handler({
    filters: {},
    confirmed: true
  });

  // Model uses "School" (capital S) instead of "school"
  const result = await handler({
    filters: { School: 'Test School' }
  });

  assert.strictEqual(result.data.kind, 'table');
  assert.strictEqual(result.data.rows.length, 2);
  // School alias normalized correctly: users 1 and 2 both have school=Test School
  assert.strictEqual(result.data.rows[0].id, 1);
});

test('list_users applies case-insensitive filter matching', async () => {
  const handler = plugin.tools[0].createHandler(testContext);
  await handler({
    filters: {},
    confirmed: true
  });

  const result = await handler({
    filters: { school: 'test school' }
  });

  assert.strictEqual(result.data.kind, 'table');
  assert.strictEqual(result.data.rows.length, 2);
});

test('list_users filters users with empty field values', async () => {
  await mkdir(dirname(cachePath), { recursive: true });
  await writeFile(cachePath, JSON.stringify({
    version: 1,
    moodleUrl: 'https://test.moodle.com',
    generatedAt: '2026-06-08T00:00:00.000Z',
    rawUserCount: 5,
    users: [
      { id: 1, username: 'user1', fullname: 'User One', email: 'user1@example.com', school: 'Test School' },
      { id: 2, username: 'user2', fullname: 'User Two', email: 'user2@example.com', school: '' },
      { id: 3, username: 'user3', fullname: 'User Three', email: 'user3@example.com' },
      { id: 4, username: 'user4', fullname: 'User Four', email: 'user4@example.com', school: null },
      { id: 5, username: 'user5', fullname: 'User Five', email: 'user5@example.com', school: '   ' },
    ],
  }, null, 2));

  const handler = plugin.tools[0].createHandler(testContext);
  const result = await handler({
    emptyFields: ['school']
  });

  assert.strictEqual(result.data.kind, 'table');
  assert.deepStrictEqual(result.data.rows.map((row) => row.id), [2, 3, 4, 5]);
  assert.strictEqual(result.context.metrics.totalUsers, 4);
  assert.strictEqual(result.context.metrics.emptyFieldsApplied, 1);
  assert.strictEqual(result.context.metrics.emptyFields, 'school');
});

test('list_users accepts a single emptyFields string', async () => {
  await mkdir(dirname(cachePath), { recursive: true });
  await writeFile(cachePath, JSON.stringify({
    version: 1,
    moodleUrl: 'https://test.moodle.com',
    generatedAt: '2026-06-08T00:00:00.000Z',
    rawUserCount: 3,
    users: [
      { id: 1, username: 'user1', fullname: 'User One', email: 'user1@example.com', school: 'Test School' },
      { id: 2, username: 'user2', fullname: 'User Two', email: 'user2@example.com', school: '' },
      { id: 3, username: 'user3', fullname: 'User Three', email: 'user3@example.com' },
    ],
  }, null, 2));

  const handler = plugin.tools[0].createHandler(testContext);
  const result = await handler({
    emptyFields: 'school'
  });

  assert.strictEqual(result.data.kind, 'table');
  assert.deepStrictEqual(result.data.rows.map((row) => row.id), [2, 3]);
  assert.strictEqual(result.context.metrics.emptyFieldsApplied, 1);
  assert.strictEqual(result.context.metrics.emptyFields, 'school');
});

test('list_users normalizes null and blank filters into empty field filters', async () => {
  await mkdir(dirname(cachePath), { recursive: true });
  await writeFile(cachePath, JSON.stringify({
    version: 1,
    moodleUrl: 'https://test.moodle.com',
    generatedAt: '2026-06-08T00:00:00.000Z',
    rawUserCount: 4,
    users: [
      { id: 1, username: 'user1', fullname: 'User One', email: 'user1@example.com', school: 'Test School' },
      { id: 2, username: 'user2', fullname: 'User Two', email: 'user2@example.com', school: '' },
      { id: 3, username: 'user3', fullname: 'User Three', email: 'user3@example.com' },
      { id: 4, username: 'user4', fullname: 'User Four', email: 'user4@example.com', school: null },
    ],
  }, null, 2));

  const handler = plugin.tools[0].createHandler(testContext);

  const nullResult = await handler({
    filters: { school: null }
  });

  assert.deepStrictEqual(nullResult.data.rows.map((row) => row.id), [2, 3, 4]);
  assert.strictEqual(nullResult.context.metrics.filtersApplied, 0);
  assert.strictEqual(nullResult.context.metrics.emptyFields, 'school');

  const blankResult = await handler({
    filters: { school: '' }
  });

  assert.deepStrictEqual(blankResult.data.rows.map((row) => row.id), [2, 3, 4]);
  assert.strictEqual(blankResult.context.metrics.filtersApplied, 0);
  assert.strictEqual(blankResult.context.metrics.emptyFields, 'school');
});

test('list_users returns confirmation when cache URL mismatches', async () => {
  const handler = plugin.tools[0].createHandler(testContext);
  await handler({
    filters: {},
    confirmed: true
  });

  // Corrupt the cache URL to simulate different Moodle instance
  const cacheData = await readFile(cachePath, 'utf8');
  const cache = JSON.parse(cacheData);
  cache.moodleUrl = 'https://other.moodle.com';
  await writeFile(cachePath, JSON.stringify(cache, null, 2));

  const result = await handler({
    filters: { school: 'Test School' }
  });

  // Should ask for confirmation on new URL
  assert.strictEqual(result.data.kind, 'none');
});

test('summarize_user_directory_field returns unique schools and counts from cache', async () => {
  const listHandler = plugin.tools.find((tool) => tool.name === 'list_users').createHandler(testContext);
  const summaryHandler = plugin.tools.find((tool) => tool.name === 'summarize_user_directory_field').createHandler(testContext);

  await listHandler({
    filters: {},
    confirmed: true
  });

  const result = await summaryHandler({
    field: 'school',
    sort: 'count_desc'
  });

  assert.strictEqual(result.data.kind, 'table');
  assert.deepStrictEqual(result.data.columns, [
    { key: 'value', label: 'School' },
    { key: 'userCount', label: 'Users' },
    { key: 'percentOfUsers', label: '% of Users' },
  ]);
  assert.strictEqual(result.data.rows.length, 2);
  assert.deepStrictEqual(result.data.rows.map((row) => [row.value, row.userCount]), [
    ['Test School', 2],
    ['Different School', 1],
  ]);
  assert.strictEqual(result.context.metrics.uniqueValueCount, 2);
  assert.strictEqual(result.context.metrics.usersSummarized, 3);
});

test('summarize_user_directory_field accepts model-friendly sort aliases', async () => {
  const listHandler = plugin.tools.find((tool) => tool.name === 'list_users').createHandler(testContext);
  const summaryHandler = plugin.tools.find((tool) => tool.name === 'summarize_user_directory_field').createHandler(testContext);

  await listHandler({
    filters: {},
    confirmed: true
  });

  const countAliasResult = await summaryHandler({
    field: 'school',
    sort: 'count'
  });

  assert.deepStrictEqual(countAliasResult.data.rows.map((row) => [row.value, row.userCount]), [
    ['Test School', 2],
    ['Different School', 1],
  ]);

  const valueAliasResult = await summaryHandler({
    field: 'school',
    sort: 'value'
  });

  assert.deepStrictEqual(valueAliasResult.data.rows.map((row) => [row.value, row.userCount]), [
    ['Different School', 1],
    ['Test School', 2],
  ]);
});

test('summarize_user_directory_field applies filters before grouping', async () => {
  const listHandler = plugin.tools.find((tool) => tool.name === 'list_users').createHandler(testContext);
  const summaryHandler = plugin.tools.find((tool) => tool.name === 'summarize_user_directory_field').createHandler(testContext);

  await listHandler({
    filters: {},
    confirmed: true
  });

  const result = await summaryHandler({
    field: 'school',
    filters: { role: 'student' },
    sort: 'value_asc'
  });

  assert.strictEqual(result.data.rows.length, 2);
  assert.deepStrictEqual(result.data.rows.map((row) => [row.value, row.userCount]), [
    ['Different School', 1],
    ['Test School', 1],
  ]);
  assert.strictEqual(result.context.metrics.filtersApplied, 1);
  assert.strictEqual(result.context.metrics.usersSummarized, 2);
});

test('summarize_user_directory_field can include empty values', async () => {
  await mkdir(dirname(cachePath), { recursive: true });
  await writeFile(cachePath, JSON.stringify({
    version: 1,
    moodleUrl: 'https://test.moodle.com',
    generatedAt: '2026-06-08T00:00:00.000Z',
    rawUserCount: 3,
    users: [
      { id: 1, school: 'Test School' },
      { id: 2, school: '' },
      { id: 3 },
    ],
  }, null, 2));

  const summaryHandler = plugin.tools.find((tool) => tool.name === 'summarize_user_directory_field').createHandler(testContext);

  const result = await summaryHandler({
    field: 'school',
    includeEmpty: true,
    sort: 'count_desc'
  });

  assert.deepStrictEqual(result.data.rows.map((row) => [row.value, row.userCount]), [
    ['(empty)', 2],
    ['Test School', 1],
  ]);
  assert.strictEqual(result.context.metrics.emptyValueCount, 2);
});

test('summarize_user_directory_field asks to build cache when cache is missing', async () => {
  const summaryHandler = plugin.tools.find((tool) => tool.name === 'summarize_user_directory_field').createHandler(testContext);

  const result = await summaryHandler({
    field: 'school'
  });

  assert.strictEqual(result.data.kind, 'none');
  assert.strictEqual(result.context.metrics.cacheStatus, 'missing');
  assert.ok(result.interactions.actions.some((action) => action.tool === 'list_users'));
});
