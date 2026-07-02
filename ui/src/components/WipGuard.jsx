/**
 * WipGuard — wraps a component section and shows a WipBanner when
 * the backing endpoints are still stubs or semi-stubs.
 *
 * Props:
 *   paths: string[] — API endpoints this section depends on
 *   isWip: (path: string) => boolean — from useStubStatus
 *   isStub: (path: string) => boolean — from useStubStatus
 *   children: ReactNode — the wrapped component
 *   title: optional WipBanner title
 *   detail: optional WipBanner detail
 *   hideIfAllStub: if true AND all paths are pure stubs, render nothing
 *                  (useful for entirely non-functional panels in non-devtools)
 * */

import WipBanner from './WipBanner.jsx'

export default function WipGuard({
  paths = [],
  isWip,
  isStub,
  children,
  title,
  detail,
  hideIfAllStub = false,
}) {
  if (!paths.length) return children

  const anyWip = paths.some(p => isWip(p))
  const allStub = paths.length > 0 && paths.every(p => isStub(p))
  // If all paths are pure stubs and hideIfAllStub is set, render nothing
  if (allStub && hideIfAllStub) {
    return (
      <div className="rounded-lg border border-white/5 bg-graphite-800/50 px-4 py-8 text-center">
        <span className="text-2xl">🚧</span>
        <p className="mt-2 text-[13px] text-cream-faint">Раздел в разработке</p>
        <p className="mt-1 text-[11px] text-cream-faint/60">Бэкенд-логика ещё не реализована</p>
      </div>
    )
  }

  if (!anyWip) return children

  // Determine the worst level
  const level = allStub ? 'stub' : 'semi'

  return (
    <>
      <WipBanner level={level} title={title} detail={detail} />
      <div className={level === 'stub' ? 'opacity-40 pointer-events-none select-none' : 'opacity-60'}>
        {children}
      </div>
    </>
  )
}
