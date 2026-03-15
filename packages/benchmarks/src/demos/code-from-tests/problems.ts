import type { CodeProblem } from "./types.js";

export const MERGE_INTERVALS: CodeProblem = {
	id: "merge-intervals",
	title: "Merge Overlapping Intervals",
	description:
		"Given an array of intervals where intervals[i] = [start, end], merge all overlapping intervals " +
		"and return an array of the non-overlapping intervals that cover all the intervals in the input.",
	signature: "function mergeIntervals(intervals: number[][]): number[][]",
	difficulty: "easy",
	testCount: 8,
	testCode: `// The agent's solution will be prepended above this line

// --- Tests ---
let _passed = 0;
let _failed = 0;
const _total = 8;

function assert(condition: boolean, name: string, details?: string): void {
	if (condition) {
		console.log("PASS: " + name);
		_passed++;
	} else {
		console.log("FAIL: " + name + (details ? ": " + details : ""));
		_failed++;
	}
}

function arraysEqual(a: number[][], b: number[][]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		if (a[i].length !== b[i].length) return false;
		for (let j = 0; j < a[i].length; j++) {
			if (a[i][j] !== b[i][j]) return false;
		}
	}
	return true;
}

// 1. Empty input
const r1 = mergeIntervals([]);
assert(arraysEqual(r1, []), "empty input", "expected [] got " + JSON.stringify(r1));

// 2. Single interval
const r2 = mergeIntervals([[1, 3]]);
assert(arraysEqual(r2, [[1, 3]]), "single interval", "expected [[1,3]] got " + JSON.stringify(r2));

// 3. No overlaps
const r3 = mergeIntervals([[1, 2], [4, 5], [7, 8]]);
assert(arraysEqual(r3, [[1, 2], [4, 5], [7, 8]]), "no overlap", "expected [[1,2],[4,5],[7,8]] got " + JSON.stringify(r3));

// 4. Basic merge
const r4 = mergeIntervals([[1, 3], [2, 6], [8, 10]]);
assert(arraysEqual(r4, [[1, 6], [8, 10]]), "basic merge", "expected [[1,6],[8,10]] got " + JSON.stringify(r4));

// 5. Chain merge (multiple intervals merge into one)
const r5 = mergeIntervals([[1, 4], [2, 5], [3, 6]]);
assert(arraysEqual(r5, [[1, 6]]), "chain merge", "expected [[1,6]] got " + JSON.stringify(r5));

// 6. All overlap into one
const r6 = mergeIntervals([[1, 10], [2, 3], [4, 5], [6, 7]]);
assert(arraysEqual(r6, [[1, 10]]), "all overlap", "expected [[1,10]] got " + JSON.stringify(r6));

// 7. Already sorted, touching boundaries
const r7 = mergeIntervals([[1, 2], [2, 3], [3, 4]]);
assert(arraysEqual(r7, [[1, 4]]), "touching boundaries", "expected [[1,4]] got " + JSON.stringify(r7));

// 8. Unsorted input
const r8 = mergeIntervals([[8, 10], [1, 3], [2, 6], [15, 18]]);
assert(arraysEqual(r8, [[1, 6], [8, 10], [15, 18]]), "unsorted input", "expected [[1,6],[8,10],[15,18]] got " + JSON.stringify(r8));

console.log(_passed + "/" + _total + " tests passed");
`,
};

export const LRU_CACHE: CodeProblem = {
	id: "lru-cache",
	title: "LRU Cache",
	description:
		"Implement a Least Recently Used (LRU) cache with a given capacity. " +
		"It should support get(key) which returns the value or -1 if not found, " +
		"and put(key, value) which inserts or updates the value. When the cache reaches capacity, " +
		"it should evict the least recently used item before inserting. Both operations should be O(1).",
	signature:
		"class LRUCache { constructor(capacity: number); get(key: number): number; put(key: number, value: number): void }",
	difficulty: "medium",
	testCount: 10,
	testCode: `// The agent's solution will be prepended above this line

// --- Tests ---
let _passed = 0;
let _failed = 0;
const _total = 10;

function assert(condition: boolean, name: string, details?: string): void {
	if (condition) {
		console.log("PASS: " + name);
		_passed++;
	} else {
		console.log("FAIL: " + name + (details ? ": " + details : ""));
		_failed++;
	}
}

// 1. Basic put and get
const c1 = new LRUCache(2);
c1.put(1, 10);
assert(c1.get(1) === 10, "basic put/get", "expected 10 got " + c1.get(1));

// 2. Get missing key returns -1
const c2 = new LRUCache(2);
assert(c2.get(99) === -1, "missing key", "expected -1 got " + c2.get(99));

// 3. Capacity eviction
const c3 = new LRUCache(2);
c3.put(1, 1);
c3.put(2, 2);
c3.put(3, 3); // evicts key 1
assert(c3.get(1) === -1, "eviction of LRU", "expected -1 got " + c3.get(1));

// 4. Most recent survives eviction
const c4 = new LRUCache(2);
c4.put(1, 1);
c4.put(2, 2);
c4.put(3, 3); // evicts key 1
assert(c4.get(2) === 2, "recent survives", "expected 2 got " + c4.get(2));

// 5. Update existing key value
const c5 = new LRUCache(2);
c5.put(1, 10);
c5.put(1, 20);
assert(c5.get(1) === 20, "update value", "expected 20 got " + c5.get(1));

// 6. Get refreshes order
const c6 = new LRUCache(2);
c6.put(1, 1);
c6.put(2, 2);
c6.get(1); // refreshes key 1
c6.put(3, 3); // should evict key 2, not key 1
assert(c6.get(2) === -1, "get refreshes (evicted)", "expected -1 got " + c6.get(2));

// 7. Get refreshes order - survivor
const c7 = new LRUCache(2);
c7.put(1, 1);
c7.put(2, 2);
c7.get(1);
c7.put(3, 3);
assert(c7.get(1) === 1, "get refreshes (survivor)", "expected 1 got " + c7.get(1));

// 8. Capacity 1
const c8 = new LRUCache(1);
c8.put(1, 1);
c8.put(2, 2);
assert(c8.get(1) === -1, "capacity 1 eviction", "expected -1 got " + c8.get(1));

// 9. Capacity 1 latest value
const c9 = new LRUCache(1);
c9.put(1, 1);
c9.put(2, 2);
assert(c9.get(2) === 2, "capacity 1 latest", "expected 2 got " + c9.get(2));

// 10. Many operations
const c10 = new LRUCache(3);
for (let i = 0; i < 100; i++) {
	c10.put(i, i * 10);
}
// Only last 3 should survive: 97, 98, 99
const allPresent = c10.get(97) === 970 && c10.get(98) === 980 && c10.get(99) === 990;
const oldEvicted = c10.get(0) === -1 && c10.get(50) === -1;
assert(allPresent && oldEvicted, "many operations", "last 3 should be 970,980,990 and old should be -1");

console.log(_passed + "/" + _total + " tests passed");
`,
};

