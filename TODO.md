# TODO List - Moodle MCP Server

## High Priority

### 1. Cache Encryption 🔒
- **Description**: Implement AES-256-GCM encryption for cache files at rest
- **Approach**: Password-derived encryption using PBKDF2 with key from `CACHE_ENCRYPTION_KEY` environment variable
- **Status**: Not started
- **Priority**: Medium-term (not urgent but will be asked for soon)
- **Rationale**: Organizations will be concerned about leaving course/category data on disk, even though it's not PII

## Medium Priority

### 2. Compound Tool-Call Result Rendering 📊
- **Description**: Investigate and improve how compound tool-call results are rendered
- **Reference**: `protrain-moodle-mcp-server-021` todo item
- **Status**: Not started

### 3. Transition Premium Tools to Plugin Architecture 🌐
- **Description**: Move `get_course_completion_report` and `get_user_progress_report` tools out of open source core and implement as premium plugins via mcp-agent-edge
- **Status**: Not started
- **Priority**: High (business requirement)
- **Rationale**: These are the real money tools that operators need to subscribe to. We can't just give away all our tools.

## Completed ✅

### Cache Management System
- Replaced misleading IndexedDB comments with real file-backed cache
- Fixed `refreshCache()` to actually force-fetch from Moodle
- Enhanced `clearCache()` to clear both memory and disk files
- Added comprehensive tests for all cache scenarios
- Added `get_cache_status` read-only tool for cache inspection
- Removed file paths from public cache status API for security
- Fixed logging to use proper structured logger instead of console.log

### Moodle User Field Schema Tools
- Added tools for retrieving user field schemas
- Status: Completed and pushed to `main`