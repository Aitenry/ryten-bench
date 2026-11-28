import { lazy } from 'react'
import type { ComponentType, LazyExoticComponent } from 'react'
import type { LazyLoader } from '@renderer/plugin-host/types'

/**
 * Lazy route view cache: **the same load factory always maps to the same React.lazy instance**.
 *
 * Why it must be stable (reproduced in production on 2026-09-26 and pinpointed with CDP
 * sampling): while the target route's chunk is not ready, rendering that navigation throws the
 * lazy promise and suspends; under concurrent rendering (react-router v7 navigations default to
 * startTransition) React discards the whole **uncommitted** render (unwind) and retries from the
 * root after the ping. A retry amounts to **remounting** the route view component, so any cache
 * based on `useMemo` or component state is useless:
 *
 *   useMemo(() => lazy(route.load), [route])   // ❌ creates a new lazy + promise on every retry
 *   lazyViewFor(route.load)                    // ✅ same lazy across retries (payload resolved)
 *
 * The former throws a brand-new promise each time, so Suspense can never see an already-resolved
 * payload, resulting in an endless ping → retry → suspend loop: after clicking a menu item the
 * URL (hash) and sidebar highlight change, but the middle view stays on the previous page and
 * the renderer spins at 100% CPU (the sampled stack is always
 * lazyInitializer → resolveLazy → renderRootConcurrent); you have to click a non-lazy route
 * (the home page, which commits directly) and then click the target page before it works.
 */

const cache = new WeakMap<object, LazyExoticComponent<ComponentType>>()

export function lazyViewFor(loader: LazyLoader): LazyExoticComponent<ComponentType> {
  let cached = cache.get(loader)
  if (!cached) {
    cached = lazy(loader)
    cache.set(loader, cached)
  }
  return cached
}
