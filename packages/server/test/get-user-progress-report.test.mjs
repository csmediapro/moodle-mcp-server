import assert from "node:assert/strict";
import test from "node:test";
import { plugin } from "../dist/plugins/get-user-progress-report/index.js";

// Mock client that returns predefined responses
class MockMoodleClient {
  constructor(responses = {}) {
    this.responses = responses;
  }

  async call({ wsfunction, params }) {
    const key = `${wsfunction}:${JSON.stringify(params)}`;
    if (this.responses[key]) {
      return this.responses[key];
    }
    
    // Default responses for common functions
    switch (wsfunction) {
      case "core_user_get_users_by_field":
        return [{
          id: 1,
          username: "testuser",
          firstname: "Test",
          lastname: "User",
          fullname: "Test User",
          email: "test@example.com"
        }];
      
      case "core_enrol_get_users_courses":
        return [{
          id: 101,
          fullname: "Test Course 1",
          shortname: "TC1"
        }, {
          id: 102,
          fullname: "Test Course 2",
          shortname: "TC2"
        }];
      
      case "gradereport_user_get_grade_items":
        return {
          usergrades: [{
            courseid: params.courseid,
            gradeitems: [{
              id: 1001,
              itemname: "Assignment 1",
              gradeformatted: "85.00"
            }]
          }]
        };
      
      case "core_completion_get_activities_completion_status":
        return {
          statuses: [{
            cmid: 1001,
            timecompleted: 1700000000
          }]
        };
      
      default:
        throw new Error(`Unexpected Moodle API call: ${wsfunction}`);
    }
  }
}

function baseCapabilities() {
  return {
    functions: new Set([
      "core_user_get_users_by_field",
      "core_enrol_get_users_courses",
      "gradereport_user_get_grade_items",
      "core_completion_get_activities_completion_status"
    ]),
    probedAt: new Date("2026-01-01T00:00:00.000Z")
  };
}

function createHandler(client, caps = baseCapabilities()) {
  return plugin.tools[0].createHandler({
    moodleClient: client,
    capabilities: caps,
    log: () => {},
    config: {
      serverName: "Test Server",
      serverVersion: "0.1.0",
    },
  });
}

test("get_user_progress_report is exported as a plugin tool", () => {
  assert.equal(plugin.manifest.id, "get-user-progress-report");
  assert.deepEqual(plugin.manifest.tools, ["get_user_progress_report"]);
  assert.equal(plugin.tools[0].name, "get_user_progress_report");
});

test("get_user_progress_report returns correct structure", async () => {
  const client = new MockMoodleClient();
  const caps = baseCapabilities();
  const handler = createHandler(client, caps);
  
  const result = await handler({ userid: 1 });
  
  // Check that result is successful
  assert.equal(result.ok, true);
  
  // Check meta
  assert.equal(result.meta.tool, "get_user_progress_report");
  assert.equal(result.meta.entity, "user");
  assert.equal(result.meta.entityId, 1);
  
  // Check data structure
  assert.equal(result.data.kind, "table");
  assert.ok(Array.isArray(result.data.columns));
  assert.ok(Array.isArray(result.data.rows));
  
  // Check context
  assert.ok(typeof result.context.summary === "string");
  assert.ok(result.context.metrics);
  assert.ok(Array.isArray(result.context.suggestedQueries));
});

test("get_user_progress_report handles missing user", async () => {
  const client = new MockMoodleClient({
    "core_user_get_users_by_field:{\"field\":\"id\",\"values[0]\":\"999\"}": []
  });
  const caps = baseCapabilities();
  const handler = createHandler(client, caps);
  
  const result = await handler({ userid: 999 });
  
  // Check that result is an error
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "user_not_found");
});

test("get_user_progress_report handles missing capabilities", async () => {
  const client = new MockMoodleClient();
  const caps = {
    functions: new Set(["core_user_get_users_by_field"]),
    probedAt: new Date("2026-01-01T00:00:00.000Z")
  };
  const handler = createHandler(client, caps);
  
  const result = await handler({ userid: 1 });
  
  // Check that result is an error
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "progress_report_capability_missing");
});

test("get_user_progress_report sanitizes HTML grades", async () => {
  const client = new MockMoodleClient({
    "gradereport_user_get_grade_items:{\"userid\":1,\"courseid\":101}": {
      usergrades: [{
        courseid: 101,
        gradeitems: [{
          id: 1001,
          itemname: "Assignment 1",
          gradeformatted: "<i>Grade:</i> 85.00"
        }]
      }]
    }
  });
  
  const caps = baseCapabilities();
  const handler = createHandler(client, caps);
  
  const result = await handler({ userid: 1 });
  
  // Check that the grade was sanitized
  assert.equal(result.ok, true);
  assert.equal(result.data.rows[0].final_grade, "Grade: 85.00");
});

test("get_user_progress_report calculates completion percentage", async () => {
  const client = new MockMoodleClient({
    "core_completion_get_activities_completion_status:{\"userid\":1,\"courseid\":101}": {
      statuses: [{
        cmid: 1001,
        timecompleted: 1700000000,
        hascompletion: 1
      }, {
        cmid: 1002,
        timecompleted: 0,
        hascompletion: 1
      }]
    },
    "gradereport_user_get_grade_items:{\"userid\":1,\"courseid\":101}": {
      usergrades: [{
        courseid: 101,
        gradeitems: [{
          id: 1001,
          itemname: "Assignment 1",
          gradeformatted: "85.00",
          cmid: 1001
        }, {
          id: 1002,
          itemname: "Assignment 2",
          gradeformatted: "90.00",
          cmid: 1002
        }]
      }]
    }
  });
  
  const caps = baseCapabilities();
  const handler = createHandler(client, caps);
  
  const result = await handler({ userid: 1 });
  
  // Check that completion percentage was calculated
  assert.equal(result.ok, true);
  assert.equal(result.data.rows[0].course_completed_pct, 50); // 1 out of 2 completed
});

test("get_user_progress_report handles API errors gracefully", async () => {
  class ErrorMockMoodleClient {
    async call({ wsfunction }) {
      if (wsfunction === "core_user_get_users_by_field") {
        return [{
          id: 1,
          username: "testuser",
          firstname: "Test",
          lastname: "User",
          fullname: "Test User"
        }];
      }
      
      if (wsfunction === "gradereport_user_get_grade_items") {
        throw new Error("Moodle API error");
      }
      
      // Fall back to default responses
      switch (wsfunction) {
        case "core_enrol_get_users_courses":
          return [{
            id: 101,
            fullname: "Test Course 1",
            shortname: "TC1"
          }];
        
        case "core_completion_get_activities_completion_status":
          return { statuses: [] };
        
        default:
          throw new Error(`Unexpected Moodle API call: ${wsfunction}`);
      }
    }
  }
  
  const client = new ErrorMockMoodleClient();
  const caps = baseCapabilities();
  const handler = createHandler(client, caps);
  
  const result = await handler({ userid: 1 });
  
  // Should still return a successful response with warnings
  assert.equal(result.ok, true);
  assert.ok(result.context.warnings && result.context.warnings.length > 0);
});
