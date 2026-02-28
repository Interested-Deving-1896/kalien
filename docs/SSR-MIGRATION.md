# SSR/Prerender Migration Plan for Kalien SEO Metadata

## Summary

Migrate Kalien from pure SPA metadata to hybrid SSR + prerender so route-level <title>, canonical, OG, and Twitter tags are present in initial HTML and do not change after page
load.
Primary scope is SEO-relevant public routes (/, /leaderboard, /leaderboard/:playerAddress, /proofs) while preserving existing Worker APIs and gameplay behavior.

## Goals and Success Criteria

1. Initial HTML response for each public route contains final route-specific metadata with no client-side title swap.
2. Social crawlers receive correct OG/Twitter metadata for route URLs without JS execution.
3. Existing client routing and API endpoints continue to work unchanged.
4. Build and deploy remain Cloudflare-compatible with current wrangler.jsonc model.
5. Lighthouse/URL Inspection confirm route metadata correctness and indexability.

## In Scope

1. Introduce SSR entry pipeline in Vite for HTML shell generation.
2. Prerender stable routes at build time.
3. SSR dynamic public routes on-demand at Worker edge where needed.
4. Centralize metadata generation in one shared module used by SSR and client.
5. Keep client-side metadata hook only as fallback/hydration alignment.

## Out of Scope

1. Full migration to Next.js/Remix/Nuxt.
2. Personalization-specific metadata.
3. Authenticated/private route indexing.
4. API contract changes.

## Architecture Decisions

1. Rendering model: Hybrid.
2. Prerender: /, /leaderboard, /proofs as static HTML at build time.
3. Request-time SSR: /leaderboard/:playerAddress for canonical/profile metadata (fallback to generic metadata on upstream failure).
4. Worker behavior: keep API routes as-is; HTML routes run render path first, then serve assets.
5. Metadata source: one deterministic getRouteMeta(pathname, params) function reused by SSR and CSR.

## Implementation Plan

### Phase 1: SSR foundation

1. Add server entry and client entry split.
2. Add Vite SSR build targets and manifest generation.
3. Render React app to string/stream with route-aware metadata payload.
4. Ensure hydration uses same route metadata to avoid mismatch.

### Phase 2: Metadata centralization

1. Create shared module src/seo/routeMeta.ts.
2. Define route map with title, description, canonical path builder, og/twitter image, robots policy.
3. Replace ad-hoc per-page strings with calls into shared module.
4. Keep existing meta image URL as default global image.

### Phase 3: Prerender static routes

1. Add prerender script to emit HTML for /, /leaderboard, /proofs.
2. Emit route-specific canonical and JSON-LD into each prerendered file.
3. Preserve existing robots.txt and sitemap.xml generation/serving.

### Phase 4: Worker request-time SSR for dynamic route

1. Update Worker fetch handling for HTML navigation requests to:
2. Detect /leaderboard/:playerAddress.
3. Render SSR HTML with metadata on edge.
4. Cache response with short TTL and stale-while-revalidate.
5. Fall back to static shell on render errors with safe generic metadata.

### Phase 5: Routing and deploy wiring

1. Adjust wrangler.jsonc assets/worker-first behavior so HTML routes can hit Worker when needed.
2. Keep /api/* behavior unchanged.
3. Ensure static assets and non-HTML requests bypass SSR for performance.

### Phase 6: Validation and observability

1. Add metadata snapshot tests for route outputs.
2. Add integration checks for canonical/OG/Twitter tags per route.
3. Add smoke checks for bot-like no-JS fetches.
4. Add lightweight logs for SSR render failure rate and latency.

## Public APIs / Interfaces / Types Changes

1. New shared interface:
2. RouteMeta { title: string; description: string; canonicalPath: string; ogType: "website" | "profile"; image: string; robots: string; jsonLd?: object }
3. New function:
4. getRouteMeta(pathname: string): RouteMeta
5. Worker render contract:
6. New internal HTML render handler for navigation routes (no external API changes).
7. Build interface:
8. Add SSR/prerender build scripts in package.json and corresponding entry files.

## Testing Plan

1. Unit:
2. getRouteMeta for all supported routes.
3. Canonical normalization and trailing slash behavior.
4. Integration:
5. Prerendered HTML includes correct <title>, canonical, OG/Twitter tags.
6. SSR route /leaderboard/:address returns route-specific metadata in first byte HTML.
7. No duplicate canonical/meta tags.
8. E2E:
9. Navigate client-side between routes and confirm no visible title flicker.
10. Social-crawler simulation with JS disabled returns expected OG tags.
11. Regression:
12. Existing gameplay route behavior, wallet flow, proofs API, leaderboard API remain unchanged.

## Rollout Plan

1. Stage 1: Land SSR foundation behind feature flag ENABLE_HTML_SSR.
2. Stage 2: Enable prerendered static routes in production.
3. Stage 3: Enable dynamic SSR route /leaderboard/:playerAddress.
4. Stage 4: Observe logs and Search Console for crawl/render changes for 1-2 weeks.
5. Stage 5: Remove legacy client-only metadata fallback logic if metrics stable.

## Risks and Mitigations

1. Risk: Hydration mismatch.
2. Mitigation: Shared metadata module used by both SSR and CSR; snapshot tests.
3. Risk: Worker latency increase.
4. Mitigation: SSR only for selected routes and cache responses.
5. Risk: Config interaction with SPA asset handling.
6. Mitigation: explicit worker-first route rules and canary rollout.
7. Risk: Dynamic route metadata fetch failures.
8. Mitigation: graceful fallback metadata and cached stale response.

## Deliverable Doc to add later

1. docs/ssr-prerender-migration-plan.md containing this plan plus implementation checklist and tracking table.
2. In current Plan Mode I’m not mutating files; this is the exact content to place there when implementation mode is enabled.

## Assumptions and Defaults

1. Domain remains https://kalien.xyz.
2. Existing OG image remains https://pub-b2eaaee2bbe74d70820bacb7298958f5.r2.dev/kalien-meta-2.png.
3. Public SEO priority routes are /, /leaderboard, /leaderboard/:playerAddress, /proofs.
4. No breaking changes to /api/* endpoints.
5. Cloudflare Worker remains deployment runtime.

## Research Basis (official references)

1. Google JavaScript SEO basics: https://developers.google.com/search/docs/crawling-indexing/javascript/javascript-seo-basics
2. Google meta tag guidance: https://developers.google.com/search/docs/crawling-indexing/special-tags
3. Google dynamic rendering position: https://developers.google.com/search/docs/crawling-indexing/javascript/dynamic-rendering
4. Vite SSR and prerender guidance: https://vite.dev/guide/ssr
5. React 19 metadata support: https://react.dev/blog/2024/12/05/react-19
6. Cloudflare SPA routing: https://developers.cloudflare.com/workers/static-assets/routing/single-page-application/
7. Cloudflare HTMLRewriter API: https://developers.cloudflare.com/workers/runtime-apis/html-rewriter/
8. Cloudflare SPA shell pattern: https://developers.cloudflare.com/workers/examples/spa-shell/
9. React Router prerendering patterns: https://reactrouter.com/how-to/pre-rendering
