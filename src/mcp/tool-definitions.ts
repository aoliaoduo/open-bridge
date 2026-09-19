const PROCESS_OUTPUT_SCHEMA = {
  type: "object",
  description: "One page of captured process output. next_offset continues after this page; offsets are per stream.",
  required: ["command_id", "stream", "output", "offset", "next_offset", "status", "exit_code", "output_bytes", "output_available_bytes", "dropped_bytes", "truncated"],
  properties: {
    command_id: { type: "string" },
    stream: { type: "string", enum: ["merged", "stdout", "stderr"] },
    output: { type: "string" },
    offset: { type: "number", description: "The actual offset read; it may advance when earlier buffered bytes were dropped." },
    next_offset: { type: "number", description: "Pass as offset to continue this stream." },
    status: { type: "string", enum: ["running", "completed"] },
    exit_code: { type: ["number", "null"] },
    termination_reason: { type: "string" },
    output_bytes: { type: "number", description: "Total bytes ever captured on this stream." },
    output_available_bytes: { type: "number", description: "Bytes currently retained and available to read." },
    dropped_bytes: { type: "number", description: "Earlier bytes no longer retained in the bounded buffer." },
    truncated: { type: "boolean", description: "True when this page omits stream bytes before or after it; compare next_offset with output_bytes to find newer unread bytes." },
  },
} as const;

const SUPERVISED_PROCESS_LAUNCH_OUTPUT_SCHEMA = {
  type: "object", description: "A background command or supervised process launch.",
  required: ["command_id", "shell", "cwd", "status", "ready", "ready_checked", "restart_count", "output", "stdout", "stderr", "output_bytes", "dropped_bytes", "truncated"],
  properties: {
    command_id: { type: "string" }, shell: { type: "string" }, cwd: { type: "string" }, status: { type: "string", enum: ["running", "completed"] },
    ready: { type: "boolean" }, ready_checked: { type: "boolean" }, restart_count: { type: "number" },
    output: { type: "string" }, stdout: { type: "string" }, stderr: { type: "string" }, output_bytes: { type: "number" },
    dropped_bytes: { type: "number" }, truncated: { type: "boolean" },
  },
} as const;

const RUN_COMMAND_OUTPUT_SCHEMA = {
  oneOf: [
    SUPERVISED_PROCESS_LAUNCH_OUTPUT_SCHEMA,
    {
      type: "object", description: "A foreground command that exited before its timeout.",
      required: ["command_id", "output", "stdout", "stderr", "output_bytes", "dropped_bytes", "truncated", "exit_code", "timed_out", "status"],
      properties: {
        command_id: { type: "string" }, output: { type: "string" }, stdout: { type: "string" }, stderr: { type: "string" },
        output_bytes: { type: "number" }, dropped_bytes: { type: "number" }, truncated: { type: "boolean" },
        exit_code: { type: ["number", "null"] }, timed_out: { type: "boolean" }, status: { type: "string", enum: ["running", "completed"] },
      },
    },
    {
      type: "object", description: "A foreground command that outlived timeout_ms and remains supervised.",
      required: ["command_id", "shell", "cwd", "status", "ready", "timed_out", "message", "output", "stdout", "stderr", "output_bytes", "dropped_bytes", "truncated", "restart_count"],
      properties: {
        command_id: { type: "string" }, shell: { type: "string" }, cwd: { type: "string" }, status: { type: "string", enum: ["running"] },
        ready: { type: "boolean" }, timed_out: { type: "boolean" }, message: { type: "string" }, restart_count: { type: "number" },
        output: { type: "string" }, stdout: { type: "string" }, stderr: { type: "string" }, output_bytes: { type: "number" },
        dropped_bytes: { type: "number" }, truncated: { type: "boolean" },
      },
    },
  ],
} as const;

const ARRAY_RESULT_SCHEMA = (items: Record<string, unknown>, description: string) => ({
  type: "object",
  description,
  required: ["items"],
  properties: { items: { type: "array", items } },
}) as const;

const READ_FILE_ROW_SCHEMA = {
  type: "object",
  required: ["path"],
  properties: {
    path: { type: "string" }, content: { type: "string" }, sha256: { type: ["string", "null"] },
    truncated: { type: "boolean" }, bytes_returned: { type: "number" }, bytes_total: { type: "number" },
    error: { type: "string" },
  },
} as const;

const SERVICE_STATUS_ROW_SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string" }, group: { type: "string" }, status: { type: "string" },
    command_id: { type: ["string", "null"] }, healthy: { type: "boolean" },
  },
} as const;

const ACTIVITY_ROW_SCHEMA = {
  type: "object",
  required: ["at", "tool", "status"],
  properties: {
    at: { type: "string", description: "ISO-8601 UTC." }, ts: { type: "number" },
    tool: { type: "string" }, status: { type: "string" }, message: { type: "string" },
    args_summary: { type: "string" },
  },
} as const;

const ACTIVITY_LOG_OUTPUT_SCHEMA = {
  oneOf: [
    ARRAY_RESULT_SCHEMA(ACTIVITY_ROW_SCHEMA, "recent returns activity rows in items."),
    {
      type: "object", description: "search returns its paged audit-log summary.",
      required: ["entries", "total_scanned", "truncated", "next_offset"],
      properties: {
        entries: { type: "array", items: ACTIVITY_ROW_SCHEMA }, total_scanned: { type: "number" },
        truncated: { type: "boolean" }, next_offset: { type: ["number", "null"] },
      },
    },
    {
      type: "object", description: "clear reports which in-memory and on-disk data was removed.",
      required: ["cleared_memory_entries", "live_truncated", "rotated_removed"],
      properties: {
        cleared_memory_entries: { type: "number" }, live_truncated: { type: "boolean" },
        rotated_removed: { type: "boolean" },
      },
    },
  ],
} as const;

const PROCESS_SNAPSHOT_SCHEMA = {
  type: "object",
  required: [
    "command_id", "command", "cwd", "shell_alive", "status", "exit_code", "started_at", "uptime_ms",
    "restart_count", "auto_restart", "max_restarts", "restart_delay_ms", "last_event", "output_bytes",
    "stdout_bytes", "stderr_bytes", "output_buffer_start", "output_available_bytes", "dropped_bytes",
  ],
  properties: {
    command_id: { type: "string" }, command: { type: "string" }, cwd: { type: "string" },
    pid: { type: "number" }, shell_alive: { type: "boolean" }, status: { type: "string", enum: ["running", "completed"] },
    exit_code: { type: ["number", "null"] }, termination_reason: { type: "string" },
    started_at: { type: "string" }, ended_at: { type: "string" }, uptime_ms: { type: "number" },
    restart_count: { type: "number" }, auto_restart: { type: "boolean" }, max_restarts: { type: "number" },
    restart_delay_ms: { type: "number" }, last_event: { type: "string" }, spawn_error: { type: "string" },
    output_bytes: { type: "number" }, stdout_bytes: { type: "number" }, stderr_bytes: { type: "number" },
    output_buffer_start: { type: "number" }, output_available_bytes: { type: "number" }, dropped_bytes: { type: "number" },
  },
} as const;

