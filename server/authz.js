export function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' })
  return next()
}

export function requireRole(...roles) {
  const allowed = new Set(roles.map((r) => String(r || '').trim()).filter(Boolean))
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' })
    const role = String(req.user?.role || 'user').trim()
    if (!allowed.has(role)) return res.status(403).json({ error: 'Forbidden' })
    return next()
  }
}

export const requireOwner = requireRole('owner')
export const requireAdmin = requireRole('admin', 'owner')