export const LONGEST_PALINDROME: CodeProblem = {
	id: "longest-palindrome",
	title: "Longest Palindromic Substring",
	description:
		"Given a string s, return the longest palindromic substring in s. " +
		"If there are multiple palindromic substrings of the same maximum length, return any one of them.",
	signature: "function longestPalindrome(s: string): string",
	difficulty: "hard",
	testCount: 12,
	testCode: `// The agent's solution will be prepended above this line

// --- Tests ---
let _passed = 0;
let _failed = 0;
const _total = 12;

function assert(condition: boolean, name: string, details?: string): void {
	if (condition) {
		console.log("PASS: " + name);
		_passed++;
	} else {
		console.log("FAIL: " + name + (details ? ": " + details : ""));
		_failed++;
	}
}

function isPalindrome(s: string): boolean {
	for (let i = 0; i < Math.floor(s.length / 2); i++) {
		if (s[i] !== s[s.length - 1 - i]) return false;
	}
	return true;
}

// 1. Single character
const r1 = longestPalindrome("a");
assert(r1 === "a", "single char", "expected 'a' got '" + r1 + "'");

// 2. Two same characters
const r2 = longestPalindrome("aa");
assert(r2 === "aa", "two same chars", "expected 'aa' got '" + r2 + "'");

// 3. Two different characters
const r3 = longestPalindrome("ab");
assert(r3.length === 1 && (r3 === "a" || r3 === "b"), "two diff chars", "expected 'a' or 'b' got '" + r3 + "'");

// 4. Odd-length palindrome
const r4 = longestPalindrome("babad");
assert(r4.length === 3 && isPalindrome(r4), "odd palindrome", "expected 3-char palindrome got '" + r4 + "'");

// 5. Even-length palindrome
const r5 = longestPalindrome("cbbd");
assert(r5 === "bb", "even palindrome", "expected 'bb' got '" + r5 + "'");

// 6. Entire string is palindrome
const r6 = longestPalindrome("racecar");
assert(r6 === "racecar", "entire string", "expected 'racecar' got '" + r6 + "'");

// 7. Palindrome at the end
const r7 = longestPalindrome("xyzabacaba");
assert(r7 === "abacaba", "palindrome at end", "expected 'abacaba' got '" + r7 + "'");

// 8. Multiple same-length palindromes
const r8 = longestPalindrome("abcddcbaxyzzyx");
const valid8 = (r8 === "abcddcba" || r8 === "xyzzyx") && isPalindrome(r8);
assert(r8.length >= 6 && isPalindrome(r8), "multiple same length", "expected valid palindrome of length >= 6 got '" + r8 + "'");

// 9. All same characters
const r9 = longestPalindrome("aaaaa");
assert(r9 === "aaaaa", "all same chars", "expected 'aaaaa' got '" + r9 + "'");

// 10. No multi-char palindrome
const r10 = longestPalindrome("abcde");
assert(r10.length === 1 && isPalindrome(r10), "no multi-char palindrome", "expected single char got '" + r10 + "'");

// 11. Special characters
const r11 = longestPalindrome("a!b!a");
assert(r11 === "a!b!a", "special chars", "expected 'a!b!a' got '" + r11 + "'");

// 12. Longer string
const r12 = longestPalindrome("forgeeksskeegfor");
assert(r12 === "geeksskeeg", "longer string", "expected 'geeksskeeg' got '" + r12 + "'");

console.log(_passed + "/" + _total + " tests passed");
`,
};

export const CODE_PROBLEMS: CodeProblem[] = [MERGE_INTERVALS, LRU_CACHE, LONGEST_PALINDROME];