const PROCESS_SNAPSHOT_OUTPUT_SCHEMA = {
  oneOf: [
    PROCESS_SNAPSHOT_SCHEMA,
    ARRAY_RESULT_SCHEMA(PROCESS_SNAPSHOT_SCHEMA, "All retained process snapshots, in items when command_id is omitted."),
  ],
} as const;

const SHELL_SESSION_ROW_SCHEMA = {
  type: "object",
  required: ["name", "command_id", "cwd", "alive", "started_at"],
  properties: {
    name: { type: "string" }, command_id: { type: "string" }, cwd: { type: "string" },
    alive: { type: "boolean" }, started_at: { type: "string" },
  },
} as const;

const OPEN_SHELL_OUTPUT_SCHEMA = {
  oneOf: [
    {
      type: "object", description: "The opened or already-open named shell.",
      required: ["name", "command_id", "cwd"],
      properties: {
        name: { type: "string" }, command_id: { type: "string" }, cwd: { type: "string" },
        status: { type: "string" }, shell: { type: "string" }, pid: { type: "number" },
        already_open: { type: "boolean" },
      },
    },
    ARRAY_RESULT_SCHEMA(SHELL_SESSION_ROW_SCHEMA, "Open shell sessions, in items when list is true."),
  ],
} as const;

const SEND_TO_SHELL_OUTPUT_SCHEMA = {
  type: "object", description: "The result of one command in a persistent shell.",
  required: ["name", "command_id", "output", "stdout", "stderr", "exit_code", "timed_out", "status", "shell_alive", "cwd"],
  properties: {
    name: { type: "string" }, command_id: { type: "string" }, output: { type: "string" }, stdout: { type: "string" }, stderr: { type: "string" },
    exit_code: { type: ["number", "null"] }, timed_out: { type: "boolean" }, status: { type: "string", enum: ["completed", "running", "shell_exited"] },
    shell_alive: { type: "boolean" }, cwd: { type: "string" }, output_dropped: { type: "boolean" }, note: { type: "string" },
  },
} as const;

const CLOSE_SHELL_OUTPUT_SCHEMA = {
  oneOf: [
    {
      type: "object", description: "The named shell was closed.", required: ["name", "closed"],
      properties: { name: { type: "string" }, closed: { type: "boolean", enum: [true] } },
    },
    {
      type: "object", description: "There was no shell by that name to close.", required: ["name", "closed", "reason"],
      properties: { name: { type: "string" }, closed: { type: "boolean", enum: [false] }, reason: { type: "string", enum: ["not_open"] } },
    },
  ],
} as const;

const WAIT_PROCESS_OUTPUT_SCHEMA = {
  ...PROCESS_SNAPSHOT_SCHEMA,
  description: "The final process snapshot after waiting, with captured output.",
  required: [...PROCESS_SNAPSHOT_SCHEMA.required, "output", "stdout", "stderr", "truncated"],
  properties: {
    ...PROCESS_SNAPSHOT_SCHEMA.properties,
    output: { type: "string" }, stdout: { type: "string" }, stderr: { type: "string" }, truncated: { type: "boolean" },
  },
} as const;

const WAIT_OUTPUT_SCHEMA = {
  oneOf: [
    {
      type: "object", description: "A fixed-duration wait.", required: ["waited_ms"],
      properties: { waited_ms: { type: "number" } }, not: { required: ["command_id"] },
    },
    { ...WAIT_PROCESS_OUTPUT_SCHEMA, not: { required: ["waited_ms"] } },
  ],
} as const;

const PROCESS_POLICY_OUTPUT_SCHEMA = {
  type: "object", description: "The applied policy for one managed process.",
  required: ["command_id", "auto_restart", "max_restarts", "restart_delay_ms"],
  properties: {
    command_id: { type: "string" }, auto_restart: { type: "boolean" }, max_restarts: { type: "number" }, restart_delay_ms: { type: "number" },
  },
} as const;

const FILE_OP_OUTPUT_SCHEMA = {
  oneOf: [
    {
      type: "object", description: "Directory creation result.", required: ["path", "created"],
      properties: { path: { type: "string" }, created: { type: "boolean" } },
    },
    {
      type: "object", description: "Copy or move result. A same-source move may report unchanged.", required: ["source", "destination"],
      properties: { source: { type: "string" }, destination: { type: "string" }, unchanged: { type: "boolean" } },
    },
    {
      type: "object", description: "File or directory deletion result.", required: ["path", "deleted"],
      properties: { path: { type: "string" }, deleted: { type: "boolean" } },
    },
  ],
} as const;

const PROCESS_CONTROL_OUTPUT_SCHEMA = {
  oneOf: [
    {
      type: "object", description: "A restarted managed process.",
      required: ["command_id", "restarted", "restart_count", "auto_restart"],
      properties: {
        command_id: { type: "string" }, restarted: { type: "boolean" }, restart_count: { type: "number" }, auto_restart: { type: "boolean" },
      },
    },
    {
      ...PROCESS_SNAPSHOT_SCHEMA,
      description: "A terminated managed process, including its final snapshot.",
      required: [...PROCESS_SNAPSHOT_SCHEMA.required, "terminated"],
      properties: { ...PROCESS_SNAPSHOT_SCHEMA.properties, terminated: { type: "boolean" }, already_exited: { type: "boolean" } },
    },
  ],
} as const;

const SERVICE_START_RESULT_SCHEMA = {
  type: "object", description: "A service that has started or was already running.",
  required: ["name", "command_id", "status"],
  properties: {
    name: { type: "string" }, command_id: { type: "string" }, status: { type: "string", enum: ["running", "already_running"] },
  },
  additionalProperties: false,
} as const;

const SERVICE_STOP_RESULT_SCHEMA = {
  type: "object", description: "A single service stop attempt.",
  required: ["name", "command_id", "stopped", "status"],
  properties: {
    name: { type: "string" }, command_id: { type: ["string", "null"] }, stopped: { type: "boolean" },
    status: { type: "string", enum: ["running", "stopped"] }, hint: { type: "string" },
  },
  additionalProperties: false,
} as const;

const SERVICE_RESTART_RESULT_SCHEMA = {
  type: "object", description: "A restarted service.",
  required: ["name", "command_id", "restarted"],
  properties: { name: { type: "string" }, command_id: { type: "string" }, restarted: { type: "boolean" } },
  additionalProperties: false,
} as const;

const SERVICE_DELETE_RESULT_SCHEMA = {
  type: "object", description: "A service definition deletion attempt.",
  required: ["name", "deleted", "stopped"],
  properties: { name: { type: "string" }, deleted: { type: "boolean" }, stopped: { type: "boolean" }, hint: { type: "string" } },
  additionalProperties: false,
} as const;

const SERVICE_BATCH_RESULT_SCHEMA = ARRAY_RESULT_SCHEMA({
  oneOf: [
    SERVICE_START_RESULT_SCHEMA,
    {
      type: "object", description: "A failed service launch in start_all.", required: ["name", "error"],
      properties: { name: { type: "string" }, error: { type: "string" } },
      additionalProperties: false,
    },
    {
      type: "object", description: "A service stop result in stop_all.", required: ["name", "command_id", "stopped"],
      properties: { name: { type: "string" }, command_id: { type: ["string", "null"] }, stopped: { type: "boolean" } },
      additionalProperties: false,
    },
  ],
} as const, "Service action results, in items for start_all or stop_all.");

