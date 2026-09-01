/**
 * @file version.js
 * @description Single source of truth for this shell build's version tag. Bump
 * SHELL_VERSION whenever any cached asset changes (pwa.js, styles.css, index.html, sw.js,
 * this file) — everything that needs the value reads it from here instead of carrying its
 * own hand-copied literal (see .agents/rules/single-source-of-truth-constants.md in
 * day-planner). Loaded two different ways because it's read from two different JS realms:
 *   - sw.js runs in a separate ServiceWorkerGlobalScope, so it pulls this in via
 *     importScripts('./version.js') and derives CACHE_NAME from SHELL_VERSION.
 *   - index.html loads it as a plain classic <script> before pwa.js, which then writes it
 *     into the #shell-version DOM node at runtime — the markup itself carries no literal.
 * Plain top-level `const` (not an ES module export) so both a classic <script> tag and
 * importScripts() can consume it identically — this project has no bundler/build step.
 */
const SHELL_VERSION = 'v21';
