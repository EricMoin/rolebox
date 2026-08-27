// Base-64 dictionary: 64 printable chars (A-Z, a-z, 0-9, _, -)
// This gives 64^width combinations: 4096 (w=2), 262144 (w=3), 16777216 (w=4)
export const BASE64_DICT = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";

// Default hash widths by file size thresholds
export const HASH_WIDTH_SMALL = 2;   // files <= 1000 lines → 4096 buckets
export const HASH_WIDTH_MEDIUM = 3;  // files <= 10000 lines → 262K buckets
export const HASH_WIDTH_LARGE = 4;   // files > 10000 lines → 16M buckets

export const SMALL_FILE_THRESHOLD = 1000;
export const MEDIUM_FILE_THRESHOLD = 10000;

// Environment variable override for hash width
export const HASH_WIDTH_ENV_VAR = "ROLEBOX_HASHLINE_WIDTH";

// Regex patterns for parsing line references
// Format: {line_number}#{hash_id} where hash_id is 2-8 chars from BASE64_DICT
// (matches the edit schema's hashWidth bounds, min 2 max 8)
export const HASHLINE_REF_PATTERN = /^(\d+)#([A-Za-z0-9_-]{2,8})$/;

// Pattern to extract a hash ref from arbitrary text (for tolerant parsing)
export const HASHLINE_REF_EXTRACT_PATTERN = /(\d+#[A-Za-z0-9_-]{2,8})/;

// Mismatch context lines (lines before/after a mismatch to show)
export const MISMATCH_CONTEXT = 3;

// Fuzzy search window (lines to search ±N for matching content)
export const FUZZY_SEARCH_WINDOW = 10;