const SERVICE_OUTPUT_SCHEMA = {
  oneOf: [
    SERVICE_START_RESULT_SCHEMA,
    SERVICE_STOP_RESULT_SCHEMA,
    SERVICE_RESTART_RESULT_SCHEMA,
    SERVICE_DELETE_RESULT_SCHEMA,
    SERVICE_BATCH_RESULT_SCHEMA,
  ],
} as const;

export const TOOL_DEFINITIONS = [
  { name: "list_directory", description: "List files and folders in a workspace directory. Hidden entries need include_hidden=true. A capped listing reports truncated/total/next_offset; offset pages it (depth 1 only).", inputSchema: { type: "object", properties: { path: { type: "string", description: "Directory to list, relative to the workspace unless an allowed absolute path is intended." }, depth: { type: "number", description: "Directory levels to include: 1, 2 or 3; default 1.", enum: [1, 2, 3] }, include_hidden: { type: "boolean", description: "Include hidden entries; false by default.", default: false }, max_entries: { type: "number", description: "Maximum entries to return before reporting truncation." }, offset: { type: "number", description: "Skip this many visible entries (depth 1 only) to page a truncated listing." } } } , outputSchema: { type: "object", required: ["items", "truncated", "total", "next_offset"], properties: { items: { type: "array", items: { type: "object", required: ["name", "type"], properties: { name: { type: "string" }, type: { type: "string", enum: ["file", "directory"] }, children: { type: "array" } } } }, truncated: { type: "boolean", description: "True when max_entries cut the listing short." }, total: { type: ["number", "null"], description: "Entries a flat listing would return; null for depth > 1, where counting the tree is what max_entries avoids." }, next_offset: { type: ["number", "null"], description: "Offset that continues a truncated depth-1 listing; null when there is nothing more." } } } },
  { name: "find_files", description: "Find files by glob (*, **, ?, {a,b}, [abc]); a plain name/prefix matches by basename, \"src/**/*.ts\" by full path. Reports truncated when max_results cut the walk short.", inputSchema: { type: "object", required: ["pattern"], properties: { pattern: { type: "string", description: "Glob to match, such as src/**/*.ts or a plain filename." }, path: { type: "string", description: "Directory or file scope for the search; defaults to the workspace." }, max_results: { type: "number", description: "Maximum matches to return in this page before reporting truncation." }, offset: { type: "number", description: "Absolute result offset; pass next_offset to continue a truncated page." } } } , outputSchema: { type: "object", required: ["items", "truncated", "next_offset"], properties: { items: { type: "array", items: { type: "string" } }, truncated: { type: "boolean", description: "True when more files matched than were returned." }, next_offset: { type: ["number", "null"], description: "Pass as offset to continue; null means this page is final." } } } },
  { name: "search_files", description: "Regex search over workspace files (ripgrep when available); regex=false for literal. include globs limit files; context adds lines; offset+max_results page and a cut page reports truncated.", inputSchema: { type: "object", required: ["query"], properties: { query: { type: "string", description: "Regex pattern to search for, or literal text when regex is false." }, path: { type: "string", description: "File or directory scope for the search; defaults to the workspace." }, max_results: { type: "number", description: "Maximum matches to return in this page before reporting truncation." }, regex: { type: "boolean", description: "Regex by default; false for literal text." }, include: { type: "array", items: { type: "string" }, description: "Glob patterns of files to search, e.g. [\"*.ts\"]." }, offset: { type: "number", description: "Number of matches to skip before collecting (pagination); pair with max_results to page through large result sets." }, context: { type: "number", minimum: 0, maximum: 20, description: "Lines of context to return before/after each match (0-20, default 0)." } } } , outputSchema: { type: "object", required: ["items", "truncated", "next_offset"], properties: { items: { type: "array", items: { type: "object", required: ["path", "line", "text"], properties: { path: { type: "string" }, line: { type: "number" }, text: { type: "string" }, context_before: { type: "array" }, context_after: { type: "array" } } } }, truncated: { type: "boolean", description: "True when more matches exist beyond this page; page with offset." }, next_offset: { type: ["number", "null"], description: "Pass as offset to continue; null means this page is final." } } } },
  { name: "read_files", description: "Read one or more workspace files, optionally a 1-based inclusive start_line/end_line range. sha256 is always present: whole-file digest (pass as expected_sha256), or null if the read stopped early.", inputSchema: { type: "object", required: ["paths"], properties: { paths: { type: "array", description: "One or more file paths to read, in the order their results should be returned.", items: { type: "string" } }, max_bytes: { type: "number", description: "Maximum bytes to read from each requested file." }, start_line: { type: "number", description: "First line to return, 1-based." }, end_line: { type: "number", description: "Last line to return, 1-based; inclusive." }, encoding: { type: "string", enum: ["utf8", "base64"], description: "Set base64 to read binary files; content is returned base64-encoded." } } } , outputSchema: ARRAY_RESULT_SCHEMA(READ_FILE_ROW_SCHEMA, "One entry per requested path, in the order asked. An unreadable path still gets an entry so items always lines up with the request.") },
  { name: "write_file", description: "Create or overwrite a file. Provide content (text) or content_base64 (binary). Pass expected_sha256 from read_files to prevent overwriting a changed file.", inputSchema: { type: "object", required: ["path"], anyOf: [{ required: ["content"] }, { required: ["content_base64"] }], properties: { path: { type: "string", description: "File path to create or update." }, content: { type: "string", description: "Text payload; provide this or content_base64 (both are accepted, with content_base64 taking precedence)." }, content_base64: { type: "string", description: "Base64-encoded binary payload; provide this or content." }, mode: { type: "string", description: "overwrite replaces the file; append adds to its end.", enum: ["overwrite", "append"] }, expected_sha256: { type: "string", description: "Whole-file digest previously returned by read_files; rejects a changed file." } } } , outputSchema: { type: "object", required: ["path", "bytes", "mode", "sha256"], properties: { path: { type: "string" }, bytes: { type: "number" }, mode: { type: "string", enum: ["append", "overwrite"] }, encoding: { type: "string", enum: ["base64"] }, sha256: { type: "string" } } } },
  { name: "edit_block", description: "Replace an exact text block (old_text/new_text), or 1-20 hunks via edits (all-or-nothing). old_text must match exactly once; pass expected_sha256 from read_files. Prefer apply_patch for multi-file.", inputSchema: { type: "object", required: ["path"], oneOf: [{ required: ["old_text"], not: { required: ["edits"] }, description: "One exact replacement; new_text is optional and defaults to deletion." }, { required: ["edits"], not: { anyOf: [{ required: ["old_text"] }, { required: ["new_text"] }] }, description: "One to twenty all-or-nothing replacement hunks." }], properties: { path: { type: "string", description: "File to edit." }, old_text: { type: "string", description: "Exact existing text for the single replacement form." }, new_text: { type: "string", description: "Replacement text for old_text; omit it to delete that block." }, edits: { type: "array", description: "One to twenty all-or-nothing replacement hunks; do not combine with old_text/new_text.", minItems: 1, maxItems: 20, items: { type: "object", required: ["old_text"], properties: { old_text: { type: "string" }, new_text: { type: "string" } } } }, expected_replacements: { type: "number", description: "Expected number of old_text matches; rejects an unexpected count." }, replace_all: { type: "boolean", description: "Replace every matching old_text block instead of requiring one match." }, expected_sha256: { type: "string", description: "Whole-file digest from read_files; rejects a stale edit." } } } , outputSchema: { type: "object", required: ["path", "replacements", "sha256"], properties: { path: { type: "string" }, replacements: { type: "number" }, sha256: { type: "string" }, applied_edits: { type: "number" }, diff: { type: "string" } } } },
  { name: "get_file_info", description: "Read metadata for a file or directory. Includes sha256 for files up to 128 MiB; larger files report sha256 null (the digest would require buffering the whole file into memory).", inputSchema: { type: "object", required: ["path"], properties: { path: { type: "string", description: "File or directory path whose metadata should be read." } } } , outputSchema: { type: "object", required: ["path", "type"], properties: { path: { type: "string" }, type: { type: "string", enum: ["file", "directory"] }, size: { type: "number" }, modified: { type: "string" }, created: { type: "string" }, sha256: { type: ["string", "null"] } } } },
  { name: "file_op", description: "One file-system operation: create_directory, copy, move or delete. copy and move take source/destination (overwrite optional); delete takes recursive.", inputSchema: { type: "object", oneOf: [{ required: ["op", "path"], properties: { op: { enum: ["create_directory"] } }, description: "Create a directory at path." }, { required: ["op", "source", "destination"], properties: { op: { enum: ["copy"] } }, description: "Copy source to destination." }, { required: ["op", "source", "destination"], properties: { op: { enum: ["move"] } }, description: "Move source to destination." }, { required: ["op", "path"], properties: { op: { enum: ["delete"] } }, description: "Delete path; recursive is optional." }], properties: { op: { type: "string", description: "Operation to perform: create_directory, copy, move or delete.", enum: ["create_directory", "copy", "move", "delete"] }, path: { type: "string", description: "Directory to create or path to delete, depending on op." }, source: { type: "string", description: "Existing path to copy or move." }, destination: { type: "string", description: "Target path for copy or move." }, overwrite: { type: "boolean", description: "Allow copy or move to replace an existing destination." }, recursive: { type: "boolean", description: "Allow delete to remove a non-empty directory." } } }, outputSchema: FILE_OP_OUTPUT_SCHEMA },
  { name: "apply_patch", description: "Apply a patch inline (patch) or from a file (patch_file), exactly one. Unified diff updates existing files; ShunCode blocks (Add/Update/Delete File) also create and delete files.", inputSchema: { type: "object", oneOf: [{ required: ["patch"], not: { required: ["patch_file"] }, description: "Apply an inline patch." }, { required: ["patch_file"], not: { required: ["patch"] }, description: "Apply the patch stored at a workspace path." }], properties: { patch: { type: "string", description: "Inline unified diff or ShunCode patch; mutually exclusive with patch_file." }, patch_file: { type: "string", description: "Workspace path to a patch file; mutually exclusive with patch." }, expected_sha256: { type: "object", description: "Object mapping each changed path to the whole-file digest it must still have.", additionalProperties: { type: "string" } } } } , outputSchema: { type: "object", required: ["applied", "files", "changes"], properties: { applied: { type: "boolean", enum: [true] }, files: { type: "array", items: { type: "string" } }, changes: { type: "array", items: { type: "object", required: ["path", "action", "additions", "deletions", "diff"], properties: { path: { type: "string" }, action: { type: "string", enum: ["add", "update", "delete"] }, additions: { type: "number" }, deletions: { type: "number" }, diff: { type: "string" } } } } } } },
  { name: "review_changes", description: "One cumulative git diff since the last review, including edits, shell effects and later commits. Reports the current working tree separately. Needs Git; mark_reviewed (default true) advances baseline.", inputSchema: { type: "object", properties: { since: { type: "string", enum: ["last_shown", "workspace_open"], description: "Diff target: since the last review (default) or since the workspace's first review checkpoint." }, mark_reviewed: { type: "boolean", description: "Advance the review baseline to the current state (default true)." }, max_patch_bytes: { type: "number", description: "Patch size budget in bytes (default 65536; head+tail truncation)." } } } , outputSchema: { oneOf: [{ type: "object", required: ["available", "reason"], properties: { available: { type: "boolean", enum: [false] }, reason: { type: "string" } }, additionalProperties: false }, { type: "object", required: ["available", "review_ref", "since", "checkpoint_action", "summary", "files", "patch", "patch_truncated", "working_tree"], properties: { available: { type: "boolean", enum: [true] }, review_ref: { type: "string" }, since: { type: "string", enum: ["workspace_open", "last_shown"] }, checkpoint_action: { type: "string", enum: ["established", "rebuilt", "advanced", "retained"], description: "What happened to the last-shown checkpoint: established first refs, rebuilt a missing baseline, advanced it, or retained it." }, summary: { type: "object", required: ["files", "additions", "deletions"], properties: { files: { type: "number" }, additions: { type: "number" }, deletions: { type: "number" } } }, files: { type: "array", items: { type: "object" } }, patch: { type: "string" }, patch_truncated: { type: "boolean" }, working_tree: { type: "object", required: ["clean", "summary"], description: "Uncommitted changes in the workspace now, separate from the full checkpoint diff.", properties: { clean: { type: "boolean" }, summary: { type: "object", required: ["files", "additions", "deletions"], properties: { files: { type: "number" }, additions: { type: "number" }, deletions: { type: "number" } } } } }, baseline_advanced: { type: "boolean" }, note: { type: "string" } } }] } },
  { name: "workspace_brief", description: "One-call project orientation: workspace path, top-level layout, manifests, AGENTS.md/CLAUDE.md, git branch and dirty count, recent activity. Call once on an unfamiliar project.", inputSchema: { type: "object", properties: {} } , outputSchema: { type: "object", required: ["workspace", "top_level_entries", "instruction_files", "git", "bridge"], properties: { workspace: { type: "string" }, top_level_entries: { type: "array", items: { type: "object", required: ["name", "type"], properties: { name: { type: "string" }, type: { type: "string", enum: ["file", "directory"] } } } }, manifests: { type: "object" }, instruction_files: { type: "array", items: { type: "string" } }, git: { type: "object", required: ["branch", "dirty_files"], properties: { branch: { type: ["string", "null"] }, dirty_files: { type: ["number", "null"] } } }, bridge: { type: "object", required: ["version", "tool_count", "tool_profile", "active_commands", "recent_activity"], properties: { version: { type: "string" }, tool_count: { type: "number" }, tool_profile: { type: "string" }, active_commands: { type: "number" }, recent_activity: { type: "array", items: { type: "string" } } } }, skills: { type: "object", required: ["count", "names"], properties: { count: { type: "number" }, names: { type: "array", items: { type: "string" } } } } } } },
  { name: "run_command", description: "Run a shell command. For long work use background=true, then follow command_id; do not retry the call. A foreground timeout leaves it running. Check exit_code: non-zero is not a tool failure.", inputSchema: { type: "object", required: ["command"], properties: { command: { type: "string", description: "Shell command text to execute.", minLength: 1 }, cwd: { type: "string", description: "Working directory for the command; defaults to the workspace root." }, background: { type: "boolean", description: "Return immediately with command_id for long or uncertain work; continue with read_process_output, wait or process_control rather than retrying the command." }, timeout_ms: { type: "number", description: "Max milliseconds to wait before returning \"running\"; the process is left alive. Default 120000." }, resource_keys: { type: "array", items: { type: "string" }, maxItems: 16, description: "Optional resource locks held for the whole call, e.g. [\"build:dist\"]. Two calls naming the same key never run at once - use it to stop concurrent runs from fighting over one output directory, port, emulator or database. Omit for ordinary commands." }, env: { type: "object", description: "String environment-variable overrides for this command only.", additionalProperties: { type: "string" } }, strip_ansi: { type: "boolean", description: "Strip ANSI escape sequences (colors, cursor control) from returned output fields. Default true." } } }, outputSchema: RUN_COMMAND_OUTPUT_SCHEMA },
  { name: "start_process", description: "Start a supervised process (server, watcher, daemon). ready_pattern waits for startup output. Without it, ready=true means no check was requested; inspect status/exit_code.", inputSchema: { type: "object", required: ["command"], properties: { command: { type: "string", description: "Shell command for the supervised server, watcher or daemon.", minLength: 1 }, cwd: { type: "string", description: "Working directory for the process; defaults to the workspace root." }, env: { type: "object", description: "String environment-variable overrides for the supervised process.", additionalProperties: { type: "string" } }, ready_pattern: { type: "string", description: "Output pattern that marks startup as ready; omit when no readiness check is needed." }, ready_timeout_ms: { type: "number", description: "How long ready_pattern may take, in ms (default 10000, max 2147483647). On expiry the call returns ready:false and the process keeps running. There is no timeout_ms here: nothing is killed." }, resource_keys: { type: "array", items: { type: "string" }, maxItems: 16, description: "Optional resource locks held for as long as the process runs, e.g. [\"port:5173\"]. Two calls naming the same key never start at once, so a reserved port or output directory cannot be claimed twice." }, strip_ansi: { type: "boolean", description: "Strip ANSI escape sequences (colors, cursor control) from returned output fields. Default true." } } }, outputSchema: SUPERVISED_PROCESS_LAUNCH_OUTPUT_SCHEMA },
  { name: "interact_with_process", description: "Send input to a supervised process and return the output produced after it. Plain non-PTY pipes only; for a full terminal session use open_shell, for output-only reads use read_process_output.", inputSchema: { type: "object", required: ["command_id", "input"], properties: { command_id: { type: "string", description: "Identifier returned when the supervised command was launched." }, input: { type: "string", description: "Text to write to the process standard input." }, append_newline: { type: "boolean", description: "Append a newline after input before sending it." }, wait_ms: { type: "number", description: "Pause after writing, capped at 60000 like read_process_output." }, offset: { type: "number", description: "Absolute read position; omit to read only output produced after this input." }, max_bytes: { type: "number", description: "Maximum captured output bytes to return after the input." }, stream: { type: "string", enum: ["merged", "stdout", "stderr"], description: "Which capture to read; offsets then refer to that stream. Default merged." }, strip_ansi: { type: "boolean", description: "Strip ANSI escape sequences (colors, cursor control) from returned output fields. Default true." } } }, outputSchema: PROCESS_OUTPUT_SCHEMA },
  { name: "open_shell", description: "Open a persistent named shell for interactive/REPL flows (daemons: start_process; one-shots: run_command). list=true returns the open shells instead. Needs bash/sh.", inputSchema: { type: "object", properties: { name: { type: "string", description: "Session name (default 'default')." }, cwd: { type: "string", description: "Initial working directory for the persistent shell; defaults to the workspace root." }, list: { type: "boolean", description: "Return the open shells instead of opening one." } } }, outputSchema: OPEN_SHELL_OUTPUT_SCHEMA },
  { name: "send_to_shell", description: "Run a command in a shell opened with open_shell; cwd/env/venv persist between calls. Waits up to timeout_ms via a sentinel and returns output plus exit code; on timeout the shell stays open.", inputSchema: { type: "object", required: ["command"], properties: { name: { type: "string", description: "Session name (default 'default')." }, command: { type: "string", description: "Command text to run in the named persistent shell.", minLength: 1 }, timeout_ms: { type: "number", description: "Maximum milliseconds to wait for the shell command's completion marker." }, strip_ansi: { type: "boolean", description: "Strip ANSI escape sequences from returned output fields. Default true." } } }, outputSchema: SEND_TO_SHELL_OUTPUT_SCHEMA },
  { name: "close_shell", description: "Close a persistent shell session opened with open_shell.", inputSchema: { type: "object", properties: { name: { type: "string", description: "Name of the persistent shell to close; defaults to default." } } }, outputSchema: CLOSE_SHELL_OUTPUT_SCHEMA },
  { name: "wait", description: "Wait for a fixed number of milliseconds (ms), or for a supervised process to exit (command_id with an optional timeout_ms). Blocks; changes nothing.", inputSchema: { type: "object", anyOf: [{ required: ["ms"] }, { required: ["command_id"] }], properties: { ms: { type: "number", description: "Sleep for this many milliseconds." }, command_id: { type: "string", description: "Wait for this process to exit; takes precedence if ms is also supplied." }, timeout_ms: { type: "number", description: "Maximum wait for command_id; ignored for ms." } } }, outputSchema: WAIT_OUTPUT_SCHEMA },
  { name: "set_process_policy", description: "Enable or disable automatic restart for a managed process.", inputSchema: { type: "object", required: ["command_id"], properties: { command_id: { type: "string", description: "Identifier of the supervised command whose restart policy changes." }, auto_restart: { type: "boolean", description: "Whether a failed supervised command should restart automatically." }, max_restarts: { type: "number", description: "Maximum automatic restart attempts permitted for the command." }, restart_delay_ms: { type: "number", description: "Milliseconds to wait before each automatic restart." } } }, outputSchema: PROCESS_POLICY_OUTPUT_SCHEMA },
  { name: "process_control", description: "Restart or terminate a supervised process by command_id. Restart keeps the original command and cwd; delay_ms applies to restart. terminate is force_terminate.", inputSchema: { type: "object", required: ["action", "command_id"], properties: { action: { type: "string", description: "Lifecycle action to perform on the supervised command.", enum: ["restart", "terminate"] }, command_id: { type: "string", description: "Identifier of the supervised command to control." }, delay_ms: { type: "number", description: "restart only: pause before restarting (default 0)." } } }, outputSchema: PROCESS_CONTROL_OUTPUT_SCHEMA },
  { name: "get_process_snapshot", description: "Read detailed lifecycle information for one or all managed processes.", inputSchema: { type: "object", properties: { command_id: { type: "string", description: "Optional command identifier; omit to snapshot every tracked command." } } }, outputSchema: PROCESS_SNAPSHOT_OUTPUT_SCHEMA },
  { name: "connectivity", description: "Probe a target: port (TCP connect) or http (status, latency, up to 5 redirects, Basic auth from URL userinfo). target is inferred from url/port when omitted.", inputSchema: { type: "object", anyOf: [{ required: ["url"] }, { required: ["port"] }], properties: { target: { type: "string", enum: ["port", "http"], description: "Optional: inferred from url or port when omitted." }, host: { type: "string", description: "Host for a TCP port probe; defaults to the local host." }, port: { type: "number", description: "Required for a TCP probe." }, url: { type: "string", description: "Required for an HTTP probe." }, timeout_ms: { type: "number", description: "Probe timeout in milliseconds." }, max_redirects: { type: "number", description: "Maximum HTTP redirects to follow when target is http." }, scope: { type: "string", description: "Optional request scope used by the HTTP connectivity probe.", enum: ["auto", "local", "public"] } } }, outputSchema: { oneOf: [{ type: "object", required: ["host", "port", "open", "latency_ms"], properties: { host: { type: "string" }, port: { type: "number" }, open: { type: "boolean" }, latency_ms: { type: "number" }, error: { type: "string" } }, additionalProperties: false }, { type: "object", required: ["url", "final_url", "ok", "status", "status_text", "latency_ms", "content_type", "redirects"], properties: { url: { type: "string" }, final_url: { type: "string" }, ok: { type: "boolean" }, status: { type: "number" }, status_text: { type: "string" }, latency_ms: { type: "number" }, content_type: { type: ["string", "null"] }, redirects: { type: "number" }, error: { type: "string" } }, additionalProperties: false }] } },
  { name: "save_service", description: "Save a reusable named process definition in the workspace (project orchestration: named, grouped, supervised daemons reusable across sessions; for ad-hoc long-running tasks use start_process instead).", inputSchema: { type: "object", required: ["name", "command"], properties: { name: { type: "string", description: "Stable name for the saved service definition." }, command: { type: "string", description: "Shell command the saved service will run." }, cwd: { type: "string", description: "Working directory for the service; defaults to the workspace root." }, env: { type: "object", description: "String environment-variable overrides for the service.", additionalProperties: { type: "string" } }, group: { type: "string", description: "Optional group label used to start, stop or list related services." }, port: { type: "number", description: "Optional local TCP port the service is expected to listen on." }, health_url: { type: "string", description: "Optional HTTP URL used to check whether the service is healthy." }, log_file: { type: "string", description: "Optional explicit log file (workspace-relative or absolute); defaults to the extension storage service-logs directory." }, auto_restart: { type: "boolean", description: "Whether the service should restart automatically after an unexpected exit." }, max_restarts: { type: "number", description: "Maximum automatic restart attempts for this service." }, restart_delay_ms: { type: "number", description: "Milliseconds to wait before an automatic service restart." } } } , outputSchema: { type: "object", required: ["name", "saved"], properties: { name: { type: "string" }, saved: { type: "boolean", enum: [true] } } } },
  { name: "service", description: "Start, stop, restart or delete one saved service (name), or start_all/stop_all a group. save_service defines them; service_status reports state.", inputSchema: { type: "object", oneOf: [{ required: ["action", "name"], properties: { action: { enum: ["start"] } }, description: "Start the named service." }, { required: ["action", "name"], properties: { action: { enum: ["stop"] } }, description: "Stop the named service." }, { required: ["action", "name"], properties: { action: { enum: ["restart"] } }, description: "Restart the named service." }, { required: ["action", "name"], properties: { action: { enum: ["delete"] } }, description: "Delete the named service." }, { required: ["action"], properties: { action: { enum: ["start_all"] } }, description: "Start all services, optionally limited to group." }, { required: ["action"], properties: { action: { enum: ["stop_all"] } }, description: "Stop all services, optionally limited to group." }], properties: { action: { type: "string", description: "Service action: start, stop, restart, delete, start_all or stop_all.", enum: ["start", "stop", "restart", "delete", "start_all", "stop_all"] }, name: { type: "string", description: "Saved service name for a single-service action." }, group: { type: "string", description: "Optional group that selects services for a batch action." }, parallel: { type: "boolean", description: "Run a batch start or stop concurrently instead of one service at a time." } } }, outputSchema: SERVICE_OUTPUT_SCHEMA },
  { name: "service_status", description: "Saved services with live state; health checks are bounded by timeout_ms. detail=definitions returns the definitions only, with no probes.", inputSchema: { type: "object", properties: { name: { type: "string", description: "Optional saved service name to inspect." }, group: { type: "string", description: "Optional group label that limits the returned service definitions." }, timeout_ms: { type: "number", description: "Maximum milliseconds for each live health check." }, detail: { type: "string", enum: ["live", "definitions"], description: "definitions = saved definitions only, no health probes." } } }, outputSchema: ARRAY_RESULT_SCHEMA(SERVICE_STATUS_ROW_SCHEMA, "One row per saved service, in items.") },
  { name: "read_process_output", description: "Read paginated output of a supervised command (offset/max_bytes, default 128 KiB a call; stream=stdout|stderr for one stream). wait_ms blocks up to 60000 for new output.", inputSchema: { type: "object", required: ["command_id"], properties: { command_id: { type: "string", description: "Identifier of the supervised command whose output should be read." }, offset: { type: "number", description: "Absolute byte offset in the selected capture; use next_offset to continue." }, max_bytes: { type: "number", description: "Maximum output bytes to return in this page." }, wait_ms: { type: "number", description: "Block up to this many ms waiting for new output when none is buffered yet (default 0 = return immediately)." }, stream: { type: "string", enum: ["merged", "stdout", "stderr"], description: "Which capture to read; offsets then refer to that stream. Default merged." }, strip_ansi: { type: "boolean", description: "Strip ANSI escape sequences (colors, cursor control) from returned output fields. Default true." } } }, outputSchema: PROCESS_OUTPUT_SCHEMA },     { name: "get_config", description: "Read complete Open Bridge runtime configuration; the Bark device key is masked.", inputSchema: { type: "object", properties: {} } , outputSchema: { type: "object", required: ["tunnelProvider", "ngrokDomain", "ngrokExecutable", "sharedPeerRegistry", "tailscaleDomain", "tailscaleExecutable", "shellPath", "shellArgs", "port", "publicHealthTimeoutMs", "unrestrictedFileAccess", "allowedDirectories", "autoReconnect", "ngrokUseHttpProxy", "toolProfile", "logMaxBytes", "auth.enabled", "auth.tokenTtlSeconds", "oauth.enabled", "oauth.allowedRedirectHosts", "concurrency.enabled", "concurrency.holdTimeoutMs", "concurrency.waitTimeoutMs", "notify.enabled", "notify.barkKey", "notify.serverUrl", "sound.enabled", "sound.fileWaiting", "sound.fileFinished"], properties: { tunnelProvider: { type: "string" }, ngrokDomain: { type: "string" }, ngrokExecutable: { type: "string" }, sharedPeerRegistry: { type: "string" }, tailscaleDomain: { type: "string" }, tailscaleExecutable: { type: "string" }, shellPath: { type: "string" }, shellArgs: { type: "array", items: { type: "string" } }, port: { type: "number" }, publicHealthTimeoutMs: { type: "number" }, unrestrictedFileAccess: { type: "boolean" }, allowedDirectories: { type: "array", items: { type: "string" } }, autoReconnect: { type: "boolean" }, ngrokUseHttpProxy: { type: "boolean" }, toolProfile: { type: "string" }, logMaxBytes: { type: "number" }, "auth.enabled": { type: "boolean" }, "auth.tokenTtlSeconds": { type: "number" }, "oauth.enabled": { type: "boolean" }, "oauth.allowedRedirectHosts": { type: "array", items: { type: "string" } }, "concurrency.enabled": { type: "boolean" }, "concurrency.holdTimeoutMs": { type: "number" }, "concurrency.waitTimeoutMs": { type: "number" }, "notify.enabled": { type: "boolean" }, "notify.barkKey": { type: "string" }, "notify.serverUrl": { type: "string" }, "sound.enabled": { type: "boolean" }, "sound.fileWaiting": { type: "string" }, "sound.fileFinished": { type: "string" } } } },
  { name: "bridge_status", description: "Bridge introspection, one section per call: overview (health and counts), auth (bearer tokens), locks (concurrency table), sessions (connected clients).", inputSchema: { type: "object", properties: { section: { type: "string", enum: ["overview", "auth", "locks", "sessions"], description: "Default overview." } } }, outputSchema: { oneOf: [{ type: "object", required: ["state", "workspace_root", "tunnel_role", "shell", "allowed_directories", "active_sessions", "modern_last_used", "modern_in_flight", "active_commands", "tool_profile", "tool_count", "version", "auth_enabled", "exposure", "locks"], properties: { state: { type: "string", enum: ["running", "stopped"] }, workspace_root: { type: "string" }, local_url: { type: "string" }, public_url: { type: "string" }, tunnel_role: { type: "string" }, mcp_url: { type: "string" }, shell: { type: "string" }, allowed_directories: { type: "array", items: { type: "string" } }, active_sessions: { type: "number" }, modern_last_used: { type: ["string", "null"] }, modern_in_flight: { type: "number" }, active_commands: { type: "number" }, tool_profile: { type: "string" }, tool_count: { type: "number" }, version: { type: "string" }, build_stale: { type: "boolean" }, auth_enabled: { type: "boolean" }, exposure: { type: "string", enum: ["local", "public-open", "public-authed"] }, locks: { type: "object", required: ["held", "waiting"], properties: { held: { type: "number" }, waiting: { type: "number" } } } } }, { type: "object", required: ["enabled", "default_ttl_seconds", "token_management", "locked_out_remote_keys", "tokens"], properties: { enabled: { type: "boolean" }, default_ttl_seconds: { type: "number" }, token_management: { type: "string" }, locked_out_remote_keys: { type: "number" }, tokens: { type: "array", items: { type: "object" } } } }, { type: "object", required: ["enabled", "hold_timeout_ms", "wait_timeout_ms", "held", "waiting"], properties: { enabled: { type: "boolean" }, hold_timeout_ms: { type: "number" }, wait_timeout_ms: { type: "number" }, held: { type: "array", items: { type: "object" } }, waiting: { type: "array", items: { type: "object" } } } }, ARRAY_RESULT_SCHEMA({ type: "object", required: ["session_id", "era", "stateless", "closable", "last_used"], properties: { session_id: { type: "string" }, era: { type: "string", enum: ["legacy", "modern"] }, stateless: { type: "boolean" }, closable: { type: "boolean" }, connected_at: { type: ["string", "null"] }, first_seen: { type: "string" }, last_used: { type: "string" }, calls: { type: "number" }, todo_count: { type: "number" }, in_flight: { type: "number" } } }, "Session rows, in items when section is sessions.")] } }, { name: "set_config_value", description: "Change an Open Bridge setting.", inputSchema: { type: "object", required: ["key", "value"], properties: { key: { type: "string", description: "Declared Open Bridge configuration key to change." }, value: { description: "New value in the type required by the selected configuration key.",} } } , outputSchema: { type: "object", required: ["key", "value"], properties: { key: { type: "string" }, value: {} } } },  { name: "get_usage_stats", description: "Read aggregate tool-call statistics.", inputSchema: { type: "object", properties: {} }, outputSchema: { type: "object", required: ["started_at", "uptime_ms", "calls", "successes", "failures", "by_tool", "tracked_commands", "active_commands"], properties: { started_at: { type: "string" }, uptime_ms: { type: "number" }, calls: { type: "number" }, successes: { type: "number" }, failures: { type: "number" }, by_tool: { type: "object", additionalProperties: { type: "number" } }, tracked_commands: { type: "number" }, active_commands: { type: "number" } } } },
  { name: "activity_log", description: "Read or clear the audit log: recent (latest entries), search (by tool/status/text/since, paged), clear (truncate the live log; irreversible).", inputSchema: { type: "object", properties: { action: { type: "string", enum: ["recent", "search", "clear"], description: "Default recent." }, max_results: { type: "number", description: "Maximum recent log entries to return." }, tool: { type: "string", description: "Limit search results to calls of this tool name." }, status: { type: "string", description: "Limit search results to this recorded call status." }, query: { type: "string", description: "Text to search for in audit-log entries." }, since: { type: ["string", "number"], description: "Only entries at or after this moment: an ISO-8601 timestamp (UTC, matching the 'at' field) or epoch milliseconds." }, limit: { type: "number", description: "Maximum search rows to return, from 1 to 500.", minimum: 1, maximum: 500 }, offset: { type: "number", description: "Number of matching audit-log rows to skip for pagination.", minimum: 0 } } }, outputSchema: ACTIVITY_LOG_OUTPUT_SCHEMA },
  { name: "set_todos", description: "Store the complete task list for the current MCP session. Items require id, title and a valid status. Visible via get_todos and the Bridge Console; use report_progress for transient updates.", inputSchema: { type: "object", required: ["todos"], properties: { todos: { type: "array", description: "Complete replacement task list, with at most 100 items containing id, title and status.", maxItems: 100, items: { type: "object", required: ["id", "title", "status"], properties: { id: { type: "string" }, title: { type: "string" }, status: { type: "string", enum: ["pending", "in_progress", "completed"] } }, additionalProperties: false } } } } , outputSchema: ARRAY_RESULT_SCHEMA({ type: "object", required: ["id", "title", "status"], properties: { id: { type: "string" }, title: { type: "string" }, status: { type: "string", enum: ["pending", "in_progress", "completed"] } } }, "Stored todos, in items.") }, { name: "report_progress", description: "Report transient progress (read back as get_todos.last_progress) and push it to the client as an MCP logging notification. phase/category are closed vocabularies: unknown values are dropped.", inputSchema: { type: "object", required: ["message"], properties: { message: { type: "string", description: "Progress message to store and send to the MCP client." }, phase: { type: "string", enum: ["queued", "preparing", "running", "verifying", "done"], description: "Lifecycle stage. A value outside this set is dropped rather than stored." }, category: { type: "string", enum: ["read", "edit", "command", "test", "build", "other"], description: "Coarse kind of work, for a progress badge. A value outside this set is dropped rather than stored." }, percent: { type: "number", description: "Optional percentage or numeric progress value for the update." }, level: { type: "string", description: "Severity of the progress notification.", enum: ["debug", "info", "notice", "warning", "error"] }, todo_id: { type: "string", description: "Todo this progress belongs to; omitted resolves to the single in_progress todo." } } } , outputSchema: { type: "object", required: ["received", "message", "pushed"], properties: { received: { type: "boolean", enum: [true] }, message: { type: "string" }, phase: { type: "string", enum: ["queued", "preparing", "running", "verifying", "done"] }, category: { type: "string", enum: ["read", "edit", "command", "test", "build", "other"] }, percent: { type: "number" }, pushed: { type: "boolean", enum: [true] }, todo_id: { type: "string" } } } },
  { name: "get_todos", description: "Read persisted and session todos plus the last progress entry.", inputSchema: { type: "object", properties: {} }, outputSchema: { type: "object", required: ["session_todos", "persisted_todos", "last_progress", "persisted_at"], properties: { session_todos: { type: "array", items: { type: "object", required: ["id", "title", "status"], properties: { id: { type: "string" }, title: { type: "string" }, status: { type: "string", enum: ["pending", "in_progress", "completed"] } } } }, persisted_todos: { type: "array", items: { type: "object", required: ["id", "title", "status"], properties: { id: { type: "string" }, title: { type: "string" }, status: { type: "string", enum: ["pending", "in_progress", "completed"] } } } }, last_progress: { type: ["object", "null"] }, persisted_at: { type: ["string", "null"] } } } },
  { name: "read_service_log", description: "Read a saved service's persisted log file (service-logs by default; save_service log_file overrides). Logs append across restarts. Omit offset to read the tail; pass offset to page to earlier bytes.", inputSchema: { type: "object", required: ["name"], properties: { name: { type: "string", description: "Saved service whose persisted log should be read." }, offset: { type: "number", description: "Absolute byte offset to start from (0-based). Omit to read the tail." }, max_bytes: { type: "number", description: "Maximum bytes to return (default 131072)." } } }, outputSchema: { type: "object", required: ["name", "log_file", "offset", "next_offset", "output", "output_bytes", "truncated"], properties: { name: { type: "string" }, log_file: { type: "string" }, offset: { type: "number" }, next_offset: { type: "number" }, output: { type: "string" }, output_bytes: { type: "number" }, truncated: { type: "boolean" } } } },
  { name: "batch", description: "Run 1-20 tool calls in one roundtrip: calls: [{tool, arguments}]. mode sequential (default) or parallel; fail_fast stops at the first failure. A failed item returns {ok:false,error}.", inputSchema: { type: "object", required: ["calls"], properties: { calls: { type: "array", description: "One to twenty calls, each with an advertised tool name and optional arguments.", minItems: 1, maxItems: 20, items: { type: "object", required: ["tool"], properties: { tool: { type: "string" }, arguments: { type: "object" } } } }, mode: { type: "string", description: "sequential runs calls in order; parallel starts them together.", enum: ["sequential", "parallel"] }, fail_fast: { type: "boolean", description: "Stop a sequential batch after its first failed call." } } }, outputSchema: { type: "object", required: ["mode", "total", "succeeded", "failed", "stopped_early", "results"], properties: { mode: { type: "string", enum: ["sequential", "parallel"] }, total: { type: "number" }, succeeded: { type: "number" }, failed: { type: "number" }, stopped_early: { type: "boolean" }, results: { type: "array", items: { oneOf: [{ type: "object", required: ["tool", "ok", "result"], properties: { tool: { type: "string" }, ok: { type: "boolean", enum: [true] }, result: {} } }, { type: "object", required: ["tool", "ok", "error"], properties: { tool: { type: "string" }, ok: { type: "boolean", enum: [false] }, error: { type: "string" } } }] } } } } },
  { name: "run_script", description: "Run JavaScript that composes this workspace's tools: await tools.<name>(args), then return what you need. Cuts roundtrips and keeps bulk out of context. Fresh scope per run; no fs or network access.", inputSchema: { type: "object", required: ["source"], properties: { source: { type: "string", description: "JavaScript with top-level await and return; a surrounding Markdown fence is tolerated." }, timeout_ms: { type: "number", description: "Wall-clock budget for the whole run in ms (default 30000, max 300000)." }, max_calls: { type: "number", description: "Cap on tool calls this script may make (default 60, max 200)." } } }, outputSchema: { type: "object", required: ["ok", "calls"], properties: { ok: { type: "boolean" }, result: {}, result_bytes: { type: "number" }, truncated: { type: "boolean" }, calls: { type: "number" }, by_tool: { type: "object" }, duration_ms: { type: "number" }, console: { type: "array", items: { type: "string" } }, phase: { type: "string" }, error: { type: "string" }, error_type: { type: "string" }, tool: { type: "string" }, line: { type: "number" }, code_preview: { type: "array", items: { type: "string" } }, hint: { type: "string" } } } },
  { name: "list_skills", description: "List this workspace's skills (folders holding a SKILL.md). The server instructions carry a connect-time snapshot; call this to refresh after adding one, then read_files the SKILL.md.", inputSchema: { type: "object", properties: {} } , outputSchema: { type: "object", required: ["count", "skills"], properties: { count: { type: "number" }, skills: { type: "array", items: { type: "object", required: ["name", "description", "path"], properties: { name: { type: "string" }, description: { type: "string" }, path: { type: "string" }, dir: { type: "string" }, outside_workspace: { type: "boolean" } } } }, scanned_dirs: { type: "array", items: { type: "string" } }, shadowed: { type: "number" } } } },
  { name: "notify", description: "Send one Bark alert only when the AI is waiting for an answer or a conversation is finished. The Bridge suppresses a second alert until normal work resumes.", inputSchema: { type: "object", required: ["event"], properties: { event: { type: "string", enum: ["waiting", "finished"], description: "Use 'waiting' immediately before, or in the same turn as, a question or choice that blocks further work; use 'finished' once as your final action." }, title: { type: "string", description: "Optional push title; default 'Open Bridge'." }, message: { type: "string", description: "Optional body; a built-in phrase is used when absent or empty." } } }, outputSchema: { type: "object", required: ["delivered", "event", "reason"], properties: { delivered: { type: "boolean", description: "Whether the phone push reached Bark." }, announced: { type: "boolean", description: "Whether Bark or a local sound reached the operator." }, sounded: { type: "boolean", description: "A sound played on the bridge machine." }, event: { type: "string", enum: ["waiting", "finished"] }, reason: { type: "string", description: "\"\" when delivered; otherwise disabled | no_key | duplicate | send_failed." }, status: { type: "number" }, error: { type: "string" } } } },
] as const;
/**
 * Tool names exposed when openBridge.toolProfile is "core". "full" (the default)
 * lists every tool. "core" is the compact everyday set for context-tight clients.
 */
export const CORE_TOOLS: ReadonlySet<string> = new Set([
  "list_directory", "find_files", "search_files", "read_files", "write_file", "edit_block",
  "apply_patch", "get_file_info", "run_command", "start_process", "read_process_output",
  "wait", "process_control", "get_process_snapshot", "connectivity",
  "set_todos", "get_todos", "report_progress", "batch", "run_script",
]);
