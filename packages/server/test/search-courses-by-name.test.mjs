import assert from "node:assert/strict";
import test from "node:test";
import { searchCoursesByName } from "../dist/tools/search-courses-by-name.js";

test("searchCoursesByName returns correct matches", () => {
  const courses = [{
    id: 101,
    fullname: "Investing in Stocks and Bonds",
    shortname: "STOCKS101",
    categoryid: 1,
    visible: 1
  }, {
    id: 102,
    fullname: "Advanced Stock Trading",
    shortname: "STOCKS201",
    categoryid: 1,
    visible: 1
  }, {
    id: 103,
    fullname: "Bond Market Fundamentals",
    shortname: "BONDS101",
    categoryid: 1,
    visible: 1
  }];
  
  const categories = [{
    id: 1,
    name: "Test Category",
    description: "Test category description",
    parent: 0,
    depth: 1,
    path: "Test Category"
  }];
  
  // Test exact match
  const exactMatches = searchCoursesByName(courses, categories, "Investing in Stocks and Bonds", 10);
  assert.equal(exactMatches.length, 1);
  assert.equal(exactMatches[0].id, 101);
  
  // Test partial match
  const partialMatches = searchCoursesByName(courses, categories, "stocks", 10);
  assert.ok(partialMatches.length >= 2); // Should find at least 2 courses with "stocks"
  
  // Test case insensitive match
  const caseMatches = searchCoursesByName(courses, categories, "STOCKS", 10);
  assert.ok(caseMatches.length >= 2); // Should find courses with "stocks" regardless of case
  
  // Test limit
  const limitedMatches = searchCoursesByName(courses, categories, "stock", 1);
  assert.equal(limitedMatches.length, 1);
  
  // Test no matches
  const noMatches = searchCoursesByName(courses, categories, "nonexistent", 10);
  assert.equal(noMatches.length, 0);
});