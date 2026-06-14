import { classifyFailure, recommendAutoFix, createIncidentFromFailure } from './failureClassifier.js'
import { createNotification } from './notifications.js'
import { maybeAutoRecoverFailure } from './autonomousRecovery.js'

function severityRank(s = 'medium') {
  return ({ info: 1, low: 1, success: 1, medium: 2, warning: 2, high: 3, error: 3, critical: 4 })[s] || 2
}

export function routeFailure({ userId = '', source = '', title = '', error = '', entityType = '', entityId = '', data = {}, notify = true, incident = true } = {}) {
  const input = { source, title, error, message: error, details: data, entityId }
  const classification = classifyFailure(input)
  const recommendation = recommendAutoFix(classification)
  let createdIncident = null
  if (incident && severityRank(classification.severity) >= severityRank('high')) {
    try {
      createdIncident = createIncidentFromFailure({ userId, input: { ...input, fingerprint: `${source}-${entityType}-${entityId}-${classification.category}` }, classification })
    } catch { /* best-effort */ }
  }
  let notification = null
  if (notify) {
    try {
      notification = createNotification({
        userId,
        kind: `${entityType || 'system'}_failure`,
        severity: classification.severity,
        title: title || `Failure: ${classification.category}`,
        message: [
          error || classification.category,
          recommendation?.description ? `Recommendation: ${recommendation.description}` : '',
        ].filter(Boolean).join('\n'),
        entityType,
        entityId,
        data: { ...(data || {}), classification, recommendation, incidentId: createdIncident?.id || '' },
      })
    } catch { /* best-effort */ }
  }
  let recovery = null
  try {
    recovery = maybeAutoRecoverFailure({ userId, source, entityType, entityId, input: { ...input, title, error, data }, recommendation })
  } catch { /* best-effort */ }
  return { classification, recommendation, incident: createdIncident, notification, recovery }
}

export default { routeFailure }
