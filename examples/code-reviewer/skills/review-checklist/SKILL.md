---
name: review-checklist
description: Standard code review checklist covering correctness, security, performance, and style
license: MIT
compatibility: opencode
allowed-tools:
  - Read
  - Grep
  - Glob
---

# Code Review Checklist

## Correctness
- Does the code handle edge cases?
- Are there any logic errors?
- Are error paths properly handled?

## Security
- Are inputs validated and sanitized?
- Are there any injection vulnerabilities?
- Are secrets hardcoded?

## Performance
- Are there N+1 query patterns?
- Is memory usage reasonable?
- Are there obvious optimization opportunities?

## Style
- Does the code follow project conventions?
- Are names descriptive?
- Is the code well-structured?
