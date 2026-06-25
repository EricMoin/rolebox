# SDK Session Prompt Behavior Analysis

## Question

Does `session.prompt()` (the blocking variant) actually block until agent completion?

## Answer: YES

**`session.prompt()` blocks until the agent completes and returns the full response.**

## Evidence — Type Definitions

All sources: `node_modules/@opencode-ai/sdk/dist/gen/`

### `session.prompt()` — Blocking Variant

**File:** `sdk.gen.d.ts` line 172-174
```typescript
/**
 * Create and send a new message to a session
 */
prompt<ThrowOnError extends boolean = false>(
  options: Options<SessionPromptData, ThrowOnError>
): RequestResult<SessionPromptResponses, SessionPromptErrors, ThrowOnError, "fields">;
```

**Request data** — `types.gen.d.ts` lines 2244-2269
```typescript
type SessionPromptData = {
  body?: {
    messageID?: string;
    model?: { providerID: string; modelID: string; };
    agent?: string;
    noReply?: boolean;   // <-- if true, returns immediately even for prompt()
    system?: string;
    tools?: { [key: string]: boolean; };
    parts: Array<TextPartInput | FilePartInput | AgentPartInput | SubtaskPartInput>;
  };
  // ...
  url: "/session/{id}/message";  // standard message endpoint
};
```

**Response** — `types.gen.d.ts` lines 2281-2289
```typescript
type SessionPromptResponses = {
  200: {                 // HTTP 200 = complete response body
    info: AssistantMessage;
    parts: Array<Part>;
  };
};
```

### `session.promptAsync()` — Non-Blocking Variant

**File:** `sdk.gen.d.ts` lines 180-182
```typescript
/**
 * Create and send a new message to a session, start if needed and return immediately
 */
promptAsync<ThrowOnError extends boolean = false>(
  options: Options<SessionPromptAsyncData, ThrowOnError>
): RequestResult<SessionPromptAsyncResponses, SessionPromptAsyncErrors, ThrowOnError, "fields">;
```

**Request data** — `types.gen.d.ts` lines 2329-2354
```typescript
type SessionPromptAsyncData = {
  body?: {
    messageID?: string;
    model?: { providerID: string; modelID: string; };
    agent?: string;
    noReply?: boolean;
    system?: string;
    tools?: { [key: string]: boolean; };
    parts: Array<TextPartInput | FilePartInput | AgentPartInput | SubtaskPartInput>;
  };
  // ...
  url: "/session/{id}/prompt_async";  // dedicated async endpoint
};
```

**Response** — `types.gen.d.ts` lines 2366-2372
```typescript
type SessionPromptAsyncResponses = {
  204: void;  // HTTP 204 = No Content, just acknowledgment
};
```

### `RequestResult` (the return type wrapper)

**File:** `gen/client/types.gen.d.ts` lines 68-81

```typescript
type RequestResult<TData, TError, ThrowOnError, TResponseStyle> =
  ThrowOnError extends true
    ? Promise<TResponseStyle extends "data" ? TData[keyof TData] : TData>
    : Promise<{
        data: TData extends Record<string, unknown> ? TData[keyof TData] : TData;
        error: undefined;
      } | {
        data: undefined;
        error: TError extends Record<string, unknown> ? TError[keyof TError] : TError;
      } & {
        request: Request;
        response: Response;
      }>;
```

`RequestResult` is always a **Promise** — it never returns synchronously. When `ThrowOnError` is false (default), the resolved value contains either `{ data, error: undefined }` or `{ data: undefined, error }` plus the raw HTTP `request` and `response` objects.

## Key Differences

| Aspect | `prompt()` | `promptAsync()` |
|--------|-----------|-----------------|
| **JSDoc** | "Create and send a new message to a session" | "Create and send a new message to a session, **start if needed and return immediately**" |
| **URL** | `POST /session/{id}/message` | `POST /session/{id}/prompt_async` |
| **HTTP status** | `200` | `204` |
| **Response body** | `{ info: AssistantMessage, parts: Array<Part> }` | `void` (no body) |
| **Blocks?** | **YES** — waits for agent completion | **NO** — fires and forgets |
| **Return shape** | Full assistant message + parts | Nothing meaningful (`void`) |

## How Blocking Works

1. The SDK issues an HTTP `POST /session/{id}/message` to the opencode server
2. The server processes the prompt synchronously — the agent runs to completion
3. Once done, the server returns HTTP 200 with the complete `{ info: AssistantMessage, parts: Array<Part> }` payload
4. The `RequestResult` Promise resolves with this data

The blocking is HTTP-level: the TCP connection stays open until the server responds.

## The `noReply` Escape Hatch

Both `SessionPromptData` and `SessionPromptAsyncData` have an optional `noReply?: boolean` field.

- **`noReply: false` or unset** (default): `prompt()` returns the full `AssistantMessage` with all parts
- **`noReply: true`**: even the blocking `prompt()` may return a minimal response immediately

This is useful when you just want to inject a message into the session history without waiting for the assistant to respond. The session will still process the message; the caller simply doesn't wait for it.

## Practical Implications

| Scenario | Use |
|----------|-----|
| Need the full agent response (parts, tokens, etc.) | `prompt()` with default settings |
| Fire-and-forget, results come via SSE events | `promptAsync()` |
| Inject a message into history, don't need a reply | `prompt()` with `noReply: true` |

## `agent` Field

Both variants accept `agent?: string` in the request body. This lets you specify which agent (subagent) should handle the prompt. For dispatch use, this is how you route work to a specific subagent.
